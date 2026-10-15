import { findSprintField, normalizeIssue, parseToolResult } from "./model.mjs";
import { bounded, classify, JIRA_SERVER, matchesTool, preferred, serverLabel, signInError, SITE_TOOL, toolError } from "./runtime.mjs";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

const READ_TOOLS = new Set([
    "getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql", "executeRead",
    "list_projects", "get_sessions_status", "get_session",
]);
// Atlassian MCP v2 serves most reads only through executeRead; just these operations may pass through it.
const READ_OPERATIONS = new Set(["listJiraProjects", "listJiraStatuses"]);
const FIELDS = ["summary", "description", "status", "issuetype", "project", "parent", "assignee", "priority", "labels", "issuelinks", "updated"];

export async function resolveToolResult(result) {
    try { return parseToolResult(result); }
    catch (error) {
        const text = typeof result === "string" ? result : result?.textResultForLlm || "";
        if (typeof result !== "string" && result?.resultType !== "success") throw error;
        const match = /^Output too large to read at once[^\n]*Saved to: ([^\n]+)\n/.exec(text);
        if (!match) throw error;
        const path = match[1].trim();
        if (!/^\d+-copilot-tool-output-[a-f0-9-]+\.txt$/.test(basename(path))
            || await realpath(dirname(path)) !== await realpath(tmpdir()))
            throw new Error("Runtime output file is not an approved temporary tool result.");
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 5 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid()))
                throw new Error("Runtime output file has an unsupported owner, size or type.");
            return parseToolResult(await file.readFile("utf8"));
        } finally { await file.close(); }
    }
}

const METADATA_TTL_MS = 60_000;
// Rebuilding the tool snapshot costs ~2s; within one startup pass the answer will not change unless MCP does.
const REBUILD_MIN_MS = 4_000;

const TRANSIENT = /re-?authenticat|requires authentication|unauthori[sz]ed|\b401\b|\b429\b|\b50[234]\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|not connected|connection (?:closed|lost|reset)|network error|fetch failed/i;

const AUTH = /re-?authenticat|requires authentication|unauthori[sz]ed|\b401\b/i;
// Observed live: once a server drops to needs-auth, a tool still in the snapshot fails with "Tool '…' does not exist".
const GONE = /\bdoes not exist\b|\bnot found\b/i;
const JIRA_TOOLS = new Set(["getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql", "executeRead"]);
const PAYLOAD_KEYS = ["issues", "values", "resources"];

// Atlassian MCP v2 wraps every result as { data: … }; v1 returned the payload itself.
function unwrap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (!value.data || typeof value.data !== "object" || PAYLOAD_KEYS.some(key => Object.hasOwn(value, key))) return value;
    return value.data;
}

const matching = name => tool => tool.mcpToolName === name || matchesTool(tool.name, name);
const invalid = message => classify(new Error(message), "permanent");
// Host tools are Copilot built-ins; when one is missing, the Atlassian server is never the cause.
const hostToolError = name => classify(toolError(`Copilot did not offer ${name}; update or restart Copilot.`, false), "unavailable");

// Observed live: session.rpc.tools.getCurrentMetadata() can stop answering for minutes while Atlassian waits for
// sign-in, leaving the panel "reconnecting" forever. Every runtime call is bounded and reported as retryable.
const TIMEOUTS_MS = { metadata: 8_000, rebuild: 20_000, list: 5_000, probe: 10_000, execute: 90_000, restart: 30_000, login: 30_000 };

// Stateless, read-only data access to Jira and the Copilot host. It keeps no connection or sign-in state: every
// failure is returned classified (error.kind, error.server, error.retryable) and the Connection decides what it means.
export class Gateway {
    constructor(session, { transientRetries = 2, transientDelayMs = 1500, rebuildMinMs = REBUILD_MIN_MS, shareMs = 1500, timeouts = {} } = {}) {
        this.timeouts = { ...TIMEOUTS_MS, ...timeouts };
        // A runtime call that outlives its timeout is still pending there; reuse it instead of stacking another.
        this.stuck = new Map();
        this.session = session; this.tools = null; this.toolsAt = 0; this.rebuilding = null;
        this.inflight = new Map(); this.recent = new Map(); this.shareMs = shareMs;
        this.transientRetries = transientRetries; this.transientDelayMs = transientDelayMs; this.rebuildMinMs = rebuildMinMs;
        // Servers seen offering Atlassian's site lookup; they stay Jira servers after their tools drop out (sign-in).
        this.jiraKnown = new Set();
        this.owner = null;
        // The Jira server whose read last succeeded: the one actually serving, after any failover.
        this.answered = null;
        // Each site's sprint field ID, learned from Jira's own data; it is site-wide and does not change.
        this.sprintFields = new Map();
    }
    invalidate() { this.toolsAt = 0; this.rebuiltAt = 0; this.recent.clear(); this.owner = null; }
    rpc(key, start, ms, what) {
        let call = this.stuck.get(key);
        if (!call) {
            call = Promise.resolve().then(start);
            this.stuck.set(key, call);
            void call.catch(() => {}).finally(() => { if (this.stuck.get(key) === call) this.stuck.delete(key); });
        }
        return bounded(call, ms, what);
    }
    async metadata({ force = false } = {}) {
        if (!force && this.tools?.length && Date.now() - this.toolsAt < METADATA_TTL_MS) return this.tools;
        const tools = this.session.rpc.tools;
        const snapshot = () => this.rpc("getCurrentMetadata", () => tools.getCurrentMetadata(), this.timeouts.metadata, "its tool list");
        let response;
        try {
            response = force ? null : await snapshot();
            // getCurrentMetadata is a snapshot taken when the tool set was last built. At first open it can hold
            // built-ins only, because MCP servers connect later; only initializeAndValidate rebuilds it.
            if (!response?.tools?.length) {
                if (tools.initializeAndValidate) {
                    this.rebuilding ??= this.rpc("initializeAndValidate", () => tools.initializeAndValidate(), this.timeouts.rebuild, "a tool list rebuild")
                        .finally(() => { this.rebuilding = null; this.rebuiltAt = Date.now(); });
                    await this.rebuilding;
                }
                response = await snapshot();
            }
        } catch (error) {
            // A late answer is better than none: keep working from the last tool list while the runtime catches up.
            if (error.retryable && this.tools?.length) return this.tools;
            throw error;
        }
        this.tools = response?.tools || [];
        this.toolsAt = Date.now();
        for (const tool of this.tools) if (tool.mcpServerName && matching(SITE_TOOL)(tool)) this.jiraKnown.add(tool.mcpServerName);
        return this.tools;
    }
    // The servers that serve Jira: named for Atlassian or Jira, or known to offer Atlassian's site lookup (the app's
    // Atlassian Rovo connector has an opaque name).
    jiraServers(servers) {
        return (servers || []).filter(s => JIRA_SERVER.test(s.name) || JIRA_SERVER.test(s.displayName || "") || this.jiraKnown.has(s.name));
    }
    // The Jira server to read from when several offer Jira's tools, e.g. the atlassian MCP server and the app's
    // connector: the most usable of them. Decided once per tool list; an MCP event or a failed read decides again.
    async serving(tools) {
        if (this.owner?.tools === tools) return this.owner.name;
        const owners = [...new Set(tools.filter(matching(SITE_TOOL)).map(t => t.mcpServerName).filter(Boolean))];
        let name = owners[0] || null;
        if (owners.length > 1) {
            const listed = new Map((await this.servers() || []).map(s => [s.name, s]));
            name = preferred(owners.map(owner => listed.get(owner) || { name: owner })).name;
        }
        if (tools === this.tools) this.owner = { tools, name };
        return name;
    }
    // The tools offering name. A Jira tool comes from the serving Jira server when that server offers it.
    async resolve(tools, name) {
        const matches = tools.filter(matching(name));
        if (matches.length < 2 || !JIRA_TOOLS.has(name)) return matches;
        const owner = await this.serving(tools);
        const own = matches.filter(t => t.mcpServerName === owner);
        return own.length ? own : matches;
    }
    // The MCP server list, or null when the host has none or it did not answer.
    async servers() {
        if (!this.session.rpc.mcp?.list) return null;
        try { return (await this.rpc("mcp.list", () => this.session.rpc.mcp.list(), this.timeouts.list, "the MCP server list"))?.servers || null; }
        catch { return null; }
    }
    // Why a tool is not offered. Pure: reads the server list and changes nothing. Only Jira tools are explained by
    // the Jira servers' state; jiraDown says no Jira server is connected, so the diagnosis beats a raw tool error.
    async diagnose(name) {
        if (!JIRA_TOOLS.has(name)) return hostToolError(name);
        const all = await this.servers();
        // Blame the Jira server when one is configured; an unrelated server needing sign-in is not the cause.
        const jira = this.jiraServers(all);
        const connected = jira.some(s => s.status === "connected");
        const auth = !connected && jira.find(s => s.status === "needs-auth");
        // A Jira server waiting for sign-in is the same call to action as an expired token.
        if (auth) return Object.assign(signInError(auth), { jiraDown: true });
        const servers = jira.length ? jira : (all || []).filter(s => s.status === "pending");
        const names = status => servers.filter(s => s.status === status).map(serverLabel);
        const pending = names("pending"), needsAuth = names("needs-auth");
        const failed = servers.filter(s => s.status === "failed");
        const off = servers.filter(s => ["stopped", "disabled"].includes(s.status));
        const unavailable = (message, retryable, server) => classify(toolError(message, retryable), "unavailable", server ?? jira[0]?.name ?? null);
        const error = pending.length ? unavailable(`${name} is unavailable while MCP servers finish connecting (${pending.join(", ")}). Retrying automatically.`, true, servers.find(s => s.status === "pending").name)
            : needsAuth.length ? unavailable(`${name} is not offered yet: MCP server ${needsAuth.join(", ")} needs sign-in. Authenticate it in Copilot; the Workbench reconnects on its own.`, false, servers.find(s => s.status === "needs-auth").name)
            : failed.length ? unavailable(`${name} is not offered: MCP server ${failed.map(s => serverLabel(s) + (s.error ? ` (${s.error})` : "")).join(", ")} failed to connect. The Workbench restarts it automatically; if it keeps failing, restart it with /mcp in Copilot.`, false, failed[0].name)
            : off.length ? unavailable(`${name} is not offered: MCP server ${off.map(s => `${serverLabel(s)} is ${s.status}`).join(", ")}. Start it in Copilot; the Workbench reconnects on its own.`, false, off[0].name)
            : connected ? unavailable(`${name} is not offered by the connected Atlassian MCP server yet. Retrying automatically.`, true)
            : unavailable(`${name} is unavailable. Connect Atlassian MCP and use Copilot App for session integration.`, all === null);
        error.jiraDown = jira.length > 0 && !connected;
        return error;
    }
    // Identical reads in flight, or answered in the last moment, share one call, so panels opened together
    // cost what one does. Only successes are shared; an MCP event (invalidate) drops them.
    // optional: arguments sent only when the matched tool's input schema declares them (e.g. Atlassian v2's view).
    // retries: transient retries for this call; 0 makes exactly one attempt (e.g. while sign-in is required).
    call(name, args, { fresh = false, optional, retries = this.transientRetries } = {}) {
        if (!READ_TOOLS.has(name) || (name === "executeRead" && !READ_OPERATIONS.has(args?.name)))
            return Promise.reject(invalid(`Jira Workbench is read-only; ${name === "executeRead" ? `executeRead ${args?.name}` : name} is not allowed.`));
        const key = `${name}:${JSON.stringify(args)}${optional ? `:${JSON.stringify(optional)}` : ""}`;
        const recent = this.recent.get(key);
        if (!fresh && recent && Date.now() - recent.at < this.shareMs) return Promise.resolve(recent.value);
        if (!this.inflight.has(key)) {
            const run = this.callOnce(name, args, { optional, retries }).then(value => {
                if (this.shareMs) {
                    for (const [k, entry] of this.recent) if (Date.now() - entry.at >= this.shareMs) this.recent.delete(k);
                    this.recent.set(key, { at: Date.now(), value });
                }
                return value;
            }).finally(() => this.inflight.delete(key));
            this.inflight.set(key, run);
        }
        return this.inflight.get(key);
    }
    async callOnce(name, args, { optional, retries }) {
        const jira = JIRA_TOOLS.has(name);
        const find = tools => this.resolve(tools, name);
        let tools, matches;
        try {
            matches = await find(tools = await this.metadata());
            // MCP servers register after session start; a cached catalog must not hide a newly connected tool.
            if (matches.length !== 1 && (this.rebuilding || Date.now() - (this.rebuiltAt || 0) >= this.rebuildMinMs))
                matches = await find(tools = await this.metadata({ force: true }));
        } catch (error) {
            // A stalled tool list hides the cause; the server list usually still answers (e.g. "needs sign-in").
            if (error.retryable && jira) {
                const diagnosis = await this.diagnose(name);
                if (diagnosis.jiraDown) throw diagnosis;
            }
            throw classify(error, error.retryable ? "transient" : "permanent");
        }
        if (matches.length > 1) throw classify(toolError(`${name} is ambiguous: ${matches.map(t => t.name).join(", ")}. Disable the duplicate Jira MCP server.`, false), "permanent");
        if (!matches.length) throw await this.diagnose(name);
        let tool = matches[0];
        // Another Jira server may serve once this one fails, e.g. the connector dropped and the atlassian server is up.
        const others = jira && tools.filter(matching(name)).length > 1;
        const reroute = async () => {
            if (!others) return false;
            const next = (await find(await this.metadata().catch(() => tools)))[0];
            if (!next || next.name === tool.name) return false;
            tool = next;
            return true;
        };
        for (let attempt = 0; ; attempt++) {
            const server = tool.mcpServerName || (jira ? "atlassian" : null);
            const accepts = tool.input_schema?.properties || {};
            const sent = { ...Object.fromEntries(Object.entries(optional || {}).filter(([key]) => Object.hasOwn(accepts, key))), ...args };
            try {
                const value = await resolveToolResult(await this.rpc(`execute:${tool.name}:${JSON.stringify(sent)}`,
                    () => this.session.rpc.tools.execute({ name: tool.name, arguments: sent }), this.timeouts.execute, `${name}`));
                if (jira && tool.mcpServerName) this.answered = tool.mcpServerName;
                return jira ? unwrap(value) : value;
            } catch (error) {
                const message = error.message || "";
                if (GONE.test(message) && !TRANSIENT.test(message)) {
                    this.invalidate();
                    // A host tool's own "not found" (e.g. a deleted session) is its answer, never Atlassian's fault.
                    if (!jira) throw classify(error, "permanent");
                    if (attempt < retries && await reroute()) continue;
                    const diagnosis = await this.diagnose(name);
                    throw diagnosis.jiraDown ? diagnosis : classify(error, "gone", server);
                }
                const retry = TRANSIENT.test(message);
                // An expired OAuth token or dropped connection fails one call while the runtime refreshes it.
                if (retry && attempt < retries) {
                    this.invalidate();
                    await new Promise(resolve => setTimeout(resolve, this.transientDelayMs * (attempt + 1)));
                    await reroute();
                    continue;
                }
                // A call that outlived its time bound is still running in the runtime; it is not retried, only reported.
                if (!retry && !error.retryable) throw classify(error, "permanent", server);
                // The retries did not ride out a silent token refresh; the Connection asks the server whether sign-in expired.
                if (jira && AUTH.test(message) && (JIRA_SERVER.test(server) || this.jiraKnown.has(server))) throw classify(error, "auth", server);
                // A stale snapshot can still offer a tool whose server has since dropped; say which server and why.
                if (jira) {
                    const diagnosis = await this.diagnose(name);
                    if (diagnosis.jiraDown) throw diagnosis;
                }
                throw classify(error, "transient", server);
            }
        }
    }
    // Whether the current tool list offers a tool (a Jira tool: on the serving Jira server); never throws, so callers
    // can pick between server versions.
    async offers(name) {
        try {
            const tools = await this.metadata();
            const matches = tools.filter(matching(name));
            if (!matches.length || !JIRA_TOOLS.has(name)) return matches.length > 0;
            const owner = await this.serving(tools);
            return !owner || matches.some(t => !t.mcpServerName || t.mcpServerName === owner);
        } catch { return false; }
    }
    async sites(options) {
        const result = await this.call("getAccessibleAtlassianResources", {}, options);
        const list = Array.isArray(result) ? result : result.resources;
        if (!Array.isArray(list)) throw invalid("Jira site discovery returned an unsupported response.");
        // v1 sites carry id, name and OAuth scopes; v2 sites carry cloudId and products, with no name.
        return list.filter(site => (site.id || site.cloudId) && /^https:\/\//.test(site.url)
            && (site.scopes?.some(s => s.includes("jira")) || site.products?.some(p => p.id === "jira")))
            .map(site => {
                const url = new URL(site.url);
                return { id: site.id || site.cloudId, name: site.name || url.hostname.split(".")[0], url: url.origin };
            });
    }
    async projects(cloudId, options) {
        // Atlassian MCP v2 replaced getVisibleJiraProjects with listJiraProjects, reachable only through executeRead.
        const v2 = async () => !(await this.offers("getVisibleJiraProjects")) && await this.offers("executeRead");
        const version = await v2();
        try { return await this.projectPages(version, cloudId, options); }
        catch (error) {
            // The serving server failed mid-read, and another Jira server may speak the other Atlassian version
            // (e.g. a v2 connector and a v1 atlassian server); choose the server, and so the version, again.
            if (error.kind === "permanent") throw error;
            this.owner = null;
            if (await v2() === version) throw error;
            return this.projectPages(!version, cloudId, options);
        }
    }
    async projectPages(v2, cloudId, options) {
        const projects = new Map();
        let startAt = 0;
        for (let page = 0; page < 100; page++) {
            const result = v2
                ? await this.call("executeRead", { name: "listJiraProjects", cloudId, inputs: { action: "browse", maxResults: 50, startAt } }, options)
                : await this.call("getVisibleJiraProjects", { cloudId, action: "browse", expandIssueTypes: false, maxResults: 50, startAt }, options);
            if (!Array.isArray(result.values)) throw invalid("Jira project picker received an unsupported response.");
            for (const project of result.values) projects.set(String(project.id), { id: String(project.id), key: project.key, name: project.name });
            if (result.isLast || (Number.isFinite(result.total) && startAt + result.values.length >= result.total))
                return [...projects.values()];
            if (!result.values.length) throw invalid("Jira project pagination stopped before the last page.");
            startAt += result.values.length;
        }
        throw invalid("Jira project pagination exceeded 100 pages; narrow the accessible project set.");
    }
    // The project's workflow statuses, or null when the serving Atlassian version cannot list them (v1 has no such read).
    async statuses(cloudId, projectId, options) {
        if (!/^\d+$/.test(projectId)) throw invalid("A numeric Jira project ID is required.");
        if (await this.offers("getVisibleJiraProjects") || !(await this.offers("executeRead"))) return null;
        const result = await this.call("executeRead", { name: "listJiraStatuses", cloudId, inputs: { mode: "project", projectKey: projectId } }, options);
        if (!Array.isArray(result?.statuses)) throw invalid("Jira status listing returned an unsupported response.");
        const statuses = new Map();
        for (const status of result.statuses.slice(0, 500)) {
            const name = typeof status?.name === "string" && status.name.length <= 200 ? status.name : "";
            if (name && !statuses.has(name))
                statuses.set(name, { name, category: ["new", "indeterminate", "done"].includes(status.category) ? status.category : "unknown" });
        }
        return [...statuses.values()];
    }
    // Sprint field IDs differ per site. Jira resolves the JQL `sprint` keyword itself, so one issue it matches
    // reveals the field by its sprint-shaped value. No match leaves the project without sprint data.
    async sprintField(cloudId, projectId, options) {
        if (this.sprintFields.has(cloudId)) return this.sprintFields.get(cloudId);
        let result;
        try {
            result = await this.call("searchJiraIssuesUsingJql", {
                cloudId, jql: `project = ${projectId} AND sprint is not EMPTY`, fields: ["*all"], maxResults: 1, responseContentFormat: "markdown",
            }, { ...options, optional: { view: "full" } });
        } catch (error) {
            // Sign-in, outages and retryable faults belong to the Connection, exactly as for the issue read itself.
            if (error.retryable || error.jiraDown || error.needsSignIn || error.kind === "auth") throw error;
            // A site without Jira Software rejects the clause ("Field 'sprint' does not exist"); remember that.
            if (/\bsprint\b/i.test(error.message || "")) this.sprintFields.set(cloudId, null);
            return null;
        }
        const field = findSprintField(Array.isArray(result?.issues) ? result.issues[0] : null);
        if (field) this.sprintFields.set(cloudId, field);
        return field;
    }
    async issues(cloudId, projectId, options) {
        if (!/^\d+$/.test(projectId)) throw invalid("A numeric Jira project ID is required.");
        const sprintField = await this.sprintField(cloudId, projectId, options);
        const issues = new Map(), cursors = new Set();
        let nextPageToken;
        for (let page = 0; page < 100; page++) {
            const args = {
                cloudId, jql: `project = ${projectId} ORDER BY key ASC`,
                fields: sprintField ? [...FIELDS, sprintField] : FIELDS, maxResults: 100, responseContentFormat: "markdown",
            };
            if (nextPageToken) args.nextPageToken = nextPageToken;
            // v2's default "compact" view drops project, parent, description, labels and links even when asked for.
            const result = await this.call("searchJiraIssuesUsingJql", args, { ...options, optional: { view: "full" } });
            if (!Array.isArray(result.issues)) throw invalid("Jira issue search returned an unsupported response.");
            for (const raw of result.issues) {
                const row = normalizeIssue(raw, { sprintField });
                if (row.projectId !== projectId) throw invalid("Jira returned an issue outside the selected project.");
                issues.set(row.id, row);
            }
            if (result.isLast === true || (!result.nextPageToken && result.isLast !== false))
                return { issues: [...issues.values()], fetchedAt: new Date().toISOString() };
            if (!result.nextPageToken || cursors.has(result.nextPageToken)) throw invalid("Jira pagination did not advance; hierarchy is incomplete.");
            cursors.add(result.nextPageToken);
            nextPageToken = result.nextPageToken;
        }
        throw invalid("Jira pagination exceeded 10,000 issues; hierarchy is incomplete.");
    }
}

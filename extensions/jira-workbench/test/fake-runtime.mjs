// A behavioural model of the Copilot runtime as the extension sees it, built from what was observed live:
// - tools.getCurrentMetadata() is a snapshot; it only changes when tools.initializeAndValidate() rebuilds it,
//   and a rebuild takes real time (~1.8s observed; configurable here).
// - an MCP server's tools vanish from the snapshot only after a rebuild; executing a stale tool of a
//   disconnected server fails.
// - an expiring OAuth token fails one call with "Re-authentication required" while the runtime refreshes it
//   silently; no MCP event is emitted.
// - server status changes emit session.mcp_server_status_changed, but the runtime delivers them to extensions
//   late and in batches (12s observed); events: false models an extension that never sees them in time.
// - an expired Atlassian sign-in (signInExpired) fails every call with "Re-authentication required", makes the
//   runtime broadcast an OAuth request each time (counters.oauthRequests) — and mcp.list still says "connected".
//   The passive oauth.probe answers probeWhenExpired: HTTP 401 for v1, and by default 400 for v2, which answers
//   400 for a dead token on login's probe and so cannot be trusted to say 401 here. A working token answers 400.
export const JIRA_TOOLS = ["getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql", "getJiraIssue"];
// Atlassian MCP v2 (https://mcp.atlassian.com/v2/mcp), observed live 2026-10-02: listJiraProjects is reachable only through
// executeRead, every result is wrapped as { data: … }, sites carry cloudId + products, and search's default "compact" view
// drops project, parent, description, labels and links even when they are listed in fields.
export const V2_TOOLS = ["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql", "getJiraIssue", "executeRead"];
export const SITE = { id: "cloud-demo", name: "Demo", url: "https://demo.atlassian.net", scopes: ["read:jira-work"] };
export const V2_SITE = { cloudId: "cloud-demo", url: "https://demo.atlassian.net", products: [{ id: "jira", access: "read-write" }, { id: "confluence", access: "read-write" }] };
// The Copilot app's Atlassian Rovo connector, observed live 2026-10-03 (Copilot 1.0.90): mcp.list shows it as cc-_<id> with
// no displayName or source, and it offers the Atlassian MCP v2 tools as cc-_<id>-<tool>.
export const CONNECTOR = "cc-_rovo";
export const PROJECTS = [{ id: "42", key: "DEMO", name: "Demo project" }, { id: "43", key: "ALT", name: "Other project" }];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function rawIssue(n, projectId = "42") {
    const key = `${projectId === "42" ? "DEMO" : "ALT"}-${n}`;
    const epic = n % 50 === 1;
    return {
        id: `${projectId}${String(n).padStart(6, "0")}`, key, fields: {
            summary: `Summary ${key}`, project: { id: projectId },
            issuetype: { name: epic ? "Epic" : "Story", hierarchyLevel: epic ? 1 : 0 },
            status: { name: "To Do", statusCategory: { key: n % 3 ? "new" : "done" } },
            parent: epic ? undefined : { key: `${projectId === "42" ? "DEMO" : "ALT"}-${Math.floor((n - 1) / 50) * 50 + 1}` },
            labels: [], description: "",
        },
    };
}

// status: the atlassian MCP server's status (null: not configured); connector: the app connector's status (null: none).
export function fakeRuntime({ status = "connected", connector = null, rebuildMs = 0, callMs = 0, issueCount = 3, onRestart, events = true, v2 = false, probeWhenExpired = v2 ? 400 : 401 } = {}) {
    const handlers = new Map();
    const counters = { rebuilds: 0, maxConcurrentRebuilds: 0, executes: 0, jiraExecutes: 0, restarts: 0, list: 0, oauthRequests: 0, probes: 0, logins: 0 };
    let activeRebuilds = 0;
    const runtime = {
        calls: [],
        servers: new Map([...(status ? [["atlassian", status]] : []), ...(connector ? [[CONNECTOR, connector]] : []),
            ["github", "connected"], ["unrelated-sso", "needs-auth"]]),
        snapshot: [],
        tokenExpired: false,
        signInExpired: false,
        // What a user finishing the browser flow looks like: the token works, and (maybe, late) an event arrives.
        completeSignIn({ event = events } = {}) {
            runtime.signInExpired = false;
            if (event) runtime.emit("mcp.oauth_completed", { serverName: "atlassian" });
        },
        permanentError: null,
        // Observed live: getCurrentMetadata stopped answering for minutes. hang() stalls it until release().
        stalled: null,
        hang() { let release; runtime.stalled = { promise: new Promise(resolve => { release = resolve; }), release: () => { runtime.stalled = null; release(); } }; },
        issueCount,
        counters,
        emit(type, data) { for (const handler of handlers.get(type) || []) handler({ type, data }); },
        set(name, next) { runtime.servers.set(name, next); if (events) runtime.emit("session.mcp_server_status_changed", { serverName: name, status: next }); },
        listeners() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
    };
    const builtins = ["list_projects", "list_sessions_and_chats", "get_sessions_status", "get_session"].map(name => ({ name }));
    const searchSchema = v2 => ({ type: "object", properties: Object.fromEntries(
        ["cloudId", "jql", "fields", "maxResults", "nextPageToken", "responseContentFormat", ...(v2 ? ["view"] : [])].map(key => [key, {}])) });
    const toolsOf = (server, v2) => (v2 ? V2_TOOLS : JIRA_TOOLS).map(name => ({ name: `${server}-${name}`, mcpToolName: name, mcpServerName: server,
        ...(name === "searchJiraIssuesUsingJql" ? { input_schema: searchSchema(v2) } : {}) }));
    const jiraTools = toolsOf("atlassian", v2), connectorTools = toolsOf(CONNECTOR, true);
    const v2Of = server => server === CONNECTOR || v2;
    const compact = ({ id, key, fields }) => ({ id, key, fields: {
        summary: fields.summary, status: { name: fields.status.name }, issuetype: { name: fields.issuetype.name } } });
    const search = (args, v2) => {
        const projectId = /project = (\d+)/.exec(args.jql)[1];
        const start = Number(args.nextPageToken || 0), end = Math.min(start + args.maxResults, runtime.issueCount);
        const issues = Array.from({ length: end - start }, (_, i) => rawIssue(start + i + 1, projectId))
            .map(issue => v2 && args.view !== "full" ? compact(issue) : issue);
        return end < runtime.issueCount ? { issues, nextPageToken: String(end), isLast: false } : { issues, isLast: true };
    };
    const jira = (name, args, v2) => {
        if (v2) {
            if (name === "getAccessibleAtlassianResources") return { data: { resources: [V2_SITE] } };
            if (name === "searchJiraIssuesUsingJql") return { data: search(args, v2) };
            if (name === "executeRead" && args.name === "listJiraProjects")
                return { data: { values: PROJECTS, isLast: true, total: PROJECTS.length, startAt: args.inputs?.startAt ?? 0 } };
            throw new Error(`Unexpected Jira v2 tool ${name} ${args?.name || ""}`);
        }
        if (name === "getAccessibleAtlassianResources") return [SITE];
        if (name === "getVisibleJiraProjects") return { values: PROJECTS, isLast: true };
        if (name === "searchJiraIssuesUsingJql") return search(args, v2);
        throw new Error(`Unexpected Jira tool ${name}`);
    };
    const ok = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
    runtime.session = {
        on(type, handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
            return () => handlers.get(type).delete(handler);
        },
        rpc: {
            tools: {
                getCurrentMetadata: async () => {
                    counters.metadata = (counters.metadata || 0) + 1;
                    if (runtime.stalled) await runtime.stalled.promise;
                    return { tools: [...builtins, ...runtime.snapshot] };
                },
                initializeAndValidate: async () => {
                    counters.rebuilds++;
                    counters.maxConcurrentRebuilds = Math.max(counters.maxConcurrentRebuilds, ++activeRebuilds);
                    await delay(rebuildMs);
                    activeRebuilds--;
                    runtime.snapshot = [...(runtime.servers.get("atlassian") === "connected" ? jiraTools : []),
                        ...(runtime.servers.get(CONNECTOR) === "connected" ? connectorTools : [])];
                },
                execute: async ({ name, arguments: args }) => {
                    counters.executes++;
                    if (callMs) await delay(callMs);
                    if (name === "list_projects") return ok([{ id: "copilot-uuid", name: "Demo repository", github_repo: "example/demo" }]);
                    if (name === "get_sessions_status") return ok({ sessions: [] });
                    const tool = [...jiraTools, ...connectorTools].find(t => t.name === name);
                    if (!tool) return { resultType: "failure", error: `Tool ${name} not found` };
                    counters.jiraExecutes++;
                    const server = tool.mcpServerName;
                    // Observed live: a tool left in the snapshot after its server dropped to needs-auth.
                    if (runtime.servers.get(server) === "needs-auth")
                        return { resultType: "failure", error: `Tool '${name}' does not exist.` };
                    if (runtime.servers.get(server) !== "connected")
                        return { resultType: "failure", error: `MCP server '${server}' is not connected` };
                    if (runtime.signInExpired) {
                        counters.oauthRequests++;
                        return { resultType: "failure", error: "MCP server 'atlassian': Re-authentication required for MCP server \"atlassian\". Run /mcp auth atlassian" };
                    }
                    if (runtime.tokenExpired) {
                        runtime.tokenExpired = false;
                        return { resultType: "failure", error: "MCP server 'atlassian': Re-authentication required for MCP server \"atlassian\". Run /mcp auth atlassian" };
                    }
                    if (runtime.permanentError) return { resultType: "failure", error: runtime.permanentError };
                    runtime.calls.push({ name: tool.mcpToolName, args, server });
                    return ok(jira(tool.mcpToolName, args, v2Of(server)));
                },
            },
            mcp: {
                oauth: {
                    probe: async ({ serverName }) => {
                        counters.probes++;
                        if (serverName !== "atlassian") return { status: "failed", error: "not configured" };
                        if (runtime.servers.get("atlassian") === "needs-auth") return { status: "needs-auth" };
                        // Observed live (v1): 401 while expired, but 400 (not "authenticated") once the token works again.
                        const code = runtime.signInExpired ? probeWhenExpired : 400;
                        return code === 401
                            ? { status: "failed", error: "MCP server probe returned HTTP 401 Unauthorized", httpResponse: { status: 401 } }
                            : { status: "failed", error: "MCP server probe returned HTTP 400 Bad Request", httpResponse: { status: 400 } };
                    },
                    login: async ({ serverName, forceReauth }) => {
                        counters.logins++;
                        runtime.lastLogin = { forceReauth: Boolean(forceReauth), serverName };
                        // Observed live with Atlassian v2: login probes with the cached dead token, which v2 answers with 400.
                        if (!forceReauth && runtime.loginProbe400) throw new Error("Request session.mcp.oauth.login failed with message: MCP request failed: MCP server probe returned HTTP 400 Bad Request");
                        // Like the runtime: with a cached (if dead) token and no forceReauth, it believes no browser is needed.
                        if (!forceReauth && runtime.servers.get("atlassian") !== "needs-auth") return {};
                        return { authorizationUrl: "https://auth.atlassian.com/authorize?client_id=fake" };
                    },
                },
                list: async () => { counters.list++; return { servers: [...runtime.servers].map(([name, s]) => ({ name, status: s })) }; },
                restartServer: async ({ serverName }) => {
                    counters.restarts++;
                    runtime.set(serverName, "pending");
                    await delay(1);
                    runtime.set(serverName, onRestart ? onRestart(serverName, counters.restarts) : "connected");
                },
            },
        },
    };
    return runtime;
}

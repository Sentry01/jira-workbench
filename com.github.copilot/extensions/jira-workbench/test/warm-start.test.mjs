import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Cache } from "../lib/cache.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { Connection } from "../lib/connection.mjs";
import { fakeRuntime, SITE } from "./fake-runtime.mjs";

const site = { id: "cloud-demo", name: "Demo", url: "https://demo.atlassian.net" };
const project = { id: "42", key: "DEMO", name: "Demo project" };
const copilot = { id: "copilot-uuid", name: "Demo repository", github_repo: "example/demo" };
const rows = [
    { id: "1", key: "DEMO-1", type: "Epic", level: 1, summary: "Epic", projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "" },
    { id: "2", key: "DEMO-2", type: "Story", level: 0, parentKey: "DEMO-1", summary: "Story", projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "" },
];

async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-warm-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

function services(overrides = {}) {
    const calls = [];
    const gateway = {
        sites: async () => { calls.push("sites"); return [site]; },
        projects: async () => { calls.push("projects"); return overrides.projects || [project]; },
        issues: async () => {
            calls.push("issues");
            if (overrides.issuesError) throw new Error(overrides.issuesError);
            return { issues: rows, fetchedAt: new Date().toISOString() };
        },
        call: async (name, args) => {
            calls.push(name);
            if (name === "list_projects") return [copilot];
            if (name === "get_sessions_status") return { sessions: [] };
            if (name === "get_session") return { id: args.project_session_id, project_id: copilot.id, name: "Work", created_pr_number: 9, created_pr_repo: "example/demo" };
            throw new Error(`Unexpected call ${name}`);
        },
    };
    return { gateway, calls };
}

const github = async (repo, number) => ({ number, url: `https://github.com/${repo}/pull/${number}`, title: "Verified", state: "OPEN", statusCheckRollup: [] });
const make = (path, gateway, options = {}) => new Workbench({
    gateway, store: new Store(path), cache: new Cache(path), github, send: async () => {}, instanceId: "panel", ...options,
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, what, timeoutMs = 3000) {
    const started = Date.now();
    while (!(await predicate())) {
        if (Date.now() - started > timeoutMs) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
        await sleep(5);
    }
    return Date.now() - started;
}
// A panel supervised by a real Connection over the behavioural fake runtime, with timings scaled down.
async function supervised(t, runtime, connectionOptions = {}) {
    // Not directory(t): the panel must stop writing its cache before the folder is removed.
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-warm-"));
    const connection = new Connection(runtime.session, {
        debounceMs: 5, keepaliveMs: 0, restartDelaysMs: [], watchMs: 10, backoffMs: [10, 80], signInReadMs: [10, 80],
        gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0 }, ...connectionOptions,
    }).start();
    const workbench = make(path, connection.gateway);
    connection.attach(workbench);
    t.after(async () => {
        connection.stop();
        workbench.close();
        await workbench.idle();
        await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    });
    const loaded = () => workbench.project?.id === "42" && workbench.issues.length === runtime.issueCount && !workbench.catalogErrors.length && !workbench.error;
    return { connection, workbench, loaded, requested: { cloudId: SITE.id, jiraProjectId: "42" } };
}

test("a new session paints the last project from the shared cache without contacting any source", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const { gateway, calls } = services();
    const next = make(path, gateway);
    assert.equal(await next.hydrate(), true);
    const snapshot = await next.snapshot();
    assert.deepEqual(calls, []);
    assert.equal(snapshot.project.id, project.id);
    assert.equal(snapshot.issues.length, 2);
    assert.equal(snapshot.cached, true);
    assert.equal(snapshot.appProjects[0].id, copilot.id);
});

test("cached Jira data never prepares or launches work until revalidated", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.map({ copilotProjectId: copilot.id });
    await first.idle();

    const next = make(path, services().gateway);
    await next.hydrate();
    await assert.rejects(next.prepare({ nodeId: "2" }), /cached|refreshing/i);
    await next.warm();
    const snapshot = await next.snapshot();
    assert.equal(snapshot.cached, false);
    assert.equal(snapshot.warming, false);
    assert.equal((await next.prepare({ nodeId: "2" })).node.key, "DEMO-2");
});

test("a failed revalidation keeps the cached view visible but stale and blocked", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const next = make(path, services({ issuesError: "Jira timed out" }).gateway);
    await next.hydrate();
    await next.warm();
    const snapshot = await next.snapshot();
    assert.equal(snapshot.issues.length, 2);
    assert.equal(snapshot.stale, true);
    await assert.rejects(next.prepare({ nodeId: "2" }), /stale|refresh/i);
});

test("revalidation drops a restored project the user can no longer browse", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const next = make(path, services({ projects: [{ id: "7", key: "OTHER", name: "Other" }] }).gateway);
    await next.hydrate();
    await next.warm();
    const snapshot = await next.snapshot();
    assert.equal(snapshot.project, null);
    assert.equal(snapshot.issues.length, 0);
    assert.equal((await new Cache(path).read()).lastScope, null);
});

test("an explicitly requested project wins over the cached one", async t => {
    const path = await directory(t);
    const other = { id: "7", key: "OTHER", name: "Other" };
    const first = make(path, services({ projects: [project, other] }).gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const next = make(path, services({ projects: [project, other] }).gateway);
    assert.equal(await next.hydrate({ cloudId: site.id, jiraProjectId: "7" }), true);
    assert.equal((await next.snapshot()).project.id, "7");
    const missing = make(path, services({ projects: [project, other] }).gateway);
    assert.equal(await missing.hydrate({ cloudId: site.id, jiraProjectId: "999" }), false);
    assert.equal((await missing.snapshot()).project, null);
});

test("a corrupt cache is ignored rather than breaking the panel", async t => {
    const path = await directory(t);
    await writeFile(join(path, "cache.json"), "{not json");
    const workbench = make(path, services().gateway);
    assert.equal(await workbench.hydrate(), false);
    assert.equal((await workbench.snapshot()).project, null);
});

test("catalog picks up MCP tools that were still registering at session start on the next recovery pass", async t => {
    const path = await directory(t);
    const { gateway } = services();
    let attempts = 0;
    gateway.sites = async () => {
        if (++attempts < 3) throw new Error("getAccessibleAtlassianResources is unavailable or ambiguous.");
        return [site];
    };
    const workbench = make(path, gateway);
    assert.match((await workbench.catalog()).errors[0], /unavailable/);
    assert.equal(attempts, 1, "one attempt per pass: waiting for the tools is the connection's job");
    await workbench.recover();
    await workbench.recover();
    assert.equal(attempts, 3);
    assert.deepEqual(workbench.catalogErrors, []);
    assert.equal(workbench.recover(), null, "a complete panel has nothing to recover");
    const once = make(path, { ...gateway, sites: async () => { throw new Error("getAccessibleAtlassianResources is unavailable or ambiguous."); } });
    assert.match((await once.catalog()).errors[0], /unavailable/);
});

test("project selection returns after Jira while execution evidence loads in the background", async t => {
    const path = await directory(t);
    const { gateway } = services();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const workbench = make(path, gateway, { github: async (...args) => { await gate; return github(...args); } });
    await workbench.catalog();
    await workbench.select({ cloudId: site.id, jiraProjectId: project.id });
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.idle();

    const pending = workbench.select({ cloudId: site.id, jiraProjectId: project.id });
    const snapshot = await pending;
    assert.equal(snapshot.issues.length, 2);
    assert.equal(snapshot.refreshing, true);
    release();
    await workbench.idle();
    const settled = await workbench.snapshot();
    assert.equal(settled.refreshing, false);
    assert.equal(settled.links["cloud-demo/42/2"].prs[0].number, 9);
});

test("execution refresh verifies linked work concurrently and persists once", async t => {
    const path = await directory(t);
    const { gateway } = services();
    let active = 0, peak = 0;
    const slow = async (...args) => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;
        return github(...args);
    };
    const workbench = make(path, gateway, { github: slow });
    await workbench.catalog();
    await workbench.select({ cloudId: site.id, jiraProjectId: project.id });
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "1", sessionId: "session-1" });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-2" });
    await workbench.idle();

    let writes = 0;
    const update = workbench.store.update.bind(workbench.store);
    workbench.store.update = change => { writes++; return update(change); };
    peak = 0;
    await workbench.refreshExecution();
    assert.equal(writes, 1);
    assert.ok(peak > 1, `expected concurrent GitHub reads, peak was ${peak}`);
    const links = (await workbench.snapshot()).links;
    assert.equal(links["cloud-demo/42/1"].sessions[0].id, "session-1");
    assert.equal(links["cloud-demo/42/2"].sessions[0].id, "session-2");
});

test("session polling with nothing linked neither calls sources nor rewrites state", async t => {
    const path = await directory(t);
    const { gateway, calls } = services();
    const workbench = make(path, gateway);
    await workbench.catalog();
    await workbench.select({ cloudId: site.id, jiraProjectId: project.id });
    await workbench.idle();
    let writes = 0;
    workbench.store.update = async () => { writes++; };
    calls.length = 0;
    await workbench.refreshExecution({ source: "sessions" });
    assert.equal(writes, 0);
    assert.deepEqual(calls, []);
});

test("gateway reuses tool metadata and rebuilds the stale snapshot only when a tool is missing", async () => {
    let reads = 0, rebuilds = 0, connected = false, snapshot = false;
    const session = { rpc: { tools: {
        // Like the runtime: the snapshot only picks up newly connected MCP tools after initializeAndValidate.
        initializeAndValidate: async () => { rebuilds++; snapshot = connected; },
        getCurrentMetadata: async () => {
            reads++;
            return { tools: [{ name: "list_projects" }, ...(snapshot ? [{ name: "atlassian-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources" }] : [])] };
        },
        execute: async () => ({ resultType: "success", textResultForLlm: "[]" }),
    } } };
    const gateway = new Gateway(session);
    await gateway.call("list_projects", {});
    await gateway.call("list_projects", {});
    assert.equal(reads, 1);
    assert.equal(rebuilds, 0);
    await assert.rejects(gateway.call("getAccessibleAtlassianResources", {}), /unavailable/);
    assert.equal(rebuilds, 1);
    await assert.rejects(gateway.call("getAccessibleAtlassianResources", {}), /unavailable/);
    assert.equal(rebuilds, 1, "one startup pass does not pay for a ~2s rebuild on every missing call");
    connected = true;
    gateway.invalidate(); // what an MCP status-change event does
    await gateway.call("getAccessibleAtlassianResources", {});
    assert.equal(rebuilds, 2);
    await gateway.call("getAccessibleAtlassianResources", {});
    assert.equal(rebuilds, 2);
    assert.equal(reads, 4);
});

test("gateway explains why a Jira tool is missing and only retries while MCP is still connecting", async () => {
    let servers;
    const gateway = new Gateway({ rpc: {
        tools: { initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({ tools: [{ name: "list_projects" }] }) },
        mcp: { list: async () => ({ servers }) },
    } });
    const failure = () => gateway.call("getAccessibleAtlassianResources", {}, { fresh: true }).then(() => null, error => error);
    servers = [{ name: "atlassian", status: "pending" }];
    let error = await failure();
    assert.equal(error.retryable, true);
    assert.equal(error.kind, "unavailable");
    assert.match(error.message, /finish connecting \(atlassian\)/);
    servers = [{ name: "atlassian", status: "needs-auth" }];
    error = await failure();
    assert.equal(error.retryable, false);
    assert.equal(error.needsSignIn, true, "a Jira server waiting for sign-in asks for sign-in");
    assert.deepEqual([error.kind, error.server], ["auth", "atlassian"]);
    servers = [{ name: "atlassian", status: "failed", error: "timeout" }];
    error = await failure();
    assert.equal(error.retryable, false);
    assert.match(error.message, /atlassian \(timeout\) failed/);
    assert.deepEqual([error.kind, error.server, error.needsSignIn], ["unavailable", "atlassian", undefined],
        "a later, different failure is reported as itself: the gateway keeps no sign-in state");
    servers = [{ name: "atlassian", status: "stopped" }, { name: "azure", status: "disabled" }];
    error = await failure();
    assert.equal(error.retryable, false);
    assert.match(error.message, /atlassian is stopped\. Start it/);
    assert.doesNotMatch(error.message, /azure/);
    servers = [{ name: "atlassian", status: "stopped" }, { name: "revenue-mcp-server", status: "needs-auth" }];
    error = await failure();
    assert.match(error.message, /atlassian is stopped/);
    assert.doesNotMatch(error.message, /revenue/, "an unrelated server needing sign-in is not blamed");
    servers = [{ name: "atlassian", status: "connected" }];
    error = await failure();
    assert.equal(error.retryable, true, "connected but not yet in the tool snapshot is worth retrying");
    servers = [{ name: "github", status: "connected" }];
    error = await failure();
    assert.equal(error.retryable, false);
    assert.match(error.message, /Connect Atlassian MCP/);

    const duplicate = new Gateway({ rpc: { tools: { getCurrentMetadata: async () => ({ tools: [
        { name: "a-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources" },
        { name: "b-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources" },
    ] }) } } });
    await assert.rejects(duplicate.call("getAccessibleAtlassianResources", {}), /ambiguous: a-getAccessibleAtlassianResources, b-/);
});

test("catalog stops retrying at once when a missing tool will not appear on its own", async t => {
    const path = await directory(t);
    const { gateway } = services();
    let attempts = 0;
    gateway.sites = async () => { attempts++; throw Object.assign(new Error("MCP server atlassian needs sign-in."), { retryable: false }); };
    const result = await make(path, gateway).catalog();
    assert.equal(attempts, 1);
    assert.match(result.errors[0], /needs sign-in/);
});

test("an open panel reconnects once MCP comes up after its startup attempt gave up", async t => {
    const path = await directory(t);
    const { gateway } = services();
    let connected = false;
    gateway.sites = async () => {
        if (!connected) throw Object.assign(new Error("MCP server atlassian needs sign-in."), { retryable: false });
        return [site];
    };
    const workbench = make(path, gateway);
    await workbench.warm({ cloudId: site.id, jiraProjectId: project.id }).catch(() => {});
    assert.equal(workbench.project, undefined);
    assert.match(workbench.catalogErrors[0], /needs sign-in/);

    connected = true;
    // What the connection does when Jira becomes reachable.
    workbench.connectionChanged({ status: { state: "ready" }, previous: { state: "signin" }, event: false });
    await workbench.idle();
    assert.deepEqual(workbench.catalogErrors, []);
    assert.equal(workbench.project?.id, project.id);
    assert.equal(workbench.recover(), null, "a healthy panel does not reconnect");
});

test("opening for a project created after the cache was written fetches a fresh project list", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const created = { id: "7", key: "NEW", name: "New project" };
    const next = make(path, services({ projects: [project, created] }).gateway);
    assert.equal(await next.hydrate({ cloudId: site.id, jiraProjectId: "7" }), false);
    await next.warm({ cloudId: site.id, jiraProjectId: "7" });
    const snapshot = await next.snapshot();
    assert.equal(snapshot.project?.key, "NEW");
    assert.equal(snapshot.backgroundError, null);
});

test("a project picked while the panel is still warming is not overridden by the open request", async t => {
    const path = await directory(t);
    const other = { id: "7", key: "OTHER", name: "Other" };
    const first = make(path, services({ projects: [project, other] }).gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const { gateway } = services({ projects: [project, other] });
    let release;
    const slowSites = new Promise(resolve => { release = resolve; });
    const next = make(path, { ...gateway, sites: async () => { await slowSites; return [site]; } });
    await next.hydrate({ cloudId: site.id, jiraProjectId: "999" });
    const warming = next.warm({ cloudId: site.id, jiraProjectId: "999" });
    const picked = next.select({ cloudId: site.id, jiraProjectId: "7" });
    release();
    await Promise.all([warming, picked]);
    await next.idle();
    assert.equal((await next.snapshot()).project.id, "7");
});

test("revalidation replaces cached site and project details used by launch briefs", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.idle();

    const renamed = { ...project, key: "RENAMED", name: "Renamed project" };
    const moved = { ...site, url: "https://moved.atlassian.net" };
    const { gateway } = services({ projects: [renamed] });
    const next = make(path, { ...gateway, sites: async () => [moved] });
    await next.hydrate();
    assert.equal((await next.snapshot()).project.key, "DEMO");
    await next.warm();
    const snapshot = await next.snapshot();
    assert.equal(snapshot.project.key, "RENAMED");
    assert.equal(snapshot.site.url, "https://moved.atlassian.net");
});

test("preparing work requires the Copilot repository catalog to be confirmed in this session", async t => {
    const path = await directory(t);
    const first = make(path, services().gateway);
    await first.catalog();
    await first.select({ cloudId: site.id, jiraProjectId: project.id });
    await first.map({ copilotProjectId: copilot.id });
    await first.idle();

    const { gateway } = services();
    const next = make(path, { ...gateway, call: async (name, args) => name === "list_projects" ? Promise.reject(new Error("host busy")) : gateway.call(name, args) });
    await next.hydrate();
    await next.warm();
    await assert.rejects(next.prepare({ nodeId: "2" }), /Copilot repository projects are not confirmed/);
});

test("gateway retries a call that fails while the runtime refreshes an expired MCP token", async () => {
    let calls = 0;
    const session = { rpc: { tools: {
        getCurrentMetadata: async () => ({ tools: [{ name: "atlassian-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources" }] }),
        execute: async () => ++calls === 1
            ? { resultType: "failure", error: "MCP server 'atlassian': Re-authentication required for MCP server \"atlassian\". Run /mcp auth atlassian" }
            : { resultType: "success", textResultForLlm: "[]" },
    } } };
    const gateway = new Gateway(session, { transientDelayMs: 1, shareMs: 0 });
    assert.deepEqual(await gateway.call("getAccessibleAtlassianResources", {}), []);
    assert.equal(calls, 2);

    calls = 0;
    session.rpc.tools.execute = async () => { calls++; return { resultType: "failure", error: "Re-authentication required" }; };
    const error = await gateway.call("getAccessibleAtlassianResources", {}).then(() => null, e => e);
    assert.equal(calls, 3, "two retries, then report");
    assert.deepEqual([error.kind, error.server], ["auth", "atlassian"], "re-auth that outlasts the silent-refresh retries is an auth failure");
    calls = 0;
    await assert.rejects(gateway.call("getAccessibleAtlassianResources", {}, { retries: 0 }), /Re-authentication/);
    assert.equal(calls, 1, "retries can be turned off per call");

    // The supervisor reads that as an expired sign-in and stops calling.
    calls = 0;
    const connection = new Connection(session, { gateway });
    const read = () => connection.read(options => gateway.call("getAccessibleAtlassianResources", {}, options));
    const expired = await read().then(() => null, e => e);
    assert.equal(calls, 3);
    assert.equal(expired.needsSignIn, true, "re-auth that outlasts the silent-refresh retries means the sign-in expired");
    await assert.rejects(read(), /sign-in has expired/);
    assert.equal(calls, 3, "no further calls while sign-in is required");
    connection.stop();

    calls = 0;
    session.rpc.tools.execute = async () => { calls++; return { resultType: "failure", error: "JQL syntax error" }; };
    await assert.rejects(gateway.call("getAccessibleAtlassianResources", {}), error => error.kind === "permanent" && /JQL/.test(error.message));
    assert.equal(calls, 1, "permanent failures are not retried");
});

test("a panel heals on its own, without any MCP event, once an auth failure clears", async t => {
    const runtime = fakeRuntime({ events: false });
    runtime.permanentError = "MCP server 'atlassian': Re-authentication required for MCP server \"atlassian\".";
    const { connection, workbench, loaded, requested } = await supervised(t, runtime);
    await workbench.background(() => workbench.warm(requested));
    assert.match(workbench.catalogErrors[0], /Re-authentication|sign-in has expired/);
    runtime.permanentError = null;
    await until(loaded, "the panel to heal");
    assert.deepEqual(workbench.catalogErrors, []);
    assert.equal(workbench.project?.id, "42");
    assert.equal(connection.status().state, "ready");
    assert.equal((await workbench.snapshot()).retryAt, null, "healing stops once healthy");
    const checks = runtime.counters.list + runtime.counters.probes;
    await sleep(40);
    assert.equal(runtime.counters.list + runtime.counters.probes, checks, "and nothing keeps polling");
});

test("a project picked while Jira was unreachable loads when the panel heals", async t => {
    const runtime = fakeRuntime({ events: false });
    runtime.permanentError = "fetch failed";
    const { workbench, loaded, requested } = await supervised(t, runtime);
    await assert.rejects(workbench.select(requested), /site discovery failed/);
    runtime.permanentError = null;
    // Nothing polls the panel here: snapshot() is read-only, and the connection drives the heal.
    await until(loaded, "the picked project to load");
    assert.equal(workbench.project?.id, "42");
    assert.equal((await workbench.snapshot()).issues.length, runtime.issueCount);
});

test("a closed panel stops healing", async t => {
    const runtime = fakeRuntime({ status: "stopped" });
    const { connection, workbench, requested } = await supervised(t, runtime);
    await workbench.background(() => workbench.warm(requested));
    assert.ok(workbench.needsRecovery());
    connection.detach(workbench);
    workbench.close();
    await workbench.idle(); // a pass already running may finish; none may start
    const before = { ...runtime.counters };
    runtime.set("atlassian", "connected");
    await sleep(50);
    await workbench.idle();
    assert.equal(runtime.counters.executes, before.executes);
    assert.equal(runtime.counters.list, before.list);
    assert.equal(workbench.project, undefined);
});

test("an MCP event wakes a startup retry that is backing off", async t => {
    const runtime = fakeRuntime({ status: "pending" });
    // Polling and backoff are a minute apart, so only the event can explain a quick recovery.
    const { workbench, loaded, requested } = await supervised(t, runtime, { watchMs: 60_000, backoffMs: [60_000, 60_000] });
    await workbench.background(() => workbench.warm(requested));
    assert.match(workbench.catalogErrors[0], /finish connecting/);
    const started = Date.now();
    runtime.set("atlassian", "connected");
    await until(loaded, "the event to wake recovery");
    assert.ok(Date.now() - started < 5000, "did not wait out the 60s backoff");
});

test("an expired-token sign-in is not cleared by an unconfirmed 401 while the server still says connected", async () => {
    let failure = "Re-authentication required for MCP server \"atlassian\"", executes = 0;
    const session = { rpc: {
        tools: {
            getCurrentMetadata: async () => ({ tools: [{ name: "atlassian-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources", mcpServerName: "atlassian" }] }),
            execute: async () => { executes++; throw new Error(failure); },
        },
        mcp: { list: async () => ({ servers: [{ name: "atlassian", status: "connected" }] }), oauth: { probe: () => new Promise(() => {}) } },
    } };
    const gateway = new Gateway(session, { transientRetries: 0, timeouts: { probe: 20 } });
    const connection = new Connection(session, { gateway });
    const states = [];
    connection.onChange(change => states.push(change.status.state));
    const read = fresh => connection.read(options => gateway.call("getAccessibleAtlassianResources", {}, options), { fresh });
    await assert.rejects(read(false), /sign-in has expired/);
    failure = "HTTP 401 Unauthorized";
    await assert.rejects(read(true));
    assert.equal(connection.status().state, "signin", "still expired: Jira reads must keep failing fast");
    executes = 0;
    await assert.rejects(read(false), /sign-in has expired/);
    assert.equal(executes, 0);
    assert.deepEqual(states, ["signin"], "the sign-in request was never cleared");
    connection.stop();
});

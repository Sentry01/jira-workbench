import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Cache } from "../lib/cache.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { Connection, RECONNECT_EVENTS } from "../lib/connection.mjs";
import { CONNECTOR, fakeRuntime, SITE } from "./fake-runtime.mjs";

const requested = { cloudId: SITE.id, jiraProjectId: "42" };
// Sharing is off by default so each test's reads really reach the fake server; sharing tests turn it on.
const sharing = { gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 50 } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(t, predicate, { timeoutMs = 3000, what = "condition" } = {}) {
    const started = Date.now();
    while (!(await predicate())) {
        if (Date.now() - started > timeoutMs) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
        await sleep(5);
    }
    return Date.now() - started;
}

// Wires panels exactly like extension.mjs, with timings scaled down ~200x.
const opened = [];
async function harness(t, runtime, { panels = 1, connection: connectionOptions = {}, workbench: workbenchOptions = {} } = {}) {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-connection-"));
    const connection = new Connection(runtime.session, {
        debounceMs: 5, keepaliveMs: 0, restartDelaysMs: [5, 10, 20], watchMs: 10, backoffMs: [10, 80], signInReadMs: [10, 80],
        openUrl: async url => { opened.push(url); },
        gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0 }, ...connectionOptions,
    }).start();
    const workbenches = Array.from({ length: panels }, (_, i) => {
        const workbench = new Workbench({
            gateway: connection.gateway, store: new Store(path), cache: new Cache(path),
            github: async () => { throw new Error("GitHub is not used in these tests"); },
            send: async () => {}, instanceId: `panel-${i}`, ...workbenchOptions,
        });
        connection.attach(workbench);
        return workbench;
    });
    t.after(async () => {
        connection.stop();
        for (const w of workbenches) { w.close(); await w.idle(); }
        await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    });
    const open = (w = workbenches[0], input = requested) => w.background(() => w.warm(input));
    const loaded = w => w.project?.id === "42" && w.issues.length === runtime.issueCount && !w.catalogErrors.length && !w.error && !w.cached;
    return { connection, workbenches, workbench: workbenches[0], open, loaded };
}

test("first open during MCP startup loads the project as soon as the server connects", async t => {
    const runtime = fakeRuntime({ status: "pending", rebuildMs: 3 });
    const { workbench, open, loaded } = await harness(t, runtime);
    open();
    await sleep(30);
    assert.equal(workbench.project, undefined);
    runtime.set("atlassian", "connected");
    const ms = await until(t, () => loaded(workbench), { what: "project to load" });
    // Timers here are 5-10ms; a second still proves no multi-second backoff was waited out, even on a loaded CI box.
    assert.ok(ms < 1500, `took ${ms}ms after connect`);
    assert.equal(runtime.counters.maxConcurrentRebuilds, 1);
});

test("first open with a stale, built-ins-only tool snapshot loads without any event", async t => {
    const runtime = fakeRuntime({ status: "connected" });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    assert.ok(loaded(workbench));
    assert.equal(runtime.counters.rebuilds, 1, "exactly one rebuild picks up the connected server");
});

test("an expired OAuth token is absorbed with no visible error", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.tokenExpired = true;
    await workbench.refresh();
    assert.ok(loaded(workbench));
    runtime.tokenExpired = true;
    await workbench.catalog();
    assert.deepEqual(workbench.catalogErrors, []);
});

test("keepalive refreshes an expiring token before the user touches the panel", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench, open, loaded } = await harness(t, runtime, { connection: { keepaliveMs: 10 } });
    await open();
    runtime.tokenExpired = true;
    await until(t, () => !runtime.tokenExpired && connection.status().state === "ready", { what: "keepalive" });
    assert.ok(loaded(workbench));
    assert.equal(connection.status().reason, null);
});

test("keepalive notices a dead connection and the panel recovers when it returns", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench, open, loaded } = await harness(t, runtime, { connection: { keepaliveMs: 10, restartDelaysMs: [] } });
    await open();
    runtime.servers.set("atlassian", "failed"); // no event: the host missed it
    await until(t, () => connection.status().state === "down", { what: "keepalive to detect the failure" });
    assert.match(connection.status().reason, /not connected|failed/);
    runtime.servers.set("atlassian", "connected");
    await until(t, () => connection.status().state === "ready", { what: "keepalive to see recovery" });
    assert.ok(loaded(workbench), "cached issues were never dropped");
});

test("a Jira server that failed before the panel opened is restarted and the panel loads", async t => {
    const runtime = fakeRuntime({ status: "failed" });
    const { workbench, open, loaded } = await harness(t, runtime);
    open();
    await until(t, () => loaded(workbench), { what: "restart and load" });
    assert.equal(runtime.counters.restarts, 1);
});

test("a server that fails at runtime is restarted and the panel heals without a click", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.set("atlassian", "failed");
    await workbench.refresh().catch(() => {});
    await until(t, () => runtime.counters.restarts === 1 && loaded(workbench), { what: "restart and heal" });
});

test("restarts stop after the budget when the server keeps failing", async t => {
    const runtime = fakeRuntime({ status: "failed", onRestart: () => "failed" });
    const { connection, workbench, open } = await harness(t, runtime);
    open();
    await sleep(250);
    assert.equal(runtime.counters.restarts, 3);
    assert.equal(connection.status().restarts.atlassian, 3);
    assert.match(workbench.catalogErrors[0], /atlassian.*failed to connect/);
    assert.ok((await workbench.snapshot()).retryAt, "the panel keeps healing for the user's own fix");
});

test("a server that flaps between connected and failed cannot restart forever", async t => {
    const runtime = fakeRuntime({ onRestart: () => { setTimeout(() => runtime.set("atlassian", "failed"), 2); return "connected"; } });
    await harness(t, runtime);
    runtime.set("atlassian", "failed");
    await sleep(300);
    assert.equal(runtime.counters.restarts, 3);
});

for (const status of ["stopped", "disabled", "needs-auth"]) {
    test(`a ${status} server is never restarted, is named in the message, and recovers when the user fixes it`, async t => {
        const runtime = fakeRuntime({ status });
        const { workbench, open, loaded } = await harness(t, runtime);
        await open();
        await sleep(40);
        assert.equal(runtime.counters.restarts, 0);
        assert.match(workbench.catalogErrors[0], status === "needs-auth" ? /sign-in has expired\. Press Sign in to Atlassian/ : new RegExp(`atlassian is ${status}`));
        if (status === "needs-auth") assert.deepEqual((await workbench.snapshot()).signIn, { server: "atlassian", connector: false });
        assert.doesNotMatch(workbench.catalogErrors[0], /unrelated-sso/);
        runtime.servers.set("atlassian", "connected");
        runtime.emit(status === "needs-auth" ? "mcp.oauth_completed" : "session.mcp_server_status_changed", { serverName: "atlassian", status: "connected" });
        await until(t, () => loaded(workbench), { what: "recovery after the user's fix" });
    });
}

test("a drop while a project is open keeps the last good data and heals on reconnect", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime, { connection: { restartDelaysMs: [] } });
    await open();
    runtime.set("atlassian", "pending");
    await workbench.refresh();
    assert.match(workbench.error, /not connected|connecting/);
    assert.equal(workbench.issues.length, 3, "last good hierarchy retained");
    const snapshot = await workbench.snapshot();
    assert.equal(snapshot.stale, true);
    assert.ok(snapshot.retryAt || snapshot.warming, "the UI can tell the user a retry is scheduled or running");
    runtime.set("atlassian", "connected");
    await until(t, () => loaded(workbench), { what: "heal after reconnect" });
    // The passing pass may still be finishing; once it has, no retry stays scheduled.
    await until(t, async () => (await workbench.snapshot()).retryAt === null && !workbench.warming, { what: "retry schedule to clear" });
    await sleep(40);
    assert.equal((await workbench.snapshot()).retryAt, null, "a healthy panel does not re-arm a retry");
});

test("a heal restores the project the user picked while Jira was down, not the one the panel opened on", async t => {
    const runtime = fakeRuntime({ status: "stopped" });
    const { workbench, open } = await harness(t, runtime);
    await open();
    await assert.rejects(workbench.select({ cloudId: SITE.id, jiraProjectId: "43" }), /site discovery failed/);
    runtime.set("atlassian", "connected");
    await until(t, () => workbench.project?.id === "43" && !workbench.catalogErrors.length, { what: "picked project" });
});

test("ten panels opening together share one tool rebuild and one read per Jira source", async t => {
    const runtime = fakeRuntime({ rebuildMs: 20, callMs: 5 });
    // Close to the 1.5s production window, so a loaded CI machine still overlaps the ten openings.
    const { workbenches, open, loaded } = await harness(t, runtime, { panels: 10, connection: { gatewayOptions: { ...sharing.gatewayOptions, shareMs: 1000 } } });
    await Promise.all(workbenches.map(w => open(w)));
    assert.ok(workbenches.every(loaded));
    assert.equal(runtime.counters.rebuilds, 1);
    assert.equal(runtime.counters.maxConcurrentRebuilds, 1);
    assert.equal(runtime.counters.jiraExecutes, 3, "sites, projects and one issue page, shared by all ten");
});

test("an event burst triggers one reconnect per panel, not one per event", async t => {
    const runtime = fakeRuntime({ status: "stopped" });
    // No polling: every check below is caused by the burst.
    const { connection, workbench, open } = await harness(t, runtime, { connection: { watchMs: 60_000 } });
    await open();
    await sleep(20);
    let reconnects = 0, checks = 0;
    const original = workbench.recover.bind(workbench);
    workbench.recover = () => { reconnects++; return original(); };
    const invalidate = connection.gateway.invalidate.bind(connection.gateway);
    connection.gateway.invalidate = () => { checks++; invalidate(); };
    for (let i = 0; i < 25; i++) runtime.emit(RECONNECT_EVENTS[i % RECONNECT_EVENTS.length], { serverName: "github", status: "connected" });
    await sleep(40);
    assert.equal(reconnects, 1);
    assert.equal(checks, 1, "one connection check (and one tool-snapshot refresh) for the whole burst");
});

test("stop() and detach release every listener and timer", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench } = await harness(t, runtime, { connection: { keepaliveMs: 10 } });
    assert.equal(runtime.listeners(), RECONNECT_EVENTS.length);
    connection.detach(workbench);
    assert.equal(connection.status().nextCheckAt, null, "nothing is scheduled once no panel is open");
    const calls = runtime.counters.jiraExecutes;
    await sleep(40);
    assert.equal(runtime.counters.jiraExecutes, calls, "no keepalive without an open panel");
    connection.stop();
    assert.equal(runtime.listeners(), 0);
    runtime.set("atlassian", "failed");
    await sleep(30);
    assert.equal(runtime.counters.restarts, 0, "a stopped supervisor does nothing");
});

// Seeded so a failure reproduces exactly.
function random(seed) {
    return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

for (const seed of [1, 7, 42, 1234, 99991]) {
    test(`chaos seed ${seed}: any sequence of MCP states converges once the server is healthy`, async t => {
        const rand = random(seed);
        let healthy = false; // once the world recovers, a restart still in flight must not re-break it
        const runtime = fakeRuntime({ status: "pending", rebuildMs: 2, onRestart: () => (healthy || rand() < 0.5 ? "connected" : "failed") });
        const { workbenches, open, loaded } = await harness(t, runtime, { panels: 3, connection: { keepaliveMs: 15 } });
        workbenches.forEach(w => open(w));
        const states = ["connected", "pending", "failed", "needs-auth", "stopped"];
        const actions = [];
        for (let step = 0; step < 40; step++) {
            const roll = rand();
            if (roll < 0.5) runtime.set("atlassian", states[Math.floor(rand() * states.length)]);
            else if (roll < 0.6) runtime.tokenExpired = true;
            else if (roll < 0.75) runtime.servers.set("atlassian", states[Math.floor(rand() * states.length)]); // silent change
            else {
                const w = workbenches[Math.floor(rand() * workbenches.length)];
                const action = rand() < 0.5 ? w.catalog() : rand() < 0.5 ? w.refresh() : w.select(requested);
                actions.push(Promise.resolve(action).catch(() => {}));
            }
            await sleep(Math.floor(rand() * 10));
        }
        healthy = true;
        runtime.set("atlassian", "connected");
        const describe = () => JSON.stringify(workbenches.map(w => ({ project: w.project?.id, issues: w.issues.length, cached: w.cached,
            catalogErrors: w.catalogErrors, error: w.error, warming: w.warming, passes: w.passes, queued: w.queued,
            requested: w.requested, bg: w.backgroundError, connection: w.connection?.status() })), null, 1);
        await until(t, () => workbenches.every(loaded), { timeoutMs: 5000, what: "every panel to converge" }).catch(error => { console.error("STATE", describe(), JSON.stringify([...runtime.servers], null, 0), JSON.stringify(runtime.counters)); throw error; });
        await Promise.allSettled(actions);
        assert.equal(runtime.counters.maxConcurrentRebuilds, 1, "rebuilds never overlap");
        assert.ok(runtime.counters.restarts <= 3 * 5, `restarts stayed bounded (${runtime.counters.restarts})`);
    });
}

test("a tool left in a stale snapshot after its server dropped reports the server state, not a raw tool error", async t => {
    const runtime = fakeRuntime();
    const { workbench, open } = await harness(t, runtime, { connection: { restartDelaysMs: [] } });
    await open();
    runtime.servers.set("atlassian", "failed"); // tools are still in the snapshot
    await workbench.refresh();
    assert.match(workbench.error, /MCP server atlassian failed to connect\. The Workbench restarts it automatically/);
    assert.doesNotMatch(workbench.error, /Tool failed/);
});

test("a recovery that lands during a doomed reconnect pass is picked up as soon as that pass ends", async t => {
    const runtime = fakeRuntime({ status: "stopped", rebuildMs: 60 });
    const { connection, workbench, open, loaded } = await harness(t, runtime, { connection: { watchMs: 2000 } });
    await open();
    connection.gateway.invalidate(); // as an MCP event does
    workbench.recover(); // a pass starts against the stopped server and pays a 60ms rebuild
    await sleep(10);
    assert.equal(workbench.warming, true);
    const started = Date.now();
    runtime.set("atlassian", "connected");
    await until(t, () => loaded(workbench), { what: "load after the in-flight pass" });
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms; a 2s poll would exceed this`);
});

test("recovers within about a second when MCP events arrive late or never", async t => {
    const runtime = fakeRuntime({ status: "stopped", events: false });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    assert.ok(workbench.needsRecovery());
    runtime.set("atlassian", "connected"); // no event is delivered
    const ms = await until(t, () => loaded(workbench), { timeoutMs: 3000, what: "recovery from polling mcp.list" });
    assert.ok(ms < 1000, `took ${ms}ms with a 10ms watch`);
    const polls = runtime.counters.list;
    await sleep(60);
    assert.ok(runtime.counters.list - polls <= 1, "the watch stops once every panel is healthy");
});

test("a server that fails silently is restarted from the watch alone", async t => {
    const runtime = fakeRuntime({ events: false });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.servers.set("atlassian", "failed");
    await workbench.refresh();
    assert.match(workbench.error, /failed to connect/);
    await until(t, () => runtime.counters.restarts === 1 && loaded(workbench), { what: "restart and heal without events" });
});

test("a recovery that happened before the watch first looked is still picked up", async t => {
    const runtime = fakeRuntime({ status: "stopped", events: false });
    const { workbench, open, loaded } = await harness(t, runtime, { connection: { watchMs: 40 } });
    await open();
    runtime.servers.set("atlassian", "connected"); // before the first watch tick
    await until(t, () => loaded(workbench), { timeoutMs: 3000, what: "recovery seen on the first tick" });
});

test("concurrent identical reads share one call; different reads do not", async t => {
    const runtime = fakeRuntime({ callMs: 10 });
    const { connection } = await harness(t, runtime, { connection: sharing });
    const gateway = connection.gateway;
    await gateway.metadata({ force: true });
    const [a, b] = await Promise.all([gateway.call("getAccessibleAtlassianResources", {}), gateway.call("getAccessibleAtlassianResources", {})]);
    assert.equal(a, b);
    assert.equal(runtime.counters.jiraExecutes, 1);
    await gateway.call("getAccessibleAtlassianResources", {});
    assert.equal(runtime.counters.jiraExecutes, 1, "a read moments later is shared too");
    gateway.invalidate();
    await gateway.call("getAccessibleAtlassianResources", {});
    assert.equal(runtime.counters.jiraExecutes, 2, "after an MCP change the next read is fresh");
    await Promise.all([gateway.call("getVisibleJiraProjects", { cloudId: "a" }), gateway.call("getVisibleJiraProjects", { cloudId: "b" })]);
    assert.equal(runtime.counters.jiraExecutes, 4);
    await sleep(60);
    await gateway.call("getAccessibleAtlassianResources", {});
    assert.equal(runtime.counters.jiraExecutes, 5, "a shared result expires");
});

test("a failed read is never shared with the next caller", async t => {
    const runtime = fakeRuntime();
    const { connection } = await harness(t, runtime, { connection: sharing });
    runtime.permanentError = "Jira returned 400";
    await assert.rejects(connection.gateway.call("getAccessibleAtlassianResources", {}), /400/);
    runtime.permanentError = null;
    assert.deepEqual(await connection.gateway.call("getAccessibleAtlassianResources", {}), [SITE]);
});

test("a slow but healthy startup is never nudged or invalidated by the watch", async t => {
    const runtime = fakeRuntime({ rebuildMs: 80, callMs: 20 });
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    let invalidations = 0;
    const invalidate = connection.gateway.invalidate.bind(connection.gateway);
    connection.gateway.invalidate = () => { invalidations++; invalidate(); };
    await open();
    await sleep(40);
    assert.ok(loaded(workbench));
    assert.equal(invalidations, 0);
    assert.equal(runtime.counters.rebuilds, 1, "no second ~2s rebuild in the middle of startup");
    assert.equal(runtime.counters.list, 1, "only the one-time failed-server check at attach; the watch never started");
});

test("an explicit Refresh or Reload connections reaches Jira even inside the sharing window", async t => {
    const runtime = fakeRuntime();
    const { workbench, open } = await harness(t, runtime, { connection: { gatewayOptions: { ...sharing.gatewayOptions, shareMs: 60_000 } } });
    await open();
    const calls = runtime.counters.jiraExecutes;
    await workbench.refresh();
    assert.equal(runtime.counters.jiraExecutes, calls, "background re-reads share the recent result");
    runtime.tokenExpired = true;
    await workbench.refresh({ fresh: true });
    await workbench.catalog({ fresh: true });
    assert.equal(runtime.tokenExpired, false, "the user's refresh really reached the server");
    assert.equal(workbench.error, null);
    assert.deepEqual(workbench.catalogErrors, []);
});

// Observed live 2026-09-27: an expired Atlassian sign-in looked "connected" in mcp.list, so the panel retried
// forever ("Reconnecting now...") and the runtime broadcast 1,775 unanswered OAuth requests in a day.
test("an expired sign-in is detected, stops the retry storm, and asks for sign-in", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    const snapshot = await workbench.snapshot();
    assert.deepEqual(snapshot.signIn, { server: "atlassian", connector: false });
    assert.match(workbench.error, /sign-in has expired\. Press Sign in to Atlassian/);
    assert.equal(workbench.issues.length, 3, "last good data kept");
    await sleep(20);
    const requests = runtime.counters.oauthRequests;
    assert.ok(requests <= 6, `a call and its two silent-refresh retries, plus at most one in flight (${requests})`);
    for (let i = 0; i < 5; i++) { await workbench.refresh(); await workbench.catalog(); }
    await sleep(80); // sign-in checks keep running
    assert.equal(runtime.counters.oauthRequests, requests, "no further OAuth requests while waiting for sign-in");
    assert.ok(loaded(workbench) === false);
});

test("signing in anywhere (e.g. /mcp auth) reloads the panel with no event and no click", async t => {
    const runtime = fakeRuntime({ events: false });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    assert.ok((await workbench.snapshot()).signIn);
    runtime.completeSignIn({ event: false });
    const ms = await until(t, () => loaded(workbench) && workbench.connection.status().state === "ready", { timeoutMs: 3000, what: "reload after sign-in" });
    assert.ok(ms < 1000, `took ${ms}ms with a 10ms sign-in check`);
    assert.equal((await workbench.snapshot()).signIn, null);
});

test("an oauth_completed event reloads at once even when the sign-in watch is slow", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime, { connection: { watchMs: 60_000, signInReadMs: [60_000, 60_000] } });
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    runtime.completeSignIn({ event: true });
    await until(t, () => loaded(workbench), { timeoutMs: 3000, what: "reload after oauth_completed" });
});

test("Sign in to Atlassian forces a new authorization when the runtime trusts its dead token, and opens it", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    opened.length = 0;
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    const result = await workbench.signIn();
    assert.equal(runtime.counters.logins, 2, "plain login, then forceReauth");
    assert.equal(runtime.lastLogin.forceReauth, true);
    assert.equal(result.authorizationUrl, "https://auth.atlassian.com/authorize?client_id=fake");
    assert.equal(result.opened, true);
    assert.deepEqual(opened, [result.authorizationUrl]);
    runtime.completeSignIn({ event: false });
    await until(t, () => loaded(workbench), { what: "reload after browser sign-in" });
    assert.equal(connection.status().state, "ready");
});

test("Sign in retries with a forced re-authorization when login's own probe fails on the dead token", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    opened.length = 0;
    await open();
    runtime.signInExpired = true;
    runtime.loginProbe400 = true;
    await workbench.refresh();
    const result = await workbench.signIn();
    assert.equal(runtime.counters.logins, 2, "failed plain login, then forceReauth");
    assert.equal(runtime.lastLogin.forceReauth, true);
    assert.deepEqual(opened, [result.authorizationUrl]);
    runtime.completeSignIn({ event: false });
    await until(t, () => loaded(workbench), { what: "reload after browser sign-in" });
    assert.equal(connection.status().state, "ready");
});

test("sign-in reports a link when the browser cannot be opened, and needs no browser when already signed in", async t => {
    const runtime = fakeRuntime();
    const { workbench, open } = await harness(t, runtime, { connection: { openUrl: async () => { throw new Error("no display"); } } });
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    const result = await workbench.signIn();
    assert.equal(result.opened, false);
    assert.match(result.authorizationUrl, /^https:\/\/auth\.atlassian\.com\//);
    runtime.completeSignIn({ event: false });
    const again = await workbench.signIn();
    assert.deepEqual(again, { signedIn: true });
});

test("an explicit Refresh after signing in elsewhere reloads immediately", async t => {
    const runtime = fakeRuntime({ events: false });
    const { connection, workbench, open } = await harness(t, runtime, { connection: { watchMs: 60_000, signInReadMs: [60_000, 60_000] } });
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    runtime.completeSignIn({ event: false });
    await workbench.refresh({ fresh: true });
    assert.equal(workbench.error, null);
    assert.equal(connection.status().state, "ready");
});

test("a single silent token refresh is still invisible and never asks for sign-in", async t => {
    const runtime = fakeRuntime();
    const { workbench, open } = await harness(t, runtime);
    await open();
    runtime.tokenExpired = true;
    await workbench.refresh();
    assert.equal(workbench.error, null);
    assert.equal((await workbench.snapshot()).signIn, null);
    assert.equal(runtime.counters.probes, 0, "no probe needed when the retry succeeds");
});

test("an auth failure the probe cannot confirm is not reported as an expired sign-in", async t => {
    const runtime = fakeRuntime();
    const { workbench, open } = await harness(t, runtime);
    await open();
    runtime.permanentError = "HTTP 401 from an upstream proxy";
    runtime.session.rpc.mcp.oauth.probe = async () => ({ status: "authenticated", httpResponse: { status: 200 } });
    await workbench.refresh();
    assert.equal((await workbench.snapshot()).signIn, null);
    assert.match(workbench.error, /401/);
});

test("keepalive makes no Jira call while waiting for sign-in", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench, open } = await harness(t, runtime, { connection: { keepaliveMs: 10 } });
    await open();
    runtime.signInExpired = true;
    await workbench.refresh();
    await sleep(40); // a keepalive already in flight when sign-in expired may still finish its retries
    const requests = runtime.counters.oauthRequests;
    await sleep(100);
    assert.equal(runtime.counters.oauthRequests, requests, "no new keepalive reads");
    assert.deepEqual([connection.status().state, connection.status().server], ["signin", "atlassian"]);
});

test("a server that drops to needs-auth under an open panel shows Sign in, and signing in reloads the project", async t => {
    const runtime = fakeRuntime({ events: false });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    await until(t, () => loaded(workbench), { what: "first load" });
    // Live: the snapshot still offers the tools, but the runtime answers "Tool '…' does not exist".
    runtime.servers.set("atlassian", "needs-auth");
    await workbench.refresh();
    const snapshot = await workbench.snapshot();
    assert.deepEqual(snapshot.signIn, { server: "atlassian", connector: false });
    assert.doesNotMatch(workbench.error, /does not exist/);
    assert.equal(workbench.issues.length, 3, "last good data kept");
    assert.equal(runtime.counters.restarts, 0, "needs-auth waits for the user");
    const result = await workbench.signIn();
    assert.match(result.authorizationUrl, /^https:\/\/auth\.atlassian\.com\//);
    assert.equal(runtime.lastLogin.forceReauth, false, "no forced re-auth needed when the server itself asks for sign-in");
    runtime.servers.set("atlassian", "connected");
    runtime.snapshot = [];
    await until(t, () => loaded(workbench) && workbench.connection.status().state === "ready", { what: "reload after sign-in with no event" });
    assert.equal((await workbench.snapshot()).signIn, null);
    assert.equal(workbench.project.key, "DEMO", "the same site and project reopen");
});

test("a needs-auth server coming back connected reloads at once even when the sign-in watch is slow", async t => {
    const runtime = fakeRuntime({ status: "needs-auth" });
    const { workbench, open, loaded } = await harness(t, runtime, { connection: { watchMs: 60_000 } });
    await open();
    await until(t, async () => (await workbench.snapshot()).signIn, { what: "sign-in request" });
    runtime.set("atlassian", "connected");
    await until(t, () => loaded(workbench), { what: "reload after the server connected" });
});

test("a runtime that stops answering never leaves the panel warming forever, and it loads once the runtime answers", async t => {
    const runtime = fakeRuntime();
    runtime.hang();
    const timeouts = { metadata: 30, rebuild: 30, list: 30, probe: 30, execute: 30 };
    const { workbench, open, loaded } = await harness(t, runtime, {
        connection: { gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0, timeouts } },
    });
    await open();
    await until(t, () => workbench.catalogErrors.length, { what: "the reason shown while still retrying" });
    await until(t, () => !workbench.warming, { what: "a bounded failure instead of a hang" });
    assert.match(workbench.catalogErrors[0], /did not answer its tool list within \d+s\. Retrying automatically/);
    await sleep(100);
    assert.ok(runtime.counters.metadata <= 2, `stuck calls are reused, not stacked (${runtime.counters.metadata})`);
    runtime.release = runtime.stalled.release;
    runtime.release();
    await until(t, () => loaded(workbench), { what: "load after the runtime answers" });
});

test("a stalled tool list falls back to the last one instead of failing a working connection", async t => {
    const runtime = fakeRuntime();
    const timeouts = { metadata: 30, rebuild: 30, list: 30, probe: 30, execute: 30 };
    const { workbench, open, loaded } = await harness(t, runtime, {
        connection: { gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0, timeouts } },
    });
    await open();
    await until(t, () => loaded(workbench), { what: "first load" });
    runtime.hang();
    workbench.gateway.invalidate();
    await workbench.refresh({ fresh: true });
    assert.equal(workbench.error, null);
    assert.equal(workbench.issues.length, runtime.issueCount);
    runtime.stalled.release();
});

test("a stalled tool list still surfaces Sign in when the Atlassian server is waiting for it", async t => {
    const runtime = fakeRuntime({ status: "needs-auth" });
    runtime.hang();
    const timeouts = { metadata: 30, rebuild: 30, list: 30, probe: 30, execute: 30 };
    const { workbench, open } = await harness(t, runtime, {
        connection: { gatewayOptions: { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0, timeouts } },
    });
    await open();
    await until(t, async () => (await workbench.snapshot()).signIn, { what: "sign-in request despite the stalled tool list" });
    runtime.stalled.release();
});

test("Atlassian MCP v2 loads sites, projects and the full hierarchy", async t => {
    const runtime = fakeRuntime({ v2: true, issueCount: 60 });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    await until(t, () => loaded(workbench), { what: "v2 project to load" });
    assert.deepEqual(workbench.sites, [{ id: SITE.id, name: "demo", url: SITE.url }]);
    assert.deepEqual(workbench.projectLists.get(SITE.id).map(p => p.key), ["DEMO", "ALT"]);
    const child = workbench.issues.find(issue => issue.key === "DEMO-2");
    assert.equal(child.parentKey, "DEMO-1");
    assert.equal(child.projectId, "42");
    assert.equal(child.category, "new");
    const searches = runtime.calls.filter(c => c.name === "searchJiraIssuesUsingJql");
    assert.ok(searches.length >= 1 && searches.every(c => c.args.view === "full"));
    const lists = runtime.calls.filter(c => c.name === "executeRead" && c.args.name === "listJiraProjects");
    assert.ok(lists.length >= 1 && lists.every(c => c.args.cloudId === SITE.id));
    assert.ok(runtime.calls.filter(c => c.name === "executeRead").every(c => ["listJiraProjects", "listJiraStatuses"].includes(c.args.name)));
});

test("each project's own workflow statuses reach the snapshot and cache, including steps no issue is in", async t => {
    const runtime = fakeRuntime({ v2: true });
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    await until(t, () => loaded(workbench), { what: "v2 project to load" });
    const listings = runtime.calls.filter(c => c.name === "executeRead" && c.args.name === "listJiraStatuses");
    assert.ok(listings.length >= 1 && listings.every(c => c.args.cloudId === SITE.id && c.args.inputs.mode === "project" && c.args.inputs.projectKey === "42"));
    const expected = [
        { name: "To Do", category: "new" }, { name: "PR Waiting", category: "indeterminate" },
        { name: "In Progress", category: "indeterminate" }, { name: "Done", category: "done" },
    ];
    assert.deepEqual((await workbench.snapshot()).statuses, expected);
    const cached = await workbench.cache.read();
    assert.deepEqual(cached.issues[workbench.selectedScope()].statuses.map(s => s.name), ["PR Waiting", "In Progress", "Done", "To Do"]);
    const reopened = new Workbench({ cache: workbench.cache, store: workbench.store });
    assert.equal(await reopened.hydrate(), true);
    assert.deepEqual((await reopened.snapshot()).statuses, expected, "a warm start shows the project's statuses before Jira answers");
});

for (const [what, options] of [["the app's Atlassian Rovo connector alone", { status: null, connector: "connected" }],
    ["the Rovo connector beside a v1 atlassian server", { status: "connected", connector: "connected" }]]) {
    test(`${what} serves each project's workflow statuses`, async t => {
        const runtime = fakeRuntime(options);
        const { workbench, open, loaded } = await harness(t, runtime);
        await open();
        await until(t, () => loaded(workbench), { what: "project to load through the connector" });
        const listings = runtime.calls.filter(c => c.args?.name === "listJiraStatuses");
        assert.ok(listings.length >= 1 && listings.every(c => c.server === CONNECTOR));
        assert.ok((await workbench.snapshot()).statuses.some(s => s.name === "PR Waiting"));
    });
}

test("without a status listing (v1, or a failed read) the filter still offers every status seen on an issue", async t => {
    for (const options of [{}, { v2: true, failListing: true }]) {
        const runtime = fakeRuntime(options);
        const { connection, workbench, open, loaded } = await harness(t, runtime);
        if (options.failListing) connection.gateway.statuses = async () => { throw new Error("listing unavailable"); };
        // A listing cached by an earlier read, with a step the workflow has since removed.
        await workbench.cache.update(data => {
            data.catalog = { sites: [{ id: SITE.id, name: "demo", url: SITE.url }], appProjects: [] };
            data.projectLists[SITE.id] = { projects: [{ id: "42", key: "DEMO", name: "Demo project" }] };
            data.issues[`${SITE.id}/42/project`] = { issues: [], statuses: [{ name: "Retired step", category: "indeterminate" }], fetchedAt: new Date().toISOString() };
        });
        assert.equal(await workbench.hydrate(requested), true);
        assert.ok((await workbench.snapshot()).statuses.some(s => s.name === "Retired step"), "the cached listing shows on a warm start");
        await open();
        await until(t, () => loaded(workbench), { what: "project to load" });
        assert.ok(!runtime.calls.some(c => c.args?.name === "listJiraStatuses"));
        assert.deepEqual((await workbench.snapshot()).statuses, [{ name: "To Do", category: "new" }], "an earlier listing is not presented as current");
        assert.deepEqual((await workbench.cache.read()).issues[workbench.selectedScope()].statuses, []);
        assert.equal(workbench.error, null, "a missing listing never fails the Jira refresh");
    }
});

test("Atlassian MCP v1 search is never sent v2-only arguments", async t => {
    const runtime = fakeRuntime();
    const { workbench, open, loaded } = await harness(t, runtime);
    await open();
    await until(t, () => loaded(workbench), { what: "v1 project to load" });
    const searches = runtime.calls.filter(c => c.name === "searchJiraIssuesUsingJql");
    assert.ok(searches.length >= 1 && searches.every(c => !("view" in c.args)));
    assert.ok(runtime.calls.some(c => c.name === "getVisibleJiraProjects"));
});

test("executeRead stays read-only: only allowlisted operations pass", async t => {
    const runtime = fakeRuntime({ v2: true });
    const { connection } = await harness(t, runtime);
    await assert.rejects(connection.gateway.call("executeRead", { name: "listJiraIssueComments", cloudId: SITE.id, inputs: {} }), /read-only; executeRead listJiraIssueComments/);
    await assert.rejects(connection.gateway.call("executeWrite", { name: "createJiraIssue" }), /read-only/);
    assert.equal(runtime.calls.length, 0);
});

// Finding L1: Atlassian v2 answers the passive probe with 400 for a dead token, so the probe cannot say "expired".
// Each Jira call made with a dead token makes the runtime broadcast an OAuth request; while signed out, those
// calls must stay at most one per backoff step, whatever the panels, events and keepalive do.
const PROBES = [["v2, whose probe answers 400", { v2: true }], ["v1, whose probe answers 401", { probeWhenExpired: 401 }]];
// How many sign-in backoff steps start within ms of entering signin: one read is allowed per step.
const stepsWithin = (ms, [first, cap]) => { let steps = 0, at = first, delay = first; while (at <= ms) { steps++; delay = Math.min(delay * 2, cap); at += delay; } return steps; };

for (const [label, model] of PROBES) {
    test(`signed out on ${label}: at most one OAuth-triggering Jira call per backoff step, and signing in is picked up with no event`, async t => {
        const runtime = fakeRuntime({ ...model, events: false });
        const steps = [20, 160];
        const { connection, workbenches, open, loaded } = await harness(t, runtime, { panels: 2, connection: { keepaliveMs: 10, signInReadMs: steps } });
        await Promise.all(workbenches.map(w => open(w)));
        await until(t, () => workbenches.every(loaded), { what: "first load" });
        runtime.signInExpired = true;
        await workbenches[0].refresh();
        assert.equal(connection.status().state, "signin");
        assert.deepEqual((await workbenches[1].snapshot()).signIn, { server: "atlassian", connector: false });
        const entered = connection.status().since;
        await sleep(15); // a keepalive already in flight when the token died may finish its retries
        const base = runtime.counters.oauthRequests;
        // Open panels keep polling, refreshing and reloading, and MCP events keep arriving.
        while (Date.now() - entered < 700) {
            for (const w of workbenches) { await w.snapshot(); await w.refresh(); await w.catalog(); }
            runtime.emit("session.mcp_server_status_changed", { serverName: "atlassian", status: "connected" });
            await sleep(10);
        }
        const requests = runtime.counters.oauthRequests - base;
        const allowed = stepsWithin(Date.now() - entered, steps);
        assert.ok(requests <= allowed, `${requests} OAuth-triggering calls in ${Date.now() - entered}ms; ${allowed} backoff steps allow ${allowed}`);
        if (model.probeWhenExpired === 401) assert.equal(requests, 0, "a probe that answers 401 needs no read at all");
        else assert.ok(requests >= 1, "a probe that cannot tell is backed by an occasional single read");
        assert.ok(workbenches.every(w => w.issues.length === runtime.issueCount), "last good data kept");
        assert.equal(connection.status().state, "signin");
        runtime.completeSignIn({ event: false });
        const ms = await until(t, () => workbenches.every(loaded) && connection.status().state === "ready", { what: "reload after sign-in with no event" });
        assert.ok(ms < 1000, `took ${ms}ms with a ${steps[1]}ms backoff cap`);
    });

    test(`signed out on ${label}: an oauth_completed event reloads at once, and an explicit refresh makes exactly one call`, async t => {
        const runtime = fakeRuntime(model);
        const { connection, workbench, open, loaded } = await harness(t, runtime, { connection: { watchMs: 60_000, backoffMs: [60_000, 60_000], signInReadMs: [60_000, 60_000] } });
        await open();
        runtime.signInExpired = true;
        await workbench.refresh();
        assert.equal(connection.status().state, "signin");
        const base = runtime.counters.oauthRequests;
        await workbench.refresh({ fresh: true });
        assert.equal(runtime.counters.oauthRequests - base, 1, "one single-attempt read, no transient retries");
        assert.match(workbench.error, /sign-in has expired/);
        runtime.completeSignIn({ event: true });
        const ms = await until(t, () => loaded(workbench), { what: "reload after oauth_completed" });
        assert.ok(ms < 1000, `took ${ms}ms with minute-long checks`);
        assert.equal(connection.status().state, "ready");
    });
}

// Records every timer started while it is installed, and which ones are still pending.
function trackTimers(t) {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const pending = new Map();
    let started = 0;
    globalThis.setTimeout = (fn, ms, ...args) => {
        started++;
        const handle = real.setTimeout(() => { pending.delete(handle); fn(...args); }, ms);
        pending.set(handle, ms);
        return handle;
    };
    globalThis.clearTimeout = handle => { pending.delete(handle); real.clearTimeout(handle); };
    const restore = () => Object.assign(globalThis, real);
    t.after(restore);
    return { pending, started: () => started, restore, wait: ms => new Promise(resolve => real.setTimeout(resolve, ms)) };
}

for (const [label, status, connectionOptions] of [
    ["ready with keepalive", "connected", { keepaliveMs: 10 }],
    ["down with a restart pending", "failed", { restartDelaysMs: [60_000] }],
    ["signed out", "connected", { keepaliveMs: 10 }],
]) {
    test(`no timers or runtime calls remain after the last panel detaches and the connection stops (${label})`, async t => {
        const timers = trackTimers(t);
        const runtime = fakeRuntime({ status });
        const { connection, workbenches, open } = await harness(t, runtime, { panels: 2, connection: connectionOptions });
        await Promise.all(workbenches.map(w => open(w)));
        if (label === "signed out") { runtime.signInExpired = true; await workbenches[0].refresh(); assert.equal(connection.status().state, "signin"); }
        await timers.wait(40);
        assert.ok(timers.pending.size > 0, "the connection was busy while panels were open");
        for (const w of workbenches) connection.detach(w);
        assert.equal(connection.status().nextCheckAt, null);
        connection.stop();
        for (const w of workbenches) { w.close(); await w.idle(); }
        await timers.wait(60); // bounded calls already in flight settle and clear their own timers
        assert.deepEqual([...timers.pending.values()], [], "no pending timer");
        const counters = JSON.stringify(runtime.counters);
        await timers.wait(60);
        assert.equal(JSON.stringify(runtime.counters), counters, "no runtime call");
        assert.equal(runtime.listeners(), 0, "no session listener");
        timers.restore();
    });
}

test("snapshot() is pure: no timers, no runtime calls and no state change, in any connection state", async t => {
    const runtime = fakeRuntime({ status: "stopped" });
    const { connection, workbench, open } = await harness(t, runtime, { connection: { watchMs: 60_000, backoffMs: [60_000, 60_000] } });
    await open();
    await sleep(30);
    await workbench.idle();
    const check = async () => {
        const timers = trackTimers(t);
        const counters = JSON.stringify(runtime.counters), status = JSON.stringify(connection.status());
        const passes = workbench.pending.size;
        let snapshot;
        for (let i = 0; i < 20; i++) snapshot = await workbench.snapshot();
        timers.restore();
        assert.equal(timers.started(), 0, "snapshot started no timer");
        assert.equal(JSON.stringify(runtime.counters), counters, "snapshot made no runtime call");
        assert.equal(JSON.stringify(connection.status()), status, "snapshot changed no connection state");
        assert.equal(workbench.pending.size, passes, "snapshot started no work");
        return snapshot;
    };
    const down = await check();
    const status = connection.status();
    assert.equal(status.state, "down");
    assert.deepEqual(down.connection, { state: "down", reason: status.reason, server: "atlassian", connector: false, nextCheckAt: status.nextCheckAt });
    assert.match(down.connection.reason, /atlassian is stopped/);
    assert.ok(down.retryAt && down.retryAt === status.nextCheckAt, "the retry hint is the connection's next check");
    assert.equal(down.signIn, null);
    runtime.set("atlassian", "needs-auth");
    await until(t, () => connection.status().state === "signin", { what: "signin" });
    await workbench.idle();
    const signin = await check();
    assert.deepEqual(signin.signIn, { server: "atlassian", connector: false });
    runtime.set("atlassian", "connected");
    await until(t, () => connection.status().state === "ready" && !workbench.needsRecovery(), { what: "ready" });
    await workbench.idle();
    const ready = await check();
    assert.deepEqual([ready.retryAt, ready.signIn, ready.connection.state], [null, null, "ready"]);
});

// The Copilot app's Atlassian Rovo connector next to the atlassian MCP server: both offer every Jira tool.
const servedBy = runtime => [...new Set(runtime.calls.map(call => call.server))];

test("with both the atlassian MCP server and the app's Atlassian Rovo connector on, the connector serves every read", async t => {
    const runtime = fakeRuntime({ v2: true, connector: "connected" });
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    await open();
    assert.ok(loaded(workbench), JSON.stringify(workbench.catalogErrors));
    assert.deepEqual(servedBy(runtime), [CONNECTOR], "no 'ambiguous' error: the connector, Atlassian's official route, is preferred");
    assert.equal(runtime.counters.rebuilds, 1, "duplicate tools cost no extra rebuild");
    await until(t, () => connection.status().state === "ready", { what: "ready" });
});

test("a signed-out atlassian server still in the tool list does not hide the connected connector", async t => {
    // Observed live: the session's tool list keeps the atlassian server's tools after it drops to needs-auth.
    const runtime = fakeRuntime({ connector: "connected" });
    await runtime.session.rpc.tools.initializeAndValidate();
    runtime.servers.set("atlassian", "needs-auth");
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    await open();
    assert.ok(loaded(workbench), JSON.stringify(workbench.catalogErrors));
    await until(t, () => connection.status().state === "ready", { what: "ready" });
    assert.equal(connection.status().server, CONNECTOR);
    assert.equal((await workbench.snapshot()).signIn, null, "no Sign in prompt while the connector works");
    assert.deepEqual(servedBy(runtime), [CONNECTOR]);
    assert.ok(runtime.calls.some(call => call.name === "executeRead"), "projects come from the connector's v2 tools, not the signed-out v1 server");
});

test("the app's Atlassian Rovo connector alone is enough", async t => {
    const runtime = fakeRuntime({ status: null, connector: "connected" });
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    await open();
    assert.ok(loaded(workbench), JSON.stringify(workbench.catalogErrors));
    await until(t, () => connection.status().state === "ready" && connection.status().server === CONNECTOR, { what: "ready on the connector" });
    assert.equal(connection.status().connector, true);
    assert.deepEqual(servedBy(runtime), [CONNECTOR]);
});

test("when the connector drops, the atlassian MCP server takes over the same read", async t => {
    const runtime = fakeRuntime({ v2: true, connector: "connected", events: false });
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.servers.set(CONNECTOR, "stopped");
    runtime.calls.length = 0;
    await workbench.refresh();
    assert.ok(loaded(workbench), JSON.stringify([workbench.error, workbench.catalogErrors]));
    assert.deepEqual(servedBy(runtime), ["atlassian"]);
    assert.deepEqual([connection.status().server, connection.status().connector], ["atlassian", false],
        "the connection names the server that answered, not the one that failed");
});

test("a connector that needs sign-in points to the Copilot app and never starts an OAuth login", async t => {
    const runtime = fakeRuntime({ status: null, connector: "connected" });
    const { connection, workbench, open, loaded } = await harness(t, runtime);
    await open();
    runtime.set(CONNECTOR, "needs-auth");
    await until(t, () => connection.status().state === "signin", { what: "signin" });
    assert.deepEqual((await workbench.snapshot()).signIn, { server: CONNECTOR, connector: true });
    assert.match(connection.status().reason, /Atlassian connector needs sign-in/);
    assert.doesNotMatch(connection.status().reason, /cc-_/, "the opaque connector name is never shown");
    await assert.rejects(workbench.signIn(), /Copilot app/);
    assert.equal(runtime.counters.logins, 0);
    runtime.set(CONNECTOR, "connected");
    await until(t, () => connection.status().state === "ready" && loaded(workbench), { what: "reload once the app reconnects it" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Cache } from "../lib/cache.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { Connection } from "../lib/connection.mjs";
import { fakeRuntime, SITE } from "./fake-runtime.mjs";

// Budgets are ~4x what an M-series laptop measures, so they catch regressions (e.g. a quadratic tree
// build or a retry storm) without flaking on a slower CI runner.
const requested = { cloudId: SITE.id, jiraProjectId: "42" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, runtime, { connection: connectionOptions = {}, workbench: workbenchOptions = {} } = {}) {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-perf-"));
    const connection = new Connection(runtime.session, { debounceMs: 5, keepaliveMs: 0, gatewayOptions: { transientDelayMs: 1, shareMs: 0 }, ...connectionOptions }).start();
    const make = id => new Workbench({
        gateway: connection.gateway, store: new Store(path), cache: new Cache(path), github: async () => null,
        send: async () => {}, instanceId: id, ...workbenchOptions,
    });
    const workbench = make("perf");
    connection.attach(workbench);
    t.after(async () => {
        connection.stop();
        workbench.close();
        await workbench.idle();
        await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    });
    return { connection, workbench, make };
}

test("a 5,000-issue project loads in one pass with no redundant Jira calls", async t => {
    const runtime = fakeRuntime({ issueCount: 5000, callMs: 5 });
    const { workbench } = await setup(t, runtime);
    const started = performance.now();
    const snapshot = await workbench.select(requested);
    const ms = performance.now() - started;
    assert.equal(snapshot.issues.length, 5000);
    assert.ok(ms < 2500, `select took ${ms.toFixed(0)}ms`);
    assert.equal(runtime.counters.jiraExecutes, 1 + 1 + 50, "sites + projects + 50 issue pages, nothing repeated");
    assert.equal(runtime.counters.rebuilds, 1);
});

test("snapshots of a large project stay fast and scale linearly", async t => {
    const timings = {};
    for (const count of [2000, 8000]) {
        const runtime = fakeRuntime({ issueCount: count });
        const { workbench } = await setup(t, runtime);
        await workbench.select(requested);
        await workbench.snapshot(); // warm the JIT
        const started = performance.now();
        await workbench.snapshot();
        timings[count] = performance.now() - started;
    }
    assert.ok(timings[8000] < 600, `8,000-issue snapshot took ${timings[8000].toFixed(0)}ms`);
    // 4x the issues: linear is ~4x, quadratic would be ~16x.
    assert.ok(timings[8000] / Math.max(timings[2000], 1) < 9, `scaling ${JSON.stringify(timings)}`);
});

test("reopening paints a 5,000-issue project from the warm cache without contacting Jira", async t => {
    const runtime = fakeRuntime({ issueCount: 5000 });
    const { workbench, make } = await setup(t, runtime);
    await workbench.select(requested);
    await workbench.idle();
    const calls = runtime.counters.executes;
    const reopened = make("reopened");
    const started = performance.now();
    assert.equal(await reopened.hydrate(), true);
    const ms = performance.now() - started;
    assert.equal(reopened.issues.length, 5000);
    assert.equal(runtime.counters.executes, calls);
    assert.ok(ms < 600, `hydrate took ${ms.toFixed(0)}ms`);
    reopened.close();
});

test("a healthy panel makes no calls while idle", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench } = await setup(t, runtime, { connection: { watchMs: 10 } });
    await workbench.background(() => workbench.warm(requested));
    await sleep(20);
    const calls = runtime.counters.executes, rebuilds = runtime.counters.rebuilds, lists = runtime.counters.list;
    for (let i = 0; i < 20; i++) { await workbench.snapshot(); await sleep(10); }
    assert.equal(runtime.counters.executes, calls);
    assert.equal(runtime.counters.rebuilds, rebuilds);
    assert.equal(runtime.counters.list, lists, "no polling once Jira is ready");
    assert.equal(connection.status().nextCheckAt, null, "nothing is scheduled (keepalive is off here)");
});

test("a long outage backs off exponentially instead of hammering the runtime", async t => {
    const runtime = fakeRuntime({ status: "stopped" });
    // Scaled: 1s polls for 30s, then 2s doubling to 60s, become 10ms polls for 50ms, then 10ms doubling.
    const { connection, workbench } = await setup(t, runtime, { connection: { restartDelaysMs: [], watchMs: 10, watchForMs: 50, backoffMs: [10, 60_000] } });
    const delays = [];
    const cadence = connection.cadence.bind(connection);
    connection.cadence = () => { const ms = cadence(); delays.push(ms); return ms; };
    await workbench.background(() => workbench.warm(requested));
    // Entering "down" re-runs the incomplete startup once; after that the outage is unchanged.
    await sleep(30);
    await workbench.idle();
    let attempts = 0;
    const recover = workbench.recover.bind(workbench);
    workbench.recover = () => { attempts++; return recover(); };
    const jira = runtime.counters.jiraExecutes, rebuilds = runtime.counters.rebuilds, lists = runtime.counters.list;
    await sleep(900);
    assert.equal(attempts, 0, "nothing changed, so the panel never re-ran its startup");
    assert.equal(runtime.counters.jiraExecutes, jira, "a stopped server costs no Jira call");
    assert.ok(runtime.counters.rebuilds <= rebuilds + 1, `${runtime.counters.rebuilds - rebuilds} rebuilds`);
    assert.ok(runtime.counters.list - lists <= 14, `${runtime.counters.list - lists} server-list checks in 900ms`);
    // Each scheduled poll doubles the previous one, or is the fast poll right after a change.
    // A cap, a plateau or a linear step would break this chain.
    for (let i = 1; i < delays.length; i++)
        assert.ok(delays[i] === Math.min(delays[i - 1] * 2, 60_000) || delays[i] === 10, `delays ${delays.join(", ")}`);
    let run = 1, longest = 1;
    for (let i = 1; i < delays.length; i++) { run = delays[i] === delays[i - 1] * 2 ? run + 1 : 1; longest = Math.max(longest, run); }
    assert.ok(longest >= 4, `an unbroken outage keeps doubling (delays ${delays.join(", ")})`);
});

test("keepalive costs one Jira call per interval and nothing when no panel is open", async t => {
    const runtime = fakeRuntime();
    const { connection, workbench } = await setup(t, runtime, { connection: { keepaliveMs: 20 } });
    await workbench.background(() => workbench.warm(requested));
    const before = runtime.counters.jiraExecutes;
    await sleep(210);
    const calls = runtime.counters.jiraExecutes - before;
    assert.ok(calls >= 5 && calls <= 11, `${calls} keepalive calls in 210ms at a 20ms interval`);
    connection.detach(workbench);
    const after = runtime.counters.jiraExecutes;
    await sleep(80);
    assert.equal(runtime.counters.jiraExecutes, after);
});

test("a 2s tool rebuild is paid once per startup pass even when every call misses", async t => {
    const runtime = fakeRuntime({ status: "stopped", rebuildMs: 40 });
    const { workbench } = await setup(t, runtime, { connection: { restartDelaysMs: [] } });
    const started = performance.now();
    await workbench.background(() => workbench.warm(requested));
    const ms = performance.now() - started;
    assert.equal(runtime.counters.rebuilds, 1);
    assert.ok(ms < 1500, `a failing startup pass took ${ms.toFixed(0)}ms`);
});

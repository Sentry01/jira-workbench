import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "../lib/updater.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { Connection } from "../lib/connection.mjs";
import { fakeRuntime, SITE } from "./fake-runtime.mjs";

// Finding M-2: extension.mjs's panel lifecycle, loaded with a stub SDK (test/fake-sdk.mjs) and the fake runtime.
const home = await mkdtemp(join(tmpdir(), "jira-workbench-extension-"));
process.env.COPILOT_HOME = home;
const sdk = new URL("./fake-sdk.mjs", import.meta.url).href, slowVersion = new URL("./slow-version.mjs", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export const resolve = (specifier, context, next) =>
    specifier === "@github/copilot-sdk/extension" ? { url: ${JSON.stringify(sdk)}, shortCircuit: true }
    : specifier === "./lib/version.mjs" && (context.parentURL || "").includes("/extension.mjs?") ? { url: ${JSON.stringify(slowVersion)}, shortCircuit: true }
    : next(specifier, context);`)}`);

const updaters = new Set(), workbenches = new Set();
let connection, gate = null;
const { acquire } = Updater.prototype, { hydrate } = Workbench.prototype, { start } = Connection.prototype;
Updater.prototype.acquire = function () { updaters.add(this); return acquire.call(this); };
// Opens wait here until the test releases them, so concurrent opens really overlap.
Workbench.prototype.hydrate = async function (...args) {
    workbenches.add(this);
    const restored = await hydrate.apply(this, args);
    await gate?.promise;
    return restored;
};
Connection.prototype.start = function () { connection = this; return start.call(this); };
const hold = () => { let release; gate = { promise: new Promise(resolve => { release = resolve; }) }; gate.release = release; return gate; };

// A fresh extension process: its own panels, Updater and Connection.
async function load(name) {
    globalThis.__workbenchSession = { ...fakeRuntime({ issueCount: 3 }).session, send: async () => {} };
    await import(`../extension.mjs?${name}`);
    updaters.clear(); workbenches.clear();
    connections.push(connection);
    return { canvas: globalThis.__workbenchCanvas, connection };
}
const listening = url => fetch(new URL(url).origin).then(() => true, () => false);
const holders = () => [...updaters].reduce((sum, updater) => sum + updater.holders, 0);
const input = { cloudId: SITE.id, jiraProjectId: "42" };
const settle = async () => { for (const workbench of workbenches) await workbench.idle(); };

const connections = [];
test.after(async () => {
    await settle();
    for (const loaded of connections) loaded.stop();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    // A leaked panel server keeps the process alive; fail instead of hanging the suite.
    setTimeout(() => { console.error("A panel server or timer was left running after every panel closed."); process.exit(1); }, 2_000).unref();
});

test("concurrent opens of one panel share one server, Workbench and Updater hold, and close cleanly", async () => {
    const { canvas, connection } = await load("same");
    const release = hold().release;
    const opens = [canvas.open({ instanceId: "p1", input }), canvas.open({ instanceId: "p1", input })];
    const state = canvas.actions.find(action => action.name === "get_state").handler({ instanceId: "p1", input: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [a, b] = await Promise.all(opens);
    assert.ok(await state, "an action sent during open waits for the panel");
    assert.equal(a.url, b.url, "one server per panel");
    assert.equal(workbenches.size, 1);
    assert.equal(updaters.size, 1);
    assert.equal(holders(), 1);
    assert.equal(connection.panels.size, 1);
    await canvas.onClose({ instanceId: "p1" });
    assert.equal(holders(), 0);
    assert.equal([...updaters][0].timers.length, 0, "no update checks run with every panel closed");
    assert.equal(connection.panels.size, 0);
    assert.equal(await listening(a.url), false);
    await settle();
});

test("a panel closed while it is still opening is torn down, not leaked", async () => {
    const { canvas, connection } = await load("close-during-open");
    const release = hold().release;
    const opening = canvas.open({ instanceId: "p2", input });
    await new Promise(resolve => setTimeout(resolve, 10));
    const closing = canvas.onClose({ instanceId: "p2" });
    release();
    await assert.rejects(opening, error => error.code === "workbench_closed");
    await closing;
    assert.equal(workbenches.size, 1);
    assert.equal([...workbenches][0].closed, true);
    assert.equal(holders(), 0);
    assert.equal(connection.panels.size, 0);
    await assert.rejects(canvas.actions[0].handler({ instanceId: "p2", input: {} }), error => error.code === "workbench_not_open");
    await settle();
});

test("panels opened together on a cold process share one Updater", async () => {
    const { canvas, connection } = await load("cold");
    const release = hold().release;
    const opens = ["p1", "p2"].map(instanceId => canvas.open({ instanceId, input }));
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    const [a, b] = await Promise.all(opens);
    assert.notEqual(a.url, b.url);
    assert.equal(updaters.size, 1, "one Updater per process");
    assert.equal(holders(), 2);
    assert.equal(connection.panels.size, 2);
    await Promise.all(["p1", "p2"].map(instanceId => canvas.onClose({ instanceId })));
    assert.equal(holders(), 0);
    assert.equal(connection.panels.size, 0);
    assert.deepEqual(await Promise.all([a.url, b.url].map(listening)), [false, false]);
    await settle();
});

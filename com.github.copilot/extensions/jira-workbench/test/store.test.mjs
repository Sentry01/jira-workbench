import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Store } from "../lib/store.mjs";
import { Workbench } from "../lib/workbench.mjs";

async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-warm-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

test("persists multi-session links across instances without overwriting concurrent updates", async () => {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-test-"));
    try {
        const a = new Store(path), b = new Store(path);
        await Promise.all([
            a.update(data => { data.links.alpha = { sessions: [{ id: "one" }] }; }),
            b.update(data => { data.links.beta = { sessions: [{ id: "two" }] }; }),
        ]);
        const saved = await new Store(path).read();
        assert.equal(saved.links.alpha.sessions[0].id, "one");
        assert.equal(saved.links.beta.sessions[0].id, "two");
        assert.equal(saved.version, 1);
        assert.ok((await readFile(join(path, "state.json"), "utf8")).includes("alpha"));
    } finally { await rm(path, { recursive: true }); }
});


test("rejects corrupt persistent state instead of resetting links silently", async () => {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-test-"));
    try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(path, "state.json"), "{bad}");
        await assert.rejects(new Store(path).read(), /state|JSON/i);
    } finally { await rm(path, { recursive: true }); }
});


test("a lock left by a crashed writer is recovered instead of blocking every write", async t => {
    const path = await directory(t);
    const store = new Store(path);
    await writeFile(join(path, "write.lock"), "2147483646 0");
    const started = Date.now();
    await store.update(data => { data.links.alpha = { sessions: [] }; });
    assert.ok(Date.now() - started < 1000);
    await writeFile(join(path, "write.lock"), "");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(path, "write.lock"), old, old);
    await store.update(data => { data.links.beta = { sessions: [] }; });
    const saved = await store.read();
    assert.ok(saved.links.alpha && saved.links.beta);
    await assert.rejects(readFile(join(path, "write.lock")), { code: "ENOENT" });
});


test("a failed lock write releases the lock instead of blocking later writes", async t => {
    const path = await directory(t);
    const store = new Store(path);
    const probe = await open(join(path, "probe"), "w");
    const proto = Object.getPrototypeOf(probe), original = proto.writeFile;
    await probe.close();
    let fail = true;
    proto.writeFile = function (...args) {
        if (fail) { fail = false; return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })); }
        return original.apply(this, args);
    };
    try { await assert.rejects(store.update(data => { data.links.lost = { sessions: [] }; }), /disk full/); }
    finally { proto.writeFile = original; }
    await assert.rejects(readFile(join(path, "write.lock")), { code: "ENOENT" });
    const started = Date.now();
    await store.update(data => { data.links.kept = { sessions: [] }; });
    assert.ok(Date.now() - started < 1000, "the next write does not wait for stale-lock recovery");
    assert.deepEqual(Object.keys((await store.read()).links), ["kept"]);
});


test("writes keep every queued request but only the 20 most recent finished requests per scope", async t => {
    const path = await directory(t);
    const store = new Store(path);
    const minute = n => new Date(Date.UTC(2026, 0, 1, 8, n)).toISOString();
    const requests = {};
    for (let n = 0; n < 25; n++) requests[`a-attached-${n}`] = { scope: "site/42/1", status: "attached", at: minute(0), completedAt: minute(n) };
    requests["a-failed-old"] = { scope: "site/42/1", status: "failed", at: minute(1) };
    requests["a-cancelled-new"] = { scope: "site/42/1", status: "cancelled", at: minute(0), cancelledAt: minute(59) };
    requests["a-expired"] = { scope: "site/42/1", status: "queued", at: minute(0) };
    requests["a-queued"] = { scope: "site/42/1", status: "queued", at: new Date().toISOString() };
    for (let n = 0; n < 3; n++) requests[`b-failed-${n}`] = { scope: "site/42/2", status: "failed", at: minute(n) };
    await writeFile(join(path, "state.json"), JSON.stringify({ version: 1, mappings: {}, links: {}, requests }));
    await store.update(() => {});
    const kept = Object.keys((await store.read()).requests);
    assert.ok(kept.includes("a-expired") && kept.includes("a-queued"), "queued and expired requests are never pruned");
    assert.equal(kept.filter(id => id.startsWith("b-")).length, 3, "each scope has its own allowance");
    const finished = kept.filter(id => id.startsWith("a-") && !["a-expired", "a-queued"].includes(id));
    assert.equal(finished.length, 20);
    assert.ok(finished.includes("a-cancelled-new"), "cancelledAt orders a cleared request");
    assert.ok(!finished.includes("a-failed-old"), "a failure ordered by its at is the oldest");
    assert.deepEqual(finished.filter(id => id.startsWith("a-attached-")).map(id => Number(id.split("-")[2])).sort((x, y) => x - y),
        Array.from({ length: 19 }, (_, i) => i + 6), "completedAt keeps the newest receipts");
});


test("writes store brief descendants as keys and drop retired trace origins", async t => {
    const path = await directory(t);
    const store = new Store(path);
    const children = Array.from({ length: 500 }, (_, i) => ({ id: String(i), key: `DEMO-${i}`, summary: "s".repeat(255), status: "To Do" }));
    await writeFile(join(path, "state.json"), JSON.stringify({
        version: 1, mappings: {},
        links: { "site/42/1": { sessions: [{ id: "one" }], prs: [], origins: [{ repo: "example/demo", number: 7 }] } },
        requests: { legacy: { scope: "site/42/1", status: "attached", at: "2026-01-01T08:00:00Z", contextHash: "h", brief: { hash: "h", objective: "Ship", children } } },
    }));
    const before = (await readFile(join(path, "state.json"))).length;
    await store.update(() => {});
    const saved = await store.read();
    assert.deepEqual(saved.requests.legacy.brief.children, children.map(child => child.key));
    assert.equal(saved.requests.legacy.brief.objective, "Ship");
    assert.equal(saved.requests.legacy.contextHash, "h");
    assert.equal(saved.links["site/42/1"].origins, undefined);
    assert.deepEqual(saved.links["site/42/1"].sessions, [{ id: "one" }]);
    assert.ok((await readFile(join(path, "state.json"))).length < before / 5);
});

test("restores a masked session ID from the one attached launch receipt for its scope", async t => {
    const path = await directory(t);
    const scope = "cloud/42/7";
    const request = (id, sessionId, contextHash) => ({ requestId: id, scope, status: "attached", sessionId, contextHash, at: "2026-10-13T07:58:50.037Z" });
    await writeFile(join(path, "state.json"), JSON.stringify({
        version: 1, mappings: {},
        links: {
            [scope]: { sessions: [{ id: "******", contextHash: "b" }, { id: "kept-session" }], prs: [] },
            "cloud/42/8": { sessions: [{ id: "******" }], prs: [] },
        },
        requests: {
            r1: request("r1", "kept-session", "a"),
            r2: request("r2", "real-session", "b"),
            r3: request("r3", "other-session", "c"),
        },
    }));
    const saved = await new Store(path).read();
    assert.deepEqual(saved.links[scope].sessions.map(s => s.id), ["real-session", "kept-session"]);
    assert.equal(saved.links["cloud/42/8"].sessions[0].id, "******", "no receipt for that scope: left for the user to relink");
});

test("leaves masked records unchanged when an attached receipt matches both, regardless of array order", async t => {
    const path = await directory(t);
    const scope = "cloud/42/7";
    for (const contextHashes of [[undefined, "h"], ["h", "h"], [undefined, undefined]]) {
        const sessions = contextHashes.map((contextHash, i) => ({ id: "******", contextHash, title: `Record ${i}` }));
        for (const records of [sessions, [...sessions].reverse()]) {
            await writeFile(join(path, "state.json"), JSON.stringify({
                version: 1, mappings: {},
                links: { [scope]: { sessions: records, prs: [] } },
                requests: { r1: { scope, status: "attached", sessionId: "real-session", contextHash: "h" } },
            }));
            const saved = await new Store(path).read();
            assert.deepEqual(saved.links[scope].sessions, JSON.parse(JSON.stringify(records)));
        }
    }
});

// A writer in another process that holds write.lock with a blocked event loop: what a suspended or stalled owner
// looks like to every other writer. It prints how its own update ended.
function lockHolder(path, holdMs) {
    const code = `
        const { Store } = await import(${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)});
        try {
            await new Store(process.argv[1]).update(data => {
                const until = Date.now() + ${holdMs};
                while (Date.now() < until) {}
                data.mappings.owner = { id: "owner" };
            });
            console.log("saved");
        } catch (error) { console.log("failed: " + error.message); process.exitCode = 3; }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, path], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.done = new Promise(resolve => child.on("exit", code => resolve({ code, output: output.trim() })));
    return child;
}

async function ageLockOf(path, pid) {
    const lock = join(path, "write.lock");
    for (let i = 0; i < 200 && !(await readFile(lock, "utf8").catch(() => "")).startsWith(`${pid} `); i++) await sleep(10);
    const old = new Date(Date.now() - 31_000);
    await utimes(lock, old, old);
}

test("a writer that lost its lock fails loudly and never removes the new owner's lock", async t => {
    const path = await directory(t);
    await writeFile(join(path, "state.json"), JSON.stringify({ version: 1, mappings: {}, links: {}, requests: {} }));
    const owner = lockHolder(path, 1500);
    await ageLockOf(path, owner.pid);
    let lockWhileHeld = null;
    await new Store(path).update(async data => {
        // Stay inside the update until the original owner has finished, so it would be able to unlink this lock.
        const result = await owner.done;
        lockWhileHeld = await readFile(join(path, "write.lock"), "utf8").catch(() => null);
        data.mappings.stealer = { id: "stealer", owner: result };
    });
    const { code, output } = await owner.done;
    assert.equal(code, 3, `the slow owner must fail, not report success: ${output}`);
    assert.match(output, /lock was taken over/);
    assert.ok(lockWhileHeld?.startsWith(`${process.pid} `), "the losing owner left the new owner's lock in place");
    const saved = await new Store(path).read();
    assert.ok(saved.mappings.stealer, "the new owner's update is kept");
    assert.equal(saved.mappings.owner, undefined, "the losing owner's update did not overwrite it");
    await assert.rejects(readFile(join(path, "write.lock")), { code: "ENOENT" });
});

test("a live slow writer keeps its lock fresh so others wait instead of stealing it", async t => {
    const path = await directory(t);
    const slow = new Store(path, { heartbeatMs: 20 }), other = new Store(path);
    let entered;
    const inside = new Promise(resolve => { entered = resolve; });
    const first = slow.update(async data => {
        const old = new Date(Date.now() - 31_000);
        await utimes(join(path, "write.lock"), old, old);
        entered();
        await sleep(200);
        data.mappings.slow = { id: "slow" };
    });
    await inside;
    await sleep(80);
    assert.ok(Date.now() - (await stat(join(path, "write.lock"))).mtimeMs < 5_000, "the heartbeat refreshed the lock");
    await other.update(data => { data.mappings.other = { id: "other" }; });
    await first;
    const saved = await new Store(path).read();
    assert.ok(saved.mappings.slow && saved.mappings.other, "neither update is lost");
});

test("updates from one Store run in order without contending through the lock file", async t => {
    const path = await directory(t);
    const store = new Store(path);
    const order = [];
    await Promise.all(Array.from({ length: 16 }, (_, i) => store.update(async data => {
        order.push(i);
        await sleep(1);
        data.mappings[`m${i}`] = { id: String(i) };
    })));
    assert.deepEqual(order, Array.from({ length: 16 }, (_, i) => i));
    assert.equal(Object.keys((await store.read()).mappings).length, 16);
});

test("state is written as compact JSON", async t => {
    const path = await directory(t);
    await new Store(path).update(data => { data.mappings.a = { id: "a" }; });
    assert.ok(!(await readFile(join(path, "state.json"), "utf8")).includes("\n"));
});

const site = { id: "cloud-demo", name: "Demo", url: "https://demo.atlassian.net" };
const project = { id: "42", key: "DEMO", name: "Demo project" };
const issue = { id: "2", key: "DEMO-2", type: "Story", level: 0, summary: "Story", projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "" };
const prefix = "cloud-demo/42/";
const malformed = {
    "a request stored as null": data => { data.requests.bad = null; },
    "a request without a scope": data => { data.requests.bad = { nodeId: "2", status: "queued" }; },
    "the project link without a sessions array": data => { data.links[`${prefix}project`] = { prs: [] }; },
    "an issue link without a sessions array": data => { data.links[`${prefix}2`] = { sessions: "none", prs: [] }; },
    "a link stored as null": data => { data.links[`${prefix}2`] = null; },
    "a session record that is not an object": data => { data.links[`${prefix}2`] = { sessions: [null, 7], prs: [] }; },
    "a mapping stored as a string": data => { data.mappings[`${prefix}project`] = "copilot"; },
};

for (const [name, corrupt] of Object.entries(malformed)) {
    test(`a malformed state entry (${name}) is reported with its file and does not break the panel`, async t => {
        const path = await directory(t);
        const store = new Store(path);
        const gateway = {
            sites: async () => [site], projects: async () => [project],
            issues: async () => ({ issues: [issue], fetchedAt: new Date().toISOString() }),
            call: async name => {
                if (name === "list_repositories") return [];
                if (name === "get_sessions_status") return { sessions: [] };
                throw new Error(`Unexpected call ${name}`);
            },
        };
        const wb = new Workbench({ gateway, store, github: async () => null, send: async () => {}, instanceId: "malformed" });
        await wb.catalog();
        await wb.select({ cloudId: site.id, jiraProjectId: project.id });
        await wb.idle();
        const data = { version: 1, mappings: {}, links: { [`${prefix}project`]: { sessions: [{ id: "6f816e38-0000-4000-8000-000000000001" }], prs: [] } }, requests: {} };
        corrupt(data);
        await writeFile(join(path, "state.json"), JSON.stringify(data));
        const snapshot = await wb.snapshot();
        const notice = snapshot.ancestorWarnings.find(message => message.includes(join(path, "state.json")));
        assert.ok(notice, `the notice names the file: ${JSON.stringify(snapshot.ancestorWarnings)}`);
        await wb.refreshExecution({ source: "sessions" });
        await wb.refresh();
        assert.equal(wb.error, null);
        const again = await wb.snapshot();
        assert.equal(again.ancestorWarnings.filter(message => message === notice).length, 1, "reported once");
        await store.update(() => {});
        const raw = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
        assert.ok(Object.values(raw.requests).every(r => r && typeof r.scope === "string"));
        assert.ok(Object.values(raw.links).every(l => l && Array.isArray(l.sessions) && Array.isArray(l.prs) && l.sessions.every(s => s && typeof s === "object")));
        assert.ok(Object.values(raw.mappings).every(m => m && typeof m === "object"));
    });
}

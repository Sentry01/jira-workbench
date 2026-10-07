import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";

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

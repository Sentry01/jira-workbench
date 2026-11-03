import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../lib/cache.mjs";

async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), "jira-workbench-cache-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}

function shuffled(items, seed) {
    const list = [...items];
    let state = seed;
    for (let i = list.length - 1; i > 0; i--) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

test("eviction keeps the 8 newest dated working sets whatever the insertion order of an undated one", async t => {
    const path = await directory(t);
    const dated = Array.from({ length: 9 }, (_, i) => [`d${i + 1}`, { fetchedAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString() }]);
    const expected = dated.slice(1).map(([key]) => key).sort();
    for (let seed = 1; seed <= 60; seed++) {
        const order = shuffled([...dated, ["u", { fetchedAt: "not a date" }]], seed);
        await writeFile(join(path, "cache.json"), JSON.stringify({ version: 1, issues: Object.fromEntries(order) }));
        const cache = new Cache(path);
        await cache.update(() => {});
        const kept = Object.keys((await cache.read()).issues).sort();
        assert.deepEqual(kept, expected, `insertion order ${order.map(([key]) => key).join(",")}`);
    }
});

test("an update that changes nothing does not rewrite the cache file", async t => {
    const path = await directory(t);
    const cache = new Cache(path);
    await cache.update(data => { data.lastScope = { cloudId: "c", jiraProjectId: "1" }; });
    const before = await stat(join(path, "cache.json"));
    await cache.update(data => { data.lastScope = { cloudId: "c", jiraProjectId: "1" }; });
    const after = await stat(join(path, "cache.json"));
    assert.equal(after.ino, before.ino, "the file was not replaced");
    await cache.update(data => { data.lastScope = { cloudId: "c", jiraProjectId: "2" }; });
    assert.equal(JSON.parse(await readFile(join(path, "cache.json"), "utf8")).lastScope.jiraProjectId, "2");
});

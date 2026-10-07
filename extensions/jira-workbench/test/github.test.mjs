import test from "node:test";
import assert from "node:assert/strict";
import { readPr } from "../lib/github.mjs";

const fields = "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision";

function reader(result) {
    const calls = [];
    const run = async (exe, args, options) => {
        calls.push({ exe, args, options });
        return { stdout: JSON.stringify(result) };
    };
    return { run, calls };
}

test("PR reader runs gh with argv only and returns the verified PR", async () => {
    const { run, calls } = reader({ number: 4, url: "https://github.com/example/demo/pull/4", state: "OPEN" });
    const pr = await readPr("example/demo", 4, run);
    assert.equal(pr.number, 4);
    assert.equal(pr.state, "OPEN");
    assert.deepEqual(calls, [{
        exe: "gh", args: ["pr", "view", "4", "--repo", "example/demo", "--json", fields],
        options: { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    }]);
});

test("PR reader rejects malformed repositories and PR numbers before running gh", async () => {
    const { run, calls } = reader({ number: 4, url: "https://github.com/example/demo/pull/4" });
    for (const repo of [undefined, null, 42, ["example/demo"], "", "--malicious", "example", "example/demo/extra",
        "example/demo;rm", "https://github.com/example/demo"]) {
        await assert.rejects(readPr(repo, 4, run), /repository/i);
    }
    for (const number of [undefined, null, "4", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(readPr("example/demo", number, run), /number/i);
    }
    // A caller still passing the retired `kind` argument fails closed rather than reading something else.
    await assert.rejects(readPr("pr", "example/demo", 4, run), /repository/i);
    assert.equal(calls.length, 0);
});

test("PR reader refuses a result whose identity differs from the requested PR", async () => {
    for (const result of [
        { number: 5, url: "https://github.com/example/demo/pull/5" },
        { number: 4, url: "https://github.com/example/other/pull/4" },
        { number: 4, url: "https://github.com/example/demo/issues/4" },
        { number: "4", url: "https://github.com/example/demo/pull/4" },
        { number: 4 },
    ]) {
        await assert.rejects(readPr("example/demo", 4, reader(result).run), /identity/i);
    }
    const pr = await readPr("Example/Demo", 4, reader({ number: 4, url: "https://github.com/example/demo/pull/4" }).run);
    assert.equal(pr.number, 4, "GitHub repository names are case-insensitive");
});

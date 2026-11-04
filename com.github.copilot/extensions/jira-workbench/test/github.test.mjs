import test from "node:test";
import assert from "node:assert/strict";
import { PrReader, readPr } from "../lib/github.mjs";

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

test("PR reader keeps only the check fields the panel reads", async () => {
    const check = { __typename: "CheckRun", name: "build", conclusion: "SUCCESS", status: "COMPLETED", detailsUrl: "https://example.test/1", startedAt: "x", completedAt: "y", workflowName: "CI" };
    const context = { __typename: "StatusContext", context: "lint", state: "PENDING", targetUrl: "https://example.test/2", startedAt: "z" };
    const pr = await readPr("example/demo", 4, reader({ number: 4, url: "https://github.com/example/demo/pull/4", statusCheckRollup: [check, context] }).run);
    assert.deepEqual(pr.statusCheckRollup, [
        { name: "build", conclusion: "SUCCESS", status: "COMPLETED" },
        { context: "lint", state: "PENDING" },
    ]);
});

function fakeGh({ ms = 5, fail = () => false } = {}) {
    const calls = [];
    let active = 0, peak = 0;
    const run = async (exe, args) => {
        const number = Number(args[2]), repo = args[4];
        calls.push(`${repo}#${number}`);
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, ms));
        active--;
        if (fail(number)) throw new Error("gh failed");
        return { stdout: JSON.stringify({ number, url: `https://github.com/${repo}/pull/${number}`, state: "OPEN" }) };
    };
    return { run, calls, peak: () => peak };
}

test("PR reads share one gh call per repository and number, run at most 4 at a time and are reused for a minute", async () => {
    const gh = fakeGh();
    let now = 1_000;
    const prs = new PrReader({ run: gh.run, now: () => now });
    const wanted = Array.from({ length: 60 }, (_, i) => ["example/Demo", (i % 20) + 1]);
    const results = await Promise.all(wanted.map(([repo, number]) => prs.read(repo, number)));
    assert.equal(gh.calls.length, 20, "one call per distinct PR");
    assert.ok(gh.peak() <= 4, `peak concurrency ${gh.peak()}`);
    assert.ok(results.every((pr, i) => pr.number === wanted[i][1]));
    await prs.read("example/demo", 1);
    assert.equal(gh.calls.length, 20, "repository names are case-insensitive, and a recent result is reused");
    await prs.read("example/demo", 1, { fresh: true });
    assert.equal(gh.calls.length, 21, "an explicit refresh bypasses the recent result");
    now += 60_001;
    await prs.read("example/demo", 2);
    assert.equal(gh.calls.length, 22, "results expire after a minute");
});

test("a failed PR read is shared by concurrent callers but never reused", async () => {
    let failing = true;
    const gh = fakeGh({ fail: () => failing });
    const prs = new PrReader({ run: gh.run });
    const outcomes = await Promise.allSettled([prs.read("example/demo", 3), prs.read("example/demo", 3)]);
    assert.deepEqual(outcomes.map(o => o.status), ["rejected", "rejected"]);
    assert.equal(gh.calls.length, 1);
    failing = false;
    assert.equal((await prs.read("example/demo", 3)).number, 3);
    assert.equal(gh.calls.length, 2);
});

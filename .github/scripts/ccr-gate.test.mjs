import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT, REVIEWER, ccrStatus, run, verdictOf } from "./ccr-gate.mjs";
import { ACTIONS_BOT } from "./stack-gate.mjs";

const ACTIONS_BOT_USER = { id: ACTIONS_BOT, login: "github-actions[bot]" };

const HEAD = "1234567890abcdef";
const pull = (number = 7, sha = HEAD) => ({ number, state: "open", head: { sha } });
const overview = (verdict, issues = "**No open issues**") => `<!-- ccr-overview-v2 -->\n\n### \u{1F7E2} ${verdict}\n\nSummary.\n\n${issues}\n`;
const review = (body, commit = HEAD, login = REVIEWER, state = "COMMENTED") => ({ user: { login }, state, commit_id: commit, body });

test("the verdict comes from the overview heading", () => {
    assert.equal(verdictOf(overview("Approval recommended")), "Approval recommended");
    assert.equal(verdictOf(overview("Needs a closer look")), "Needs a closer look");
    assert.equal(verdictOf(overview("Changes recommended")), "Changes recommended");
    assert.equal(verdictOf("Approval recommended, but not in a heading"), null);
    assert.equal(verdictOf(undefined), null);
});

test("a clean review of the head commit passes", () => {
    const result = ccrStatus(pull(), [review(overview("Approval recommended"))]);
    assert.deepEqual(result, { state: "success", description: "Copilot code review of 1234567: approval recommended, no open issues." });
});

test("a clean review passes even when a resolved finding's title mentions open issues", () => {
    const resolved = "**No open issues**\n\n<details>\n<summary><strong>2 resolved since last review</strong></summary>\n\n"
        + "- [Reject approvals reporting 1 open issue](https://example.invalid/1)\n- [Count 3 previously missed issues](https://example.invalid/2)\n</details>";
    assert.equal(ccrStatus(pull(), [review(overview("Approval recommended", resolved))]).state, "success");
});

test("no review, or a review still to come for a new push, waits", () => {
    assert.deepEqual(ccrStatus(pull(), []), { state: "failure", description: "Waiting for Copilot code review." });
    const old = review(overview("Approval recommended"), "oldsha");
    assert.equal(ccrStatus(pull(), [old]).description, "Waiting for Copilot code review of 1234567.");
});

test("changes recommended, needs a closer look, open issues or an unknown format all fail", () => {
    const cases = [
        [overview("Changes recommended", "2 open issues"), "changes recommended"],
        [overview("Needs a closer look"), "needs a closer look"],
        [overview("Approval recommended", "1 open issue"), "approval recommended"],
        [overview("Approval recommended", "Earlier we said No open issues, but 1 open issue remains."), "approval recommended"],
        [overview("Approval recommended", "**No open issues**\n\n<details>\n<summary><strong>2 previously missed issues</strong></summary>\n</details>"), "approval recommended"],
        [overview("Approval recommended", "**No open issues**\n\n<summary><strong>1 open issue</strong></summary>"), "approval recommended"],
        ["Looks good to me.", "no recognized verdict"],
    ];
    for (const [body, said] of cases) {
        const result = ccrStatus(pull(), [review(body)]);
        assert.equal(result.state, "failure", body);
        assert.equal(result.description, `Copilot code review of 1234567: ${said}.`);
    }
});

test("only the latest Copilot review counts, and other reviewers do not", () => {
    const clean = review(overview("Approval recommended"));
    const dirty = review(overview("Changes recommended", "1 open issue"));
    assert.equal(ccrStatus(pull(), [dirty, clean]).state, "success");
    assert.equal(ccrStatus(pull(), [clean, dirty]).state, "failure");
    assert.equal(ccrStatus(pull(), [clean, review(overview("Changes recommended"), HEAD, "someone")]).state, "success");
    assert.equal(ccrStatus(pull(), [review(overview("Approval recommended"), HEAD, "someone")]).state, "failure");
    assert.equal(ccrStatus(pull(), [clean, review("", HEAD, REVIEWER, "PENDING")]).state, "success");
});

function fakeApi(responses) {
    const posted = [];
    const lookup = path => {
        if (!(path in responses)) throw new Error(`unexpected request: ${path}`);
        return structuredClone(responses[path]);
    };
    return {
        posted,
        get: async path => lookup(path),
        list: async path => lookup(path) ?? [],
        post: async (path, body) => { posted.push({ sha: path.replace("statuses/", ""), ...body }); return {}; },
    };
}

test("every run checks every open pull request, and posts a status only when it changes", async () => {
    const api = fakeApi({
        "pulls?state=open&per_page=100": [{ number: 1 }, { number: 2 }, { number: 3 }],
        "pulls/1": pull(1, "aaa"),
        "pulls/2": pull(2, "bbb"),
        "pulls/3": { ...pull(3, "ccc"), state: "closed" },
        "commits/aaa/pulls?per_page=100": [],
        "commits/bbb/pulls?per_page=100": [{ number: 2, state: "open", head: { sha: "bbb" } }],
        "pulls/1/reviews?per_page=100": [review(overview("Approval recommended"), "aaa")],
        "pulls/2/reviews?per_page=100": [review(overview("Changes recommended", "1 open issue"), "bbb")],
        "commits/aaa/statuses?per_page=100": [],
        "commits/bbb/statuses?per_page=100": [{ context: CONTEXT, state: "failure", description: "Copilot code review of bbb: changes recommended.", creator: ACTIONS_BOT_USER }],
    });
    await run(api, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state, p.context]), [["aaa", "success", CONTEXT]]);
});

test("pull requests that share a head commit pass only if every one of them has a clean review", async () => {
    const responses = {
        "pulls/1": pull(1, "aaa"),
        "pulls/2": pull(2, "aaa"),
        "commits/aaa/pulls?per_page=100": [
            { number: 1, state: "open", head: { sha: "aaa" } },
            { number: 2, state: "open", head: { sha: "aaa" } },
            { number: 3, state: "closed", head: { sha: "aaa" } },
        ],
        "pulls/1/reviews?per_page=100": [review(overview("Approval recommended"), "aaa")],
        "pulls/2/reviews?per_page=100": [],
        "commits/aaa/statuses?per_page=100": [],
        "pulls?state=open&per_page=100": [{ number: 1 }, { number: 2 }],
    };
    let api = fakeApi(responses);
    await run(api, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state, p.description]), [["aaa", "failure", "#2: Waiting for Copilot code review."]]);
    responses["pulls/2/reviews?per_page=100"] = [review(overview("Approval recommended"), "aaa")];
    api = fakeApi(responses);
    await run(api, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["aaa", "success"]]);
});

test("a failed read blocks that commit, the rest are still checked, and the run fails", async () => {
    const clean = { context: CONTEXT, state: "success", description: "Copilot code review of aaa: approval recommended, no open issues.", creator: ACTIONS_BOT_USER };
    const api = fakeApi({
        "pulls?state=open&per_page=100": [{ number: 1 }, { number: 2 }],
        "pulls/1": pull(1, "aaa"),
        "pulls/2": pull(2, "bbb"),
        "commits/aaa/pulls?per_page=100": [],
        "commits/bbb/pulls?per_page=100": [],
        "commits/aaa/statuses?per_page=100": [clean],
        "commits/bbb/statuses?per_page=100": [],
        "pulls/2/reviews?per_page=100": [review(overview("Approval recommended"), "bbb")],
    });
    await assert.rejects(run(api, { log: () => {} }), /CCR gate failed for #1: unexpected request: pulls\/1\/reviews/);
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["aaa", "failure"], ["bbb", "success"]]);
    assert.match(api.posted[0].description, /^Could not check Copilot code review/);
});

test("a failed read of a pull request still blocks the head commit it was listed with", async () => {
    const clean = { context: CONTEXT, state: "success", description: "Copilot code review of aaa: approval recommended, no open issues.", creator: ACTIONS_BOT_USER };
    const api = fakeApi({
        "pulls?state=open&per_page=100": [{ number: 1, head: { sha: "aaa" } }],
        "commits/aaa/statuses?per_page=100": [clean],
    });
    await assert.rejects(run(api, { log: () => {} }), /CCR gate failed for #1: unexpected request: pulls\/1$/);
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["aaa", "failure"]]);
});

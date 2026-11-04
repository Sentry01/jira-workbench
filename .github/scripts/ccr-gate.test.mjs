import test from "node:test";
import assert from "node:assert/strict";
import { CONTEXT, REVIEWER, ccrStatus, pullNumbers, run, verdictOf } from "./ccr-gate.mjs";

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

test("an event checks its pull request; the schedule and an empty manual run check all open ones", async () => {
    const api = fakeApi({ "pulls?state=open&per_page=100": [{ number: 1 }, { number: 2 }] });
    assert.deepEqual(await pullNumbers(api, "pull_request_review", { pull_request: { number: 9 } }), [9]);
    assert.deepEqual(await pullNumbers(api, "workflow_dispatch", {}, "9"), [9]);
    assert.deepEqual(await pullNumbers(api, "workflow_dispatch", {}, ""), [1, 2]);
    assert.deepEqual(await pullNumbers(api, "schedule", {}), [1, 2]);
    await assert.rejects(pullNumbers(api, "workflow_dispatch", {}, "9; true"), /not a pull request number/);
});

test("a run posts the status only when it changes, and skips closed pull requests", async () => {
    const api = fakeApi({
        "pulls?state=open&per_page=100": [{ number: 1 }, { number: 2 }, { number: 3 }],
        "pulls/1": pull(1, "aaa"),
        "pulls/2": pull(2, "bbb"),
        "pulls/3": { ...pull(3, "ccc"), state: "closed" },
        "pulls/1/reviews?per_page=100": [review(overview("Approval recommended"), "aaa")],
        "pulls/2/reviews?per_page=100": [review(overview("Changes recommended", "1 open issue"), "bbb")],
        "commits/aaa/status?per_page=100": { statuses: [] },
        "commits/bbb/status?per_page=100": {
            statuses: [{ context: CONTEXT, state: "failure", description: "Copilot code review of bbb: changes recommended." }],
        },
    });
    await run(api, "schedule", {}, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state, p.context]), [["aaa", "success", CONTEXT]]);
});

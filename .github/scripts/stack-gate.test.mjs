import test from "node:test";
import assert from "node:assert/strict";
import {
    CONTEXT, changesRequestedBy, checkStates, evaluateStack, memberProblems, requiredChecks, resolve, unresolvedThreads, verdict,
} from "./stack-gate.mjs";

const ACTIONS = 15368;
const protectedBranch = (...contexts) => ({
    protected: true,
    protection: { enabled: true, required_status_checks: { contexts, checks: contexts.map(context => ({ context, app_id: ACTIONS })) } },
});
const run = (name, conclusion, extra = {}) => ({ id: 1, name, status: "completed", conclusion, app: { id: ACTIONS }, ...extra });

test("required checks come from branch protection and rulesets, without the gate itself", () => {
    const branch = protectedBranch("Unit tests", CONTEXT);
    const rules = [
        { type: "deletion" },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Lint", integration_id: -1 }, { context: CONTEXT }] } },
    ];
    assert.deepEqual(requiredChecks(branch, rules), [
        { context: "Unit tests", appId: ACTIONS },
        { context: "Lint", appId: null },
    ]);
});

test("required contexts without app pins accept any source", () => {
    const branch = { protected: true, protection: { required_status_checks: { contexts: ["Build"] } } };
    assert.deepEqual(requiredChecks(branch), [{ context: "Build", appId: null }]);
    assert.deepEqual(requiredChecks({ protected: false }), []);
});

test("a required check passes on success, neutral or skipped, and uses the latest run", () => {
    const required = [{ context: "A", appId: ACTIONS }, { context: "B", appId: ACTIONS }, { context: "C", appId: ACTIONS }];
    const runs = [
        run("A", "skipped"),
        run("B", "failure", { id: 1 }), run("B", "success", { id: 2 }),
        run("C", "success", { id: 1 }), run("C", "failure", { id: 2 }),
    ];
    assert.deepEqual(checkStates(required, runs).map(c => c.state), ["pass", "pass", "fail"]);
});

test("a running, missing or wrong-app check is pending, not passing", () => {
    const required = [{ context: "A", appId: ACTIONS }, { context: "B", appId: ACTIONS }, { context: "C", appId: ACTIONS }];
    const runs = [run("A", null, { status: "in_progress" }), run("C", "success", { app: { id: 999 } })];
    assert.deepEqual(checkStates(required, runs).map(c => c.state), ["pending", "pending", "pending"]);
});

test("a commit status satisfies only an unpinned required check", () => {
    const statuses = [{ context: "A", state: "success" }, { context: "B", state: "success" }, { context: "C", state: "error" }];
    const required = [{ context: "A", appId: null }, { context: "B", appId: ACTIONS }, { context: "C", appId: null }];
    assert.deepEqual(checkStates(required, [], statuses).map(c => c.state), ["pass", "pending", "fail"]);
});

test("a reviewer blocks only while their latest verdict requests changes", () => {
    const reviews = [
        { user: { login: "ann" }, state: "CHANGES_REQUESTED" },
        { user: { login: "ann" }, state: "COMMENTED" },
        { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
        { user: { login: "bob" }, state: "APPROVED" },
        { user: { login: "cat" }, state: "CHANGES_REQUESTED" },
        { user: { login: "cat" }, state: "DISMISSED" },
    ];
    assert.deepEqual(changesRequestedBy(reviews), ["ann"]);
});

test("a member lists every reason it cannot merge", () => {
    const required = [{ context: "A", appId: ACTIONS }, { context: "B", appId: ACTIONS }];
    const member = memberProblems({
        pull: { number: 7, draft: true },
        required,
        checkRuns: [run("A", "failure")],
        statuses: [],
        reviews: [{ user: { login: "ann" }, state: "CHANGES_REQUESTED" }],
    });
    assert.deepEqual(member.problems, ["draft", "changes requested", "checks failing", "checks pending"]);
    assert.deepEqual(member.details, ["is a draft", "changes requested by ann", "failing: A", "waiting for: B"]);
});

test("unresolved review threads make a member not ready, and say how many", () => {
    const base = { pull: { number: 19, draft: false }, required: [], checkRuns: [], statuses: [], reviews: [] };
    assert.deepEqual(memberProblems({ ...base, unresolvedThreads: 0 }).problems, []);
    assert.deepEqual(memberProblems({ ...base, unresolvedThreads: 1 }).problems, ["1 unresolved thread"]);
    assert.deepEqual(memberProblems({ ...base, unresolvedThreads: 2 }).problems, ["2 unresolved threads"]);
});

test("the verdict is success only when every member is ready", () => {
    assert.deepEqual(verdict(26, [{ number: 1, problems: [] }, { number: 2, problems: [] }]), {
        state: "success", description: "All 2 open pull requests in stack #26 are ready.",
    });
    assert.equal(verdict(26, [{ number: 1, problems: [] }]).description, "The open pull request in stack #26 is ready.");
    assert.deepEqual(verdict(26, [{ number: 1, problems: [] }, { number: 2, problems: ["draft"] }, { number: 3, problems: ["checks pending"] }]), {
        state: "failure", description: "Stack #26 not ready: #2 (draft), #3 (checks pending)",
    });
});

test("a long failure description is shortened to fit a commit status", () => {
    const members = Array.from({ length: 12 }, (_, i) => ({ number: 100 + i, problems: ["changes requested", "checks failing"] }));
    const { description } = verdict(26, members);
    assert.ok(description.length <= 140, description);
    assert.match(description, /^Stack #26 not ready: #100 .* and \d+ more$/);
});

// A fake API over fixed responses that records the statuses it is asked to post.
// Review threads come from responses["threads/<number>"]: a list of pages, each a list of isResolved values.
function fakeApi(responses) {
    const posted = [];
    const lookup = path => {
        if (!(path in responses)) throw new Error(`unexpected request: ${path}`);
        return structuredClone(responses[path]);
    };
    return {
        posted,
        get: async path => lookup(path),
        list: async (path, key) => { const data = lookup(path); return key ? data?.[key] ?? [] : data ?? []; },
        post: async (path, body) => { posted.push({ sha: path.replace("statuses/", ""), ...body }); return {}; },
        graphql: async (query, { owner, name, number, cursor }) => {
            assert.deepEqual([owner, name], ["octo", "demo"]);
            const pages = responses[`threads/${number}`] ?? [[]];
            const page = cursor ? Number(cursor) : 0;
            const pageInfo = { hasNextPage: page + 1 < pages.length, endCursor: String(page + 1) };
            return { repository: { pullRequest: { reviewThreads: { nodes: pages[page].map(isResolved => ({ isResolved })), pageInfo } } } };
        },
        repository: "octo/demo",
    };
}

const pull = (number, sha, extra = {}) => ({ number, state: "open", merged_at: null, draft: false, head: { sha }, ...extra });
const memberResponses = (number, sha, runs, reviews = []) => ({
    [`pulls/${number}`]: pull(number, sha),
    [`commits/${sha}/check-runs?filter=latest&per_page=100`]: { check_runs: runs },
    [`commits/${sha}/status?per_page=100`]: { statuses: [{ context: CONTEXT, state: "failure" }] },
    [`pulls/${number}/reviews?per_page=100`]: reviews,
});
const stackResponses = members => ({
    "stacks/26": { number: 26, base: { ref: "main" }, pull_requests: members.map(([number]) => ({ number })) },
    "branches/main": protectedBranch("Tests", CONTEXT),
    "rules/branches/main?per_page=100": [],
    ...Object.assign({}, ...members.map(args => memberResponses(...args))),
});

test("a ready stack posts success to every open member, ignoring its own failing gate status", async () => {
    const api = fakeApi(stackResponses([[19, "aaa", [run("Tests", "success")]], [20, "bbb", [run("Tests", "success")]]]));
    const result = await evaluateStack(api, 26, { log: () => {} });
    assert.equal(result.state, "success");
    assert.deepEqual(api.posted.map(p => [p.sha, p.state, p.context]), [["aaa", "success", CONTEXT], ["bbb", "success", CONTEXT]]);
});

test("one member that is not ready fails the gate on every member, including the ready ones", async () => {
    const responses = stackResponses([
        [19, "aaa", [run("Tests", "success")]],
        [20, "bbb", [run("Tests", "failure")]],
        [22, "ccc", [run("Tests", "success")], [{ user: { login: "ann" }, state: "CHANGES_REQUESTED" }]],
    ]);
    const api = fakeApi(responses);
    await evaluateStack(api, 26, { log: () => {} });
    assert.deepEqual(api.posted.map(p => p.state), ["failure", "failure", "failure"]);
    assert.equal(api.posted[0].description, "Stack #26 not ready: #20 (checks failing), #22 (changes requested)");
});

test("unresolved threads on one member fail the gate on every member, naming the pull request and count", async () => {
    const responses = stackResponses([[19, "aaa", [run("Tests", "success")]], [20, "bbb", [run("Tests", "success")]]]);
    responses["threads/19"] = [[false, true, false]];
    responses["threads/20"] = [[true]];
    const api = fakeApi(responses);
    await evaluateStack(api, 26, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["aaa", "failure"], ["bbb", "failure"]]);
    assert.equal(api.posted[0].description, "Stack #26 not ready: #19 (2 unresolved threads)");
});

test("unresolved threads are counted across every page", async () => {
    const api = fakeApi({ "threads/19": [[false, true], [false], [true, false]] });
    assert.equal(await unresolvedThreads(api, 19), 3);
});

test("a status that has not changed is not posted again", async () => {
    const responses = stackResponses([[19, "aaa", [run("Tests", "success")]], [20, "bbb", [run("Tests", "success")]]]);
    const ready = { context: CONTEXT, state: "success", description: "All 2 open pull requests in stack #26 are ready." };
    responses["commits/aaa/status?per_page=100"] = { statuses: [ready] };
    const api = fakeApi(responses);
    await evaluateStack(api, 26, { log: () => {} });
    assert.deepEqual(api.posted.map(p => p.sha), ["bbb"]);
});

test("merged and closed members are skipped, and get no status", async () => {
    const responses = stackResponses([[19, "aaa", []], [20, "bbb", [run("Tests", "success")]]]);
    responses["pulls/19"] = pull(19, "aaa", { state: "closed", merged_at: "2026-11-04T00:00:00Z" });
    const api = fakeApi(responses);
    await evaluateStack(api, 26, { log: () => {} });
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["bbb", "success"]]);
});

test("hidden branch protection fails closed", async () => {
    const responses = stackResponses([[19, "aaa", [run("Tests", "success")]]]);
    responses["branches/main"] = { protected: true };
    const api = fakeApi(responses);
    await evaluateStack(api, 26, { log: () => {} });
    assert.equal(api.posted[0].state, "failure");
    assert.match(api.posted[0].description, /Cannot read the checks main requires/);
});

test("a dissolved stack posts nothing", async () => {
    const api = fakeApi({ "stacks/26": null });
    assert.equal(await evaluateStack(api, 26, { log: () => {} }), null);
    assert.deepEqual(api.posted, []);
});

test("a pull request outside any stack gets success at once", async () => {
    const api = fakeApi({ "pulls/5": pull(5, "eee"), "stacks?pull_request=5": [], "commits/eee/status?per_page=100": { statuses: [] } });
    const stacks = await resolve(api, "pull_request_target", { pull_request: { number: 5 } }, { log: () => {} });
    assert.deepEqual(stacks, []);
    assert.deepEqual(api.posted.map(p => [p.sha, p.state, p.description]), [["eee", "success", "Not in a stack."]]);
});

test("a stacked pull request resolves to its stack without posting", async () => {
    const api = fakeApi({ "pulls/22": pull(22, "ccc", { stack: { number: 26 } }) });
    assert.deepEqual(await resolve(api, "pull_request_review", { pull_request: { number: 22 } }, { log: () => {} }), [26]);
    assert.deepEqual(api.posted, []);
});

test("a closed pull request still refreshes the stack its event named", async () => {
    const api = fakeApi({ "pulls/19": pull(19, "aaa", { state: "closed" }), "stacks?pull_request=19": [] });
    const event = { pull_request: { number: 19, stack: { number: 26 } } };
    assert.deepEqual(await resolve(api, "pull_request_target", event, { log: () => {} }), [26]);
    assert.deepEqual(api.posted, []);
});

test("a CI run without linked pull requests is matched through its commit", async () => {
    const api = fakeApi({
        "commits/fff/pulls?per_page=100": [
            { number: 30, state: "open", head: { sha: "fff" } },
            { number: 31, state: "closed", head: { sha: "fff" } },
            { number: 32, state: "open", head: { sha: "other" } },
        ],
        "pulls/30": pull(30, "fff"),
        "stacks?pull_request=30": [{ number: 40 }],
    });
    const event = { workflow_run: { head_sha: "fff", pull_requests: [] } };
    assert.deepEqual(await resolve(api, "workflow_run", event, { log: () => {} }), [40]);
});

test("a manual run refreshes the stack of the pull request it names", async () => {
    const api = fakeApi({ "pulls/22": pull(22, "ccc", { stack: { number: 26 } }) });
    assert.deepEqual(await resolve(api, "workflow_dispatch", {}, { input: "22", log: () => {} }), [26]);
});

test("the schedule sweeps every open pull request", async () => {
    const api = fakeApi({
        "pulls?state=open&per_page=100": [pull(15, "ddd"), pull(16, "eee"), pull(19, "aaa", { stack: { number: 26 } }), pull(20, "bbb", { stack: { number: 26 } })],
        "stacks?pull_request=15": [],
        "stacks?pull_request=16": [],
        "commits/ddd/status?per_page=100": { statuses: [] },
        "commits/eee/status?per_page=100": { statuses: [{ context: CONTEXT, state: "success", description: "Not in a stack." }] },
    });
    assert.deepEqual(await resolve(api, "schedule", {}, { log: () => {} }), [26]);
    assert.deepEqual(api.posted.map(p => [p.sha, p.state]), [["ddd", "success"]]);
});

test("a manual run without a number sweeps, and rejects anything but a number", async () => {
    const api = fakeApi({ "pulls?state=open&per_page=100": [pull(19, "aaa", { stack: { number: 26 } })] });
    assert.deepEqual(await resolve(api, "workflow_dispatch", {}, { input: "", log: () => {} }), [26]);
    await assert.rejects(resolve(api, "workflow_dispatch", {}, { input: "22; true", log: () => {} }), /not a pull request number/);
});

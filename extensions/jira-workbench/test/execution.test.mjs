import test from "node:test";
import assert from "node:assert/strict";
import * as execution from "../lib/execution.mjs";

const { deriveExecution, dependencyWarnings } = execution;
const mapping = { id: "fixture-repository-project", repo: "example/workbench" };
const issue = (overrides = {}) => ({
    id: "fixture-issue", key: "FIXTURE-1", status: "To Do",
    category: "new", dependencies: [], level: 0, ...overrides,
});
const session = (overrides = {}) => ({
    id: "fixture-session", name: "Existing work", activity: "idle",
    awaitingInput: null, awaitingPlan: false, interrupted: false, ...overrides,
});
const pr = (overrides = {}) => ({
    repo: "example/workbench", number: 17, url: "https://github.com/example/workbench/pull/17",
    state: "OPEN", isDraft: false, statusCheckRollup: [], ...overrides,
});
const classify = (overrides = {}) => deriveExecution({ issue: issue(), mapping, ...overrides });
const kinds = result => result.signals.map(signal => signal.kind);
const hasViews = (result, expected) => {
    assert.deepEqual([...result.views].sort(), [...expected].sort());
    assert.equal(new Set(result.views).size, result.views.length);
};

test("exports the pure execution classifier and dependency warning helper", () => {
    assert.deepEqual(Object.keys(execution).sort(), ["dependencyWarnings", "deriveExecution"]);
    assert.equal(typeof execution.deriveExecution, "function");
    assert.equal(typeof execution.dependencyWarnings, "function");
});

test("unstarted mapped work is advisory available without inventing missing sources", () => {
    const result = classify();
    assert.deepEqual(Object.keys(result).sort(), ["nodeId", "views", "signals", "reasons", "primary", "rank"].sort());
    assert.equal(result.nodeId, issue().id);
    hasViews(result, ["all", "available"]);
    assert.deepEqual(result.primary, { kind: "prepare", label: "Prepare implementation", mode: "autopilot" });
    assert.ok(Number.isFinite(result.rank));
    assert.ok(result.reasons.length > 0);
    assert.ok(result.reasons.every(reason => typeof reason === "string"));
    assert.ok(!kinds(result).some(kind => /unknown|stale/.test(kind)));
    assert.match(result.reasons.join(" "), /advisory/i);
});

test("default arguments require choosing a real repository mapping", () => {
    const result = deriveExecution({ issue: issue() });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Choose repository" });
    hasViews(result, ["all", "needs-me"]);
    assert.ok(kinds(result).includes("missing_mapping"));
});

for (const level of [-1, 0, 1, 2, undefined]) {
    test(`missing criteria and dependencies allow a review brief at hierarchy level ${level}`, () => {
        const result = classify({ issue: issue({ id: `fixture-level-${level}`, level, dependencies: undefined }) });
        assert.equal(result.nodeId, `fixture-level-${level}`);
        assert.deepEqual(result.primary, {
            kind: "prepare", label: level > 0 ? "Prepare plan" : "Prepare implementation",
            mode: level > 0 ? "plan" : "autopilot",
        });
        hasViews(result, ["all", "available"]);
        assert.match(result.reasons.join(" "), /review brief/i);
    });
}

test("a synthetic project without a Jira category prepares a plan rather than refreshing Jira", () => {
    const result = classify({ issue: { id: "project", level: 2 } });
    assert.equal(result.nodeId, "project");
    assert.deepEqual(result.primary, { kind: "prepare", label: "Prepare plan", mode: "plan" });
    hasViews(result, ["all", "available"]);
    assert.ok(!kinds(result).includes("jira_unknown"));
});

test("an actual Jira issue without a category still requires refreshing Jira", () => {
    const result = classify({ issue: issue({ category: undefined }) });
    assert.equal(result.primary.kind, "refresh");
    assert.ok(kinds(result).includes("jira_unknown"));
});

test("a merged PR does not invent a Jira status mismatch for the synthetic project", () => {
    const result = classify({ issue: { id: "project", level: 2 }, trace: { prs: [pr({ state: "MERGED" })] } });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect trace" });
    hasViews(result, ["all"]);
    assert.ok(kinds(result).includes("pr_merged"));
    assert.ok(!kinds(result).includes("jira_unknown"));
    assert.ok(!kinds(result).includes("jira_mismatch"));
});

test("pending input wins while preserving simultaneous plan, failure, queue, running and PR signals", () => {
    const sessions = [
        session({ id: "fixture-busy", activity: "busy", interrupted: true, error: "Execution failed" }),
        session({ id: "fixture-plan", awaitingPlan: true }),
        session({ id: "fixture-unknown", activity: "unknown" }),
        session({
            id: "fixture-question",
            awaitingInput: { question: "Which approach?", choices: ["A", "B"], requestId: "fixture-request" },
        }),
    ];
    for (const ordered of [sessions, [...sessions].reverse()]) {
        const result = classify({ trace: { sessions: ordered, prs: [pr()] }, requests: [{ status: "queued" }] });
        assert.deepEqual(result.primary, { kind: "open_session", label: "Answer question", sessionId: "fixture-question" });
        hasViews(result, ["all", "needs-me", "running", "prs"]);
        for (const kind of ["awaiting_input", "awaiting_plan", "interrupted", "session_error", "session_busy", "pr_open", "request_queued", "session_unknown"])
            assert.ok(kinds(result).includes(kind), kind);
        assert.match(result.reasons.join(" "), /Which approach\?/);
    }
});

test("plan approval outranks failures and running work", () => {
    const result = classify({
        trace: { sessions: [session({ awaitingPlan: true, activity: "busy", error: "Build failed" })], prs: [pr()] },
    });
    assert.deepEqual(result.primary, { kind: "open_session", label: "Review plan", sessionId: session().id });
    hasViews(result, ["all", "needs-me", "running", "prs"]);
});

for (const [property, value, kind, label] of [
    ["interrupted", true, "interrupted", "Inspect interruption"],
    ["error", "Build failed", "session_error", "Inspect failure"],
]) {
    test(`observed ${kind} outranks an open PR and queued work`, () => {
        const result = classify({
            trace: { sessions: [session({ [property]: value })], prs: [pr()] },
            requests: [{ status: "queued" }],
        });
        assert.deepEqual(result.primary, { kind: "open_session", label, sessionId: session().id });
        assert.ok(kinds(result).includes(kind));
        hasViews(result, ["all", "needs-me", "running", "prs"]);
    });
}

test("failed requests preserve their reason instead of offering another launch", () => {
    const result = classify({
        requests: [{ status: "failed", error: "Launch refused" }, { status: "queued" }],
        trace: { prs: [pr()] },
    });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect failed request" });
    assert.match(result.reasons.join(" "), /Launch refused/);
    hasViews(result, ["all", "needs-me", "running", "prs"]);
});

test("a failed request without an error still requires attention", () => {
    const result = classify({ requests: [{ status: "failed" }] });
    assert.equal(result.primary.label, "Inspect failed request");
    hasViews(result, ["all", "needs-me"]);
});

test("queued work is visible as running and cannot start duplicate work", () => {
    const result = classify({ requests: [{ status: "queued" }, { status: "queued" }] });
    hasViews(result, ["all", "running"]);
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect queued work" });
});

test("an attached receipt without its linked session is unknown rather than available", () => {
    const result = classify({ requests: [{ status: "attached" }] });
    hasViews(result, ["all", "needs-me"]);
    assert.equal(result.primary.kind, "refresh");
    assert.ok(kinds(result).includes("session_unknown"));
});

test("an attached receipt with a known session does not imply a queued launch", () => {
    const result = classify({ trace: { sessions: [session()] }, requests: [{ status: "attached" }] });
    assert.equal(result.primary.kind, "open_session");
    hasViews(result, ["all"]);
    assert.ok(!kinds(result).includes("request_queued"));
});

for (const [description, failedAt, attachedAt] of [
    ["ISO timestamps", "2026-01-01T08:00:00Z", "2026-01-01T08:01:00Z"],
    ["timestamp offsets", "2026-01-01T10:00:00+02:00", "2026-01-01T08:01:00Z"],
]) {
    test(`a later attached launch supersedes historical failure using ${description}`, () => {
        const attempts = [
            { status: "failed", error: "Historical launch failure", at: failedAt },
            { status: "attached", at: attachedAt },
        ];
        for (const requests of [attempts, [...attempts].reverse()]) {
            const before = structuredClone(requests);
            const result = classify({ requests: deepFreeze(requests), trace: { sessions: [session()] } });
            assert.equal(result.primary.kind, "open_session");
            hasViews(result, ["all"]);
            assert.match(result.reasons.join(" "), /Historical launch failure/);
            assert.match(result.signals.find(signal => signal.kind === "request_failed").reason, /superseded/i);
            assert.deepEqual(requests, before);
        }
    });
}

for (const [description, failedAt, attachedAt] of [
    ["missing timestamps", undefined, undefined],
    ["equal timestamps", "2026-01-01T08:00:00Z", "2026-01-01T08:00:00Z"],
    ["invalid timestamp", "not-a-timestamp", "2026-01-01T08:01:00Z"],
    ["one missing timestamp", "2026-01-01T08:00:00Z", undefined],
]) {
    test(`request insertion order resolves ${description} without hiding a newer failure`, () => {
        const failed = { status: "failed", error: "Launch failed", at: failedAt };
        const attached = { status: "attached", at: attachedAt };
        const resolved = classify({ requests: [failed, attached], trace: { sessions: [session()] } });
        assert.equal(resolved.primary.kind, "open_session");
        hasViews(resolved, ["all"]);
        const unresolved = classify({ requests: [attached, failed], trace: { sessions: [session()] } });
        assert.equal(unresolved.primary.label, "Inspect failed request");
        hasViews(unresolved, ["all", "needs-me"]);
        assert.doesNotMatch(unresolved.signals.find(signal => signal.kind === "request_failed").reason, /superseded/i);
    });
}

test("a new failure after successful attachment requires attention regardless of array order", () => {
    const attempts = [
        { status: "failed", error: "Historical failure", at: "2026-01-01T08:00:00Z" },
        { status: "attached", at: "2026-01-01T08:01:00Z" },
        { status: "failed", error: "New failure", at: "2026-01-01T08:02:00Z" },
    ];
    for (const requests of [attempts, [...attempts].reverse()]) {
        const result = classify({ requests, trace: { sessions: [session()] } });
        assert.equal(result.primary.label, "Inspect failed request");
        hasViews(result, ["all", "needs-me"]);
        const failures = result.signals.filter(signal => signal.kind === "request_failed");
        assert.equal(failures.length, 2);
        assert.match(failures.find(signal => signal.reason.includes("Historical failure")).reason, /superseded/i);
        assert.doesNotMatch(failures.find(signal => signal.reason.includes("New failure")).reason, /superseded/i);
    }
});

for (const queuedAt of ["2026-01-01T08:00:30Z", "2026-01-01T08:02:00Z"]) {
    test(`queued request at ${queuedAt} survives a later successful retry of a failed launch`, () => {
        const attempts = [
            { status: "failed", error: "Historical failure", at: "2026-01-01T08:00:00Z" },
            { status: "queued", at: queuedAt },
            { status: "attached", at: "2026-01-01T08:01:00Z" },
        ];
        for (const requests of [attempts, [...attempts].reverse()]) {
            const result = classify({ requests, trace: { sessions: [session()] }, now: Date.parse("2026-01-01T08:05:00Z") });
            assert.equal(result.primary.label, "Inspect queued work");
            hasViews(result, ["all", "running"]);
            assert.ok(kinds(result).includes("request_queued"));
        }
    });
}

test("a superseded failure without a known attached session still requires refreshing the trace", () => {
    const result = classify({ requests: [{ status: "failed" }, { status: "attached" }] });
    assert.equal(result.primary.kind, "refresh");
    hasViews(result, ["all", "needs-me"]);
    assert.ok(kinds(result).includes("session_unknown"));
    assert.match(result.signals.find(signal => signal.kind === "request_failed").reason, /superseded/i);
});

test("resolving a launch failure does not suppress an independent session failure", () => {
    const result = classify({
        requests: [{ status: "failed" }, { status: "attached" }],
        trace: { sessions: [session({ error: "Session execution failed" })] },
    });
    assert.equal(result.primary.label, "Inspect failure");
    hasViews(result, ["all", "needs-me"]);
    assert.ok(kinds(result).includes("session_error"));
    assert.match(result.signals.find(signal => signal.kind === "request_failed").reason, /superseded/i);
});

test("fresh active work opens the existing session", () => {
    const result = classify({ trace: { sessions: [session({ activity: "busy" })] } });
    hasViews(result, ["all", "running"]);
    assert.deepEqual(result.primary, { kind: "open_session", label: "Open session", sessionId: session().id });
});

test("idle plus an open non-draft PR means Review PR, never Done", () => {
    const result = classify({ trace: { sessions: [session()], prs: [pr()] } });
    assert.deepEqual(result.primary, { kind: "open_pr", label: "Review PR", repo: pr().repo, number: pr().number });
    hasViews(result, ["all", "needs-me", "prs"]);
    assert.ok(kinds(result).includes("session_idle"));
    assert.doesNotMatch(result.primary.label, /done|start/i);
});

test("an open PR takes precedence without hiding an active session", () => {
    const result = classify({ trace: { sessions: [session({ activity: "busy" })], prs: [pr()] } });
    assert.equal(result.primary.label, "Review PR");
    hasViews(result, ["all", "needs-me", "running", "prs"]);
});

test("idle linked work is followed up, not offered as a fresh start", () => {
    const result = classify({ trace: { sessions: [session()] } });
    assert.equal(result.primary.kind, "open_session");
    assert.equal(result.primary.sessionId, session().id);
    hasViews(result, ["all"]);
});

test("a draft PR opens existing work without implying review readiness", () => {
    const result = classify({ trace: { prs: [pr({ isDraft: true })] } });
    assert.deepEqual(result.primary, { kind: "open_pr", label: "Open draft PR", repo: pr().repo, number: pr().number });
    hasViews(result, ["all"]);
    assert.ok(kinds(result).includes("pr_draft"));
});

test("merged delivery with unfinished Jira is an informational mismatch to inspect", () => {
    const result = classify({ trace: { sessions: [session()], prs: [pr({ state: "MERGED" })] } });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect trace" });
    hasViews(result, ["all"]);
    assert.ok(kinds(result).includes("jira_mismatch"));
    assert.match(result.reasons.join(" "), /merged.*Jira.*not done/i);
});

test("merged delivery with a custom done category has no mismatch or automatic completion", () => {
    const result = classify({
        issue: issue({ category: "done", status: "Accepted by customer" }),
        trace: { prs: [pr({ state: "MERGED" })] },
    });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect trace" });
    assert.ok(!kinds(result).includes("jira_mismatch"));
    hasViews(result, ["all"]);
});

test("closed unmerged delivery requires explicit follow-up", () => {
    const result = classify({ trace: { prs: [pr({ state: "CLOSED" })] } });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect trace" });
    hasViews(result, ["all"]);
    assert.ok(kinds(result).includes("pr_closed"));
});

for (const statusCheckRollup of [undefined, []]) {
    test(`checks ${statusCheckRollup ? "empty" : "missing"} are Not reported, not passing`, () => {
        const result = classify({ trace: { prs: [pr({ statusCheckRollup })] } });
        assert.ok(kinds(result).includes("checks_not_reported"));
        assert.match(result.reasons.join(" "), /Not reported/);
        assert.ok(!kinds(result).includes("checks_passed"));
        assert.equal(result.primary.label, "Review PR");
    });
}

for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]) {
    test(`check run conclusion ${conclusion} requires Inspect checks`, () => {
        const result = classify({
            trace: { prs: [pr({ statusCheckRollup: [{ name: "Build", status: "COMPLETED", conclusion }] })] },
        });
        assert.deepEqual(result.primary, { kind: "open_pr", label: "Inspect checks", repo: pr().repo, number: pr().number });
        hasViews(result, ["all", "needs-me", "prs"]);
        assert.match(result.reasons.join(" "), /Build/);
        assert.ok(kinds(result).includes("checks_failed"));
    });
}

for (const state of ["FAILURE", "ERROR"]) {
    test(`legacy check state ${state} also requires Inspect checks`, () => {
        const result = classify({
            trace: { prs: [pr({ statusCheckRollup: [{ context: "Legacy CI", state }] })] },
        });
        assert.equal(result.primary.label, "Inspect checks");
        assert.match(result.reasons.join(" "), /Legacy CI/);
    });
}

test("mixed check results retain failure, pending and passing observations", () => {
    const result = classify({
        trace: { prs: [pr({ statusCheckRollup: [
            { name: "Build", status: "COMPLETED", conclusion: "FAILURE" },
            { name: "Tests", status: "IN_PROGRESS", conclusion: null },
            { context: "Legacy CI", state: "SUCCESS" },
        ] })] },
    });
    assert.equal(result.primary.label, "Inspect checks");
    for (const kind of ["checks_failed", "checks_pending", "checks_passed"])
        assert.ok(kinds(result).includes(kind), kind);
});

test("checks still apply to draft PRs", () => {
    const result = classify({
        trace: { prs: [pr({ isDraft: true, statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })] },
    });
    assert.equal(result.primary.label, "Inspect checks");
    assert.ok(kinds(result).includes("pr_draft"));
    hasViews(result, ["all", "needs-me"]);
});

for (const state of ["MERGED", "CLOSED", undefined]) {
    test(`known check failures remain visible when PR state is ${state}`, () => {
        const result = classify({
            trace: { prs: [pr({ state, statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })] },
        });
        if (state) {
            assert.deepEqual(result.primary, { kind: "open_pr", label: "Inspect checks", repo: pr().repo, number: pr().number });
        } else {
            assert.equal(result.primary.kind, "refresh");
            assert.match(result.signals.find(signal => signal.kind === "checks_failed").reason, /last observed/i);
        }
        hasViews(result, ["all", "needs-me"]);
        assert.ok(kinds(result).includes("checks_failed"));
        if (state === "MERGED") assert.ok(kinds(result).includes("jira_mismatch"));
        if (!state) assert.ok(kinds(result).includes("pr_unknown"));
    });
}

test("completed checks without a conclusion explicitly explain the unknown outcome", () => {
    const result = classify({
        trace: { prs: [pr({ statusCheckRollup: [{ name: "Build", status: "COMPLETED", conclusion: null }] })] },
    });
    const unknown = result.signals.find(signal => signal.kind === "checks_unknown");
    assert.match(unknown.reason, /unknown/i);
    assert.match(unknown.reason, /COMPLETED/);
});

for (const check of [
    { name: "Build", status: "IN_PROGRESS" },
    { context: "Legacy CI", state: "PENDING" },
    { name: "Build", status: "COMPLETED", conclusion: null },
    { name: "Build", status: "UNRECOGNIZED", conclusion: "SUCCESS" },
]) {
    test(`check ${JSON.stringify(check)} cannot be mistaken for passing`, () => {
        const result = classify({ trace: { prs: [pr({ statusCheckRollup: [check] })] } });
        assert.ok(!kinds(result).includes("checks_passed"));
        assert.ok(kinds(result).some(kind => ["checks_pending", "checks_unknown"].includes(kind)));
        assert.equal(result.primary.label, "Review PR");
    });
}

test("reported passing checks and approved review never imply completion", () => {
    const result = classify({
        trace: { prs: [pr({
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ name: "Build", status: "COMPLETED", conclusion: "SUCCESS" }],
        })] },
    });
    assert.equal(result.primary.label, "Review PR");
    assert.ok(kinds(result).includes("checks_passed"));
    assert.ok(kinds(result).includes("review_approved"));
    assert.ok(!result.views.includes("available"));
});

test("explicit requested review changes require attention", () => {
    const result = classify({ trace: { prs: [pr({ reviewDecision: "CHANGES_REQUESTED" })] } });
    assert.equal(result.primary.label, "Inspect review");
    assert.ok(kinds(result).includes("changes_requested"));
    hasViews(result, ["all", "needs-me", "prs"]);
});

for (const activity of ["idle", "busy", "unknown", undefined]) {
    test(`stale session activity ${activity} is not treated as fresh or available`, () => {
        const result = classify({ trace: { sessions: [session({ stale: true, activity })] } });
        assert.equal(result.primary.kind, "refresh");
        assert.ok(kinds(result).includes("session_stale"));
        assert.ok(!kinds(result).includes("session_idle"));
        hasViews(result, ["all", "needs-me"]);
    });
}

for (const activity of ["unknown", undefined]) {
    test(`session activity ${activity} stays unknown even with a verification timestamp`, () => {
        const result = classify({ trace: { sessions: [session({ activity, verifiedAt: "2099-01-01T00:00:00Z" })] } });
        assert.equal(result.primary.kind, "refresh");
        assert.ok(kinds(result).includes("session_unknown"));
        assert.ok(!kinds(result).includes("session_idle"));
        hasViews(result, ["all", "needs-me"]);
    });
}

test("stale metadata preserves pending input as history rather than a current action", () => {
    const result = classify({
        trace: {
            sessions: [session({ stale: true, awaitingInput: { question: "Continue?", choices: [], requestId: "fixture-input" } })],
            sourceStatus: { sessions: { state: "unknown" } },
        },
        jiraStale: true, mapping: null,
    });
    assert.equal(result.primary.kind, "refresh");
    assert.match(result.signals.find(signal => signal.kind === "awaiting_input").reason, /last observed/i);
    for (const kind of ["awaiting_input", "session_stale", "sessions_unknown", "jira_stale", "missing_mapping"])
        assert.ok(kinds(result).includes(kind), kind);
});

test("stale PRs are visible but not offered as verified review work", () => {
    const result = classify({ trace: { prs: [pr({ stale: true })] } });
    assert.equal(result.primary.kind, "refresh");
    assert.ok(kinds(result).includes("pr_stale"));
    hasViews(result, ["all", "needs-me"]);
    assert.ok(kinds(result).includes("pr_open"));
});

test("a recorded failing check is retained even when the PR needs refresh", () => {
    const result = classify({
        trace: { prs: [pr({ stale: true, statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })] },
    });
    assert.equal(result.primary.kind, "refresh");
    assert.ok(kinds(result).includes("pr_stale"));
    assert.ok(kinds(result).includes("checks_failed"));
    assert.match(result.signals.find(signal => signal.kind === "checks_failed").reason, /last observed/i);
    hasViews(result, ["all", "needs-me"]);
});

for (const missing of [{ state: undefined }, { isDraft: undefined }]) {
    test(`unverified PR ${Object.keys(missing)[0]} does not imply review readiness`, () => {
        const result = classify({ trace: { prs: [pr(missing)] } });
        assert.equal(result.primary.kind, "refresh");
        assert.ok(kinds(result).includes("pr_unknown"));
        hasViews(result, ["all", "needs-me"]);
    });
}

for (const [description, overrides, sourceStatus] of [
    ["stale entity", { stale: true }, undefined],
    ["stale source", { stale: false }, { sessions: { state: "stale" } }],
    ["unknown source", { stale: false }, { sessions: { state: "unknown" } }],
    ["unknown activity", { activity: "unknown" }, undefined],
    ["missing activity", { activity: undefined }, undefined],
]) {
    for (const [kind, gate] of [
        ["awaiting_input", { awaitingInput: { question: "Continue?", choices: [], requestId: "fixture-input" } }],
        ["awaiting_plan", { awaitingPlan: true }],
        ["interrupted", { interrupted: true }],
        ["session_error", { error: "Previous execution failed" }],
    ]) {
        test(`${description} makes ${kind} last-observed evidence rather than a current action`, () => {
            const result = classify({ trace: { sessions: [session({ ...overrides, ...gate })], sourceStatus } });
            assert.equal(result.primary.kind, "refresh");
            hasViews(result, ["all", "needs-me"]);
            const observed = result.signals.find(signal => signal.kind === kind);
            assert.match(observed.reason, /last observed/i);
            assert.equal(observed.sessionId, session().id);
        });
    }
}

for (const [description, overrides, sourceStatus] of [
    ["stale entity", { stale: true }, undefined],
    ["stale source", { stale: false }, { github: { state: "stale" } }],
    ["unknown source", { stale: false }, { github: { state: "unknown" } }],
    ["unknown PR state", { state: undefined }, undefined],
    ["unknown draft status", { isDraft: undefined }, undefined],
]) {
    test(`${description} prevents PR check failures from asserting a current action`, () => {
        const result = classify({ trace: {
            prs: [pr({ ...overrides, statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })],
            sourceStatus,
        } });
        assert.equal(result.primary.kind, "refresh");
        hasViews(result, ["all", "needs-me"]);
        assert.match(result.signals.find(signal => signal.kind === "checks_failed").reason, /last observed/i);
    });
}

for (const reviewDecision of ["CHANGES_REQUESTED", "APPROVED"]) {
    test(`uncertain ${reviewDecision} review evidence only offers Refresh`, () => {
        const result = classify({ trace: {
            prs: [pr({ reviewDecision })], sourceStatus: { github: { state: "unknown" } },
        } });
        assert.equal(result.primary.kind, "refresh");
        hasViews(result, ["all", "needs-me"]);
        const kind = reviewDecision === "APPROVED" ? "review_approved" : "changes_requested";
        assert.match(result.signals.find(signal => signal.kind === kind).reason, /last observed/i);
    });
}

test("a fresh question outranks unrelated stale GitHub failures", () => {
    const result = classify({ trace: {
        sessions: [session({ awaitingInput: { question: "Choose an approach?" } })],
        prs: [pr({ reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })],
        sourceStatus: { sessions: { state: "fresh" }, github: { state: "stale" } },
    } });
    assert.deepEqual(result.primary, { kind: "open_session", label: "Answer question", sessionId: session().id });
    hasViews(result, ["all", "needs-me"]);
    assert.doesNotMatch(result.signals.find(signal => signal.kind === "awaiting_input").reason, /last observed/i);
    assert.match(result.signals.find(signal => signal.kind === "checks_failed").reason, /last observed/i);
});

test("a fresh question is not hidden by a different stale session's cached question", () => {
    const result = classify({ trace: { sessions: [
        session({ id: "fixture-stale", stale: true, awaitingInput: { question: "Old question?" } }),
        session({ id: "fixture-fresh", awaitingInput: { question: "Current question?" } }),
    ] } });
    assert.equal(result.primary.sessionId, "fixture-fresh");
    assert.equal(result.primary.label, "Answer question");
    assert.equal(result.signals.filter(signal => signal.kind === "awaiting_input").length, 2);
});

test("a fresh PR failure outranks a cached question from an uncertain session source", () => {
    const result = classify({ trace: {
        sessions: [session({ awaitingInput: { question: "Old question?" } })],
        prs: [pr({ statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })],
        sourceStatus: { sessions: { state: "unknown" }, github: { state: "fresh" } },
    } });
    assert.equal(result.primary.label, "Inspect checks");
    hasViews(result, ["all", "needs-me", "prs"]);
    assert.match(result.signals.find(signal => signal.kind === "awaiting_input").reason, /last observed/i);
});

test("the review view retains fresh open non-draft work while preserving every other PR signal", () => {
    const result = classify({ trace: { prs: [
        pr({ number: 10, state: "MERGED" }),
        pr({ number: 11, state: "CLOSED" }),
        pr({ number: 12, isDraft: true }),
        pr({ number: 13, stale: true }),
        pr({ number: 14 }),
    ] } });
    hasViews(result, ["all", "needs-me", "prs"]);
    assert.equal(result.primary.label, "Review PR");
    assert.equal(result.primary.number, 14);
    for (const number of [10, 11, 12, 13, 14])
        assert.ok(result.signals.some(signal => signal.number === number));
});

for (const source of ["sessions", "github"]) {
    for (const state of ["stale", "unknown"]) {
        test(`${source} source ${state} blocks availability even with an empty trace`, () => {
            const result = classify({ trace: { sourceStatus: { [source]: { state } } } });
            assert.deepEqual(result.primary, { kind: "refresh", label: "Refresh trace", source });
            assert.ok(kinds(result).includes(`${source}_${state}`));
            hasViews(result, ["all", "needs-me"]);
        });
    }
}

test("source uncertainty overrides a cached idle session's fresh flag", () => {
    const result = classify({
        trace: { sessions: [session({ stale: false })], sourceStatus: { sessions: { state: "unknown" } } },
    });
    assert.equal(result.primary.kind, "refresh");
    assert.ok(!kinds(result).includes("session_idle"));
});

test("GitHub source uncertainty overrides cached open PR review eligibility", () => {
    const result = classify({
        trace: { prs: [pr({ stale: false })], sourceStatus: { github: { state: "stale" } } },
    });
    assert.equal(result.primary.kind, "refresh");
    assert.ok(kinds(result).includes("pr_open"));
});

test("fresh source metadata does not override an explicitly stale PR", () => {
    const result = classify({
        trace: { prs: [pr({ stale: true })], sourceStatus: { github: { state: "fresh" } } },
    });
    assert.equal(result.primary.kind, "refresh");
});

test("fresh source metadata with no linked work permits advisory availability", () => {
    const result = classify({
        trace: { sessions: [], prs: [], sourceStatus: { sessions: { state: "fresh" }, github: { state: "fresh" } } },
    });
    hasViews(result, ["all", "available"]);
});

test("trace lookup failures are surfaced verbatim and require refresh", () => {
    const result = classify({ trace: { errors: ["Session lookup failed", "GitHub unavailable"] } });
    assert.deepEqual(result.primary, { kind: "refresh", label: "Refresh live state", source: "all" });
    assert.ok(kinds(result).includes("trace_error"));
    assert.match(result.reasons.join(" "), /Session lookup failed/);
    assert.match(result.reasons.join(" "), /GitHub unavailable/);
    hasViews(result, ["all", "needs-me"]);
});

for (const override of [{ jiraStale: true }, { issue: issue({ category: "unknown" }) }]) {
    test(`unusable Jira state ${Object.keys(override)[0]} requires refresh`, () => {
        const result = classify(override);
        assert.deepEqual(result.primary, { kind: "refresh", label: "Refresh Jira", source: "jira" });
        hasViews(result, ["all", "needs-me"]);
    });
}

for (const [description, input, source] of [
    ["stale session", { trace: { sessions: [session({ stale: true })] } }, "sessions"],
    ["unknown session", { trace: { sessions: [session({ activity: "unknown" })] } }, "sessions"],
    ["missing attached session", { requests: [{ status: "attached" }] }, "sessions"],
    ["stale PR", { trace: { prs: [pr({ stale: true })] } }, "github"],
    ["unknown PR state", { trace: { prs: [pr({ state: undefined })] } }, "github"],
    ["unknown draft status", { trace: { prs: [pr({ isDraft: undefined })] } }, "github"],
]) {
    test(`${description} refresh targets its own source`, () => {
        const result = classify(input);
        assert.deepEqual(result.primary, { kind: "refresh", label: "Refresh trace", source });
        hasViews(result, ["all", "needs-me"]);
    });
}

for (const [description, input] of [
    ["question", { trace: { sessions: [session({ awaitingInput: { question: "Continue?" } })] } }],
    ["plan approval", { trace: { sessions: [session({ awaitingPlan: true })] } }],
    ["failure", { trace: { sessions: [session({ error: "Execution failed" })] } }],
    ["PR review", { trace: { prs: [pr()] } }],
    ["queued launch", { requests: [{ status: "queued" }] }],
]) {
    test(`refresh source routing preserves stronger ${description} priority`, () => {
        const expected = classify(input);
        const result = classify({
            ...input, jiraStale: true,
            trace: { ...input.trace, errors: ["Trace refresh unavailable"] },
        });
        assert.deepEqual(result.primary, expected.primary);
        assert.equal(result.rank, expected.rank);
        assert.ok(!Object.hasOwn(result.primary, "source"));
        assert.ok(kinds(result).includes("jira_stale"));
        assert.ok(kinds(result).includes("trace_error"));
    });
}

test("Jira stale state does not erase a verified PR or running session", () => {
    const result = classify({ jiraStale: true, trace: { prs: [pr()], sessions: [session({ activity: "busy" })] } });
    assert.equal(result.primary.label, "Review PR");
    hasViews(result, ["all", "needs-me", "running", "prs"]);
    assert.ok(kinds(result).includes("jira_stale"));
});

test("custom Jira status names use category, not label inference", () => {
    const done = classify({ issue: issue({ status: "Customer accepted", category: "done" }) });
    assert.equal(done.primary.kind, "inspect");
    assert.ok(!done.views.includes("available"));
    const notDone = classify({ issue: issue({ status: "Done", category: "new" }) });
    assert.equal(notDone.primary.kind, "prepare");
    const inProgress = classify({ issue: issue({ category: "indeterminate" }) });
    assert.equal(inProgress.primary.kind, "prepare");
});

test("dependency warnings use only recorded inward blocking relationships", () => {
    const result = dependencyWarnings(issue({ dependencies: [
        { key: "FIXTURE-2", relationship: "is blocked by", status: "In progress", category: "indeterminate" },
        { key: "FIXTURE-3", relationship: "  Blocked By  ", status: "Done" },
        { key: "FIXTURE-4", relationship: "blocked by", status: "Accepted", category: "done" },
        { key: "FIXTURE-5", relationship: "blocks", summary: "blocker", status: "Open", category: "new" },
        { key: "FIXTURE-6", relationship: "relates to", summary: "is blocked by", labels: ["blocked"], category: "new" },
    ] }));
    assert.deepEqual(result.map(warning => warning.id), ["dependency:FIXTURE-2", "dependency:FIXTURE-3"]);
    assert.ok(result.every(warning => Object.keys(warning).sort().join(",") === "id,message"));
    assert.match(result[0].message, /FIXTURE-2.*In progress/);
    assert.match(result[1].message, /FIXTURE-3.*unknown/i);
});

test("no recorded dependency links produce no fabricated warnings", () => {
    assert.deepEqual(dependencyWarnings(issue()), []);
    assert.deepEqual(dependencyWarnings(issue({ dependencies: undefined })), []);
});

test("the classifier reuses exact dependency warning messages for known blockers", () => {
    const blocked = issue({ dependencies: [
        { key: "FIXTURE-2", relationship: "is blocked by", status: "Open", category: "new" },
    ] });
    const result = classify({ issue: blocked });
    assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect dependencies" });
    hasViews(result, ["all", "needs-me"]);
    for (const warning of dependencyWarnings(blocked)) {
        assert.ok(result.reasons.includes(warning.message));
        assert.ok(result.signals.some(signal => signal.kind === "blocked" && signal.reason === warning.message));
    }
});

test("an unknown blocker category is not inferred done from its status name", () => {
    const result = classify({ issue: issue({ dependencies: [
        { key: "FIXTURE-2", relationship: "blocked by", status: "Done" },
    ] }) });
    assert.equal(result.primary.label, "Inspect dependencies");
    assert.ok(!result.views.includes("available"));
    assert.match(result.reasons.join(" "), /unknown/i);
});

test("custom done dependency categories and non-blocking links permit advisory availability", () => {
    const result = classify({ issue: issue({ dependencies: [
        { key: "FIXTURE-2", relationship: "blocked by", status: "Customer accepted", category: "done" },
        { key: "FIXTURE-3", relationship: "relates to", status: "Open", summary: "blocked", category: "new" },
    ] }) });
    hasViews(result, ["all", "available"]);
});

test("attention ranks implement precedence rather than a readiness score", () => {
    const ranked = [
        classify({ trace: { sessions: [session({ awaitingInput: { question: "Continue?" } })] } }),
        classify({ trace: { sessions: [session({ awaitingPlan: true })] } }),
        classify({ trace: { prs: [pr({ statusCheckRollup: [{ context: "Build", state: "FAILURE" }] })] } }),
        classify({ trace: { prs: [pr()] } }),
        classify({ requests: [{ status: "queued" }] }),
        classify(),
    ];
    for (let index = 1; index < ranked.length; index++)
        assert.ok(ranked[index - 1].rank < ranked[index].rank);
});

test("multiple PRs preserve identities and select the one needing attention", () => {
    const result = classify({
        trace: { prs: [
            pr({ number: 10 }),
            pr({ repo: "example/other", number: 20, statusCheckRollup: [{ context: "Tests", state: "FAILURE" }] }),
        ] },
    });
    assert.deepEqual(result.primary, { kind: "open_pr", label: "Inspect checks", repo: "example/other", number: 20 });
    assert.ok(result.signals.some(signal => signal.repo === "example/workbench" && signal.number === 10));
    assert.ok(result.signals.some(signal => signal.repo === "example/other" && signal.number === 20));
    hasViews(result, ["all", "needs-me", "prs"]);
});

function deepFreeze(value) {
    if (value && typeof value === "object") {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

test("classification and warnings neither mutate inputs nor depend on invocation history", () => {
    const input = {
        issue: issue({ dependencies: [{ key: "FIXTURE-2", relationship: "blocked by", category: "new" }] }),
        mapping, jiraStale: true, requests: [{ status: "queued" }, { status: "failed", error: "Launch failed" }],
        trace: {
            sessions: [
                session({ id: "fixture-idle", activity: "idle", stale: true }),
                session({ activity: "busy", awaitingInput: { question: "Continue?", choices: ["Yes"], requestId: "fixture-question" } }),
            ],
            prs: [pr({ statusCheckRollup: [{ name: "Build", status: "COMPLETED", conclusion: "FAILURE" }] })],
            errors: ["Lookup failed"], sourceStatus: { sessions: { state: "stale" } },
        },
    };
    const before = structuredClone(input);
    deepFreeze(input);
    const first = deriveExecution(input);
    assert.deepEqual(input, before);
    assert.deepEqual(deriveExecution(input), first);
    assert.deepEqual(dependencyWarnings(input.issue), dependencyWarnings(before.issue));
    assert.equal(new Set(first.reasons).size, first.reasons.length);
    for (const signal of first.signals) {
        assert.ok(Object.keys(signal).every(key => ["kind", "reason", "sessionId", "repo", "number"].includes(key)));
        assert.equal(typeof signal.reason, "string");
    }
});

const QUEUED_AT = "2026-01-01T08:00:00Z";
const minutes = n => Date.parse(QUEUED_AT) + n * 60_000;
const queued = (overrides = {}) => ({ requestId: "request-1", status: "queued", at: QUEUED_AT, ...overrides });
const EXPIRED_REASON = "Launch outcome unknown: no session receipt after 15 minutes. Check the project's sessions before starting again.";

test("a queued request keeps blocking until 15 minutes pass without a receipt", () => {
    for (const at of [0, 14, 15]) {
        const result = classify({ requests: [queued()], now: minutes(at) });
        assert.deepEqual(result.primary, { kind: "inspect", label: "Inspect queued work" }, `${at} minutes`);
        hasViews(result, ["all", "running"]);
    }
});

test("an expired request needs the user, is not running, and offers Clear stuck request", () => {
    const result = classify({ requests: [queued()], now: minutes(15) + 1 });
    assert.deepEqual(result.primary, { kind: "clear_request", label: "Clear stuck request", requestId: "request-1" });
    hasViews(result, ["all", "needs-me"]);
    assert.deepEqual(kinds(result), ["request_expired"]);
    assert.deepEqual(result.reasons, [EXPIRED_REASON]);
});

test("an expired project sync and an expired issue launch are classified the same way", () => {
    const sync = classify({ issue: issue({ id: "project", level: 2 }), requests: [queued({ kind: "jira-sync", nodeId: "project" })], now: minutes(60) });
    assert.equal(sync.primary.kind, "clear_request");
    hasViews(sync, ["all", "needs-me"]);
});

test("an expired request does not hide a fresh question, but outranks running and available work", () => {
    const question = classify({
        requests: [queued()], now: minutes(30),
        trace: { sessions: [session({ activity: "busy", awaitingInput: { question: "Continue?" } })] },
    });
    assert.equal(question.primary.label, "Answer question");
    assert.ok(kinds(question).includes("request_expired"));
    const running = classify({ requests: [queued()], now: minutes(30), trace: { sessions: [session({ activity: "busy" })] } });
    assert.equal(running.primary.kind, "clear_request");
    hasViews(running, ["all", "needs-me", "running"]);
});

test("a cleared request is informational and never blocks new work", () => {
    const result = classify({ requests: [queued({ status: "cancelled", cancelledAt: "2026-01-01T08:20:00Z" })], now: minutes(30) });
    assert.ok(kinds(result).includes("request_cancelled"));
    assert.ok(!kinds(result).includes("request_queued") && !kinds(result).includes("request_expired"));
    assert.equal(result.primary.kind, "prepare");
    hasViews(result, ["all", "available"]);
});

test("a late receipt after expiry classifies as attached, not stuck", () => {
    const result = classify({
        requests: [queued({ status: "attached", sessionId: "fixture-session", completedAt: "2026-01-01T09:00:00Z" })],
        trace: { sessions: [session()] }, now: minutes(120),
    });
    assert.equal(result.primary.kind, "open_session");
    assert.ok(!kinds(result).includes("request_expired"));
});

for (const conclusion of ["SKIPPED", "NEUTRAL"]) {
    test(`a ${conclusion} check is reported as skipped, never as unknown, failing or passing`, () => {
        const result = classify({ trace: { prs: [pr({ statusCheckRollup: [{ name: "Deploy", status: "COMPLETED", conclusion }] })] } });
        const skipped = result.signals.find(signal => signal.kind === "checks_skipped");
        assert.ok(skipped);
        assert.match(skipped.reason, new RegExp(`Deploy: ${conclusion}\\.`));
        assert.doesNotMatch(skipped.reason, /unknown/i);
        assert.ok(!kinds(result).some(kind => ["checks_unknown", "checks_failed", "checks_passed"].includes(kind)));
        assert.equal(result.primary.label, "Review PR", "a skipped check does not block review");
        hasViews(result, ["all", "needs-me", "prs"]);
    });
}

test("deriveExecution stays pure for a given clock", () => {
    const input = deepFreeze({ issue: issue(), mapping, requests: [queued()], now: minutes(20) });
    assert.deepEqual(deriveExecution(input), deriveExecution(input));
    assert.equal(deriveExecution({ ...input, now: minutes(10) }).primary.label, "Inspect queued work");
});

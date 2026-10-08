import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIssue, buildTree, descendants, jiraFreshness, REQUEST_TTL_MS } from "../lib/model.mjs";
import {
    humanize, sourceFreshness, freshnessSummary, sessionState, sessionsBadge, launchState, launchBlocks, launchLabel,
    requestOutcome, receiptMessage, launchUpdate, primaryReason, executionEvidence, matches, filterTree,
    descendantSessionCounts, defaultMode, signInNeeded, banner,
} from "../lib/view-model.mjs";
import { issues as fixtureIssues } from "../../../verification/fixture.mjs";

const time = value => value ? `at ${value}` : "not refreshed";
const NOW = Date.parse("2026-10-02T06:00:00.000Z");
const ago = ms => new Date(NOW - ms).toISOString();

const issue = (id, key, parent, type = "Story", category = "new", assignee) => normalizeIssue({
    id, key, fields: {
        summary: `Summary ${key}`, project: { id: "42", key: "DEMO" },
        issuetype: { name: type, hierarchyLevel: type === "Epic" ? 1 : type === "Subtask" ? -1 : 0 },
        status: { name: category === "done" ? "Accepted" : "To Do", statusCategory: { key: category } },
        parent: parent ? { key: parent } : undefined, assignee: assignee ? { displayName: assignee } : undefined,
    },
});
const rows = [
    issue("1", "DEMO-1", null, "Epic"),
    issue("2", "DEMO-2", "DEMO-1", "Story", "new", "Ada Lovelace"),
    issue("3", "DEMO-3", "DEMO-2", "Subtask", "done"),
    issue("4", "DEMO-4", null, "Task"),
    issue("5", "DEMO-5", "OTHER-1"),
];
const keys = nodes => nodes.flatMap(node => [node.issue.key, ...keys(node.children)]);

test("search retains the ancestors of a matching subtask", () => {
    const result = filterTree(buildTree(rows).roots, "DEMO-3", "all");
    assert.equal(result.length, 1);
    assert.equal(result[0].children[0].children[0].issue.key, "DEMO-3");
    assert.equal(filterTree(buildTree(rows).roots, "not found", "all").length, 0);
});

test("one search rule covers key, summary, assignee and parent key, in both views", () => {
    assert.equal(matches({ ...rows[1], status: "PR Waiting", category: "indeterminate" }, "", "status:PR Waiting"), true, "a project's own status filters exactly");
    assert.equal(matches({ ...rows[1], status: "In Progress", category: "indeterminate" }, "", "status:PR Waiting"), false);
    assert.equal(matches({ ...rows[1], status: "PR Waiting", category: "indeterminate" }, "", "indeterminate"), true, "a category still covers its statuses");
    assert.equal(matches(rows[1], "demo-1"), true, "a parent key finds its children");
    assert.equal(matches(rows[1], "  ada  "), true, "assignee, trimmed and case-insensitive");
    assert.equal(matches(rows[1], "summary demo-2"), true);
    assert.equal(matches(rows[0], "demo-1"), true);
    assert.equal(matches(rows[3], "demo-1"), false);
    assert.equal(matches(rows[2], "", "done"), true);
    assert.equal(matches(rows[2], "", "new"), false);
    assert.equal(matches(rows[4], "other-1", "new"), true, "a parent outside the project is still searchable");
    // The hierarchy uses the same rule: searching a parent key keeps every child of that parent.
    assert.deepEqual(keys(filterTree(buildTree(rows).roots, "DEMO-2")), ["DEMO-1", "DEMO-2", "DEMO-3"]);
    assert.deepEqual(keys(filterTree(buildTree(rows).roots, "OTHER-1")), ["DEMO-5"]);
    assert.deepEqual(keys(filterTree(buildTree(rows).roots, "", "done")), ["DEMO-1", "DEMO-2", "DEMO-3"]);
});

test("an unfiltered tree keeps every node and child", () => {
    const tree = buildTree(rows).roots;
    assert.deepEqual(keys(filterTree(tree)), keys(tree));
    assert.deepEqual(keys(filterTree(tree, "   ", "all")), keys(tree));
});

test("source freshness labels each mix of linked evidence", () => {
    const trace = (sessions, status) => ({ sessions: sessions ? [{ id: "s" }] : [], prs: [], sourceStatus: status ? { sessions: status } : {} });
    assert.deepEqual(sourceFreshness([trace(false)], "sessions", time), { label: "not needed", needed: false, detail: "No linked session records." });
    assert.equal(sourceFreshness([trace(false)], "github", time).detail, "No linked pull request records.");
    const fresh = sourceFreshness([trace(true, { state: "fresh", fetchedAt: "t1" })], "sessions", time);
    assert.deepEqual(fresh, { label: "fresh", needed: true, detail: "fresh; at t1" });
    assert.equal(sourceFreshness([trace(true, { state: "stale", fetchedAt: "t1", error: "boom" })], "sessions", time).detail, "stale; at t1; boom");
    assert.equal(sourceFreshness([trace(true, { state: "stale" })], "sessions", time).label, "stale");
    assert.equal(sourceFreshness([trace(true)], "sessions", time).label, "unavailable");
    assert.equal(sourceFreshness([trace(true)], "sessions", time).detail, "Linked evidence unavailable; not refreshed");
    assert.equal(sourceFreshness([trace(true, { state: "fresh" }), trace(true, { state: "stale" })], "sessions", time).label, "partly stale");
    assert.equal(sourceFreshness([trace(true, { state: "fresh" }), trace(true)], "sessions", time).label, "partly unavailable");
});

test("the inspector's Jira freshness is the connection bar's label, including while Jira loads", () => {
    const trace = { sessions: [], prs: [] };
    for (const snapshot of [
        { fetchedAt: null, warming: true }, { fetchedAt: null }, { fetchedAt: "t1", stale: true },
        { fetchedAt: "t1", cached: true, warming: true }, { fetchedAt: "t1" },
    ]) assert.equal(freshnessSummary(snapshot, trace, time).split(". ")[0], `Jira: ${jiraFreshness(snapshot, time).text}`);
    // Finding L13: the project item selected while Jira loads used to read "Jira: fresh not refreshed".
    assert.equal(freshnessSummary({ fetchedAt: null, warming: true }, trace, time), "Jira: loading. Sessions: not needed. GitHub: not needed.");
    const linked = { sessions: [{ id: "s" }], prs: [{ number: 1 }], sourceStatus: { sessions: { state: "fresh" }, github: { state: "stale" } } };
    assert.equal(freshnessSummary({ fetchedAt: "t1" }, linked, time), "Jira: fresh at t1. Sessions: fresh. GitHub: stale.");
});

test("session text lists every observation before the activity", () => {
    assert.equal(sessionState({ activity: "busy" }), "busy");
    assert.equal(sessionState({ activity: "", stale: true }), "stale / activity unknown");
    assert.equal(sessionState({ activity: "idle", awaitingInput: {}, awaitingPlan: true, interrupted: true }),
        "needs your input / plan awaiting approval / interrupted / idle");
    assert.equal(sessionsBadge([]), null);
    assert.equal(sessionsBadge([{ activity: "busy" }, { activity: "idle" }]), "2 sessions");
    assert.equal(sessionsBadge([{ activity: "busy", stale: true }]), "Stale session");
    assert.equal(sessionsBadge([{ activity: "idle", awaitingInput: {} }]), "Needs input");
    assert.equal(sessionsBadge([{ activity: "idle", awaitingPlan: true }]), "Plan approval");
    assert.equal(sessionsBadge([{ activity: "idle", interrupted: true }]), "Interrupted");
    assert.equal(sessionsBadge([{ activity: "some_state" }]), "Session: some state");
    assert.equal(sessionsBadge([{}]), "Session unknown");
    assert.equal(humanize(null), "unknown");
});

test("launch state covers every request status, and only a live launch blocks Start", () => {
    const request = (status, at = ago(60_000), nodeId = "6") => ({ requestId: `r-${status}`, nodeId, status, at });
    const state = (requests, local = null) => launchState({ local, requests, nodeId: "6", now: NOW });
    assert.equal(state([]), null);
    assert.equal(state([request("queued")]), "queued");
    assert.equal(state([request("queued", ago(REQUEST_TTL_MS))]), "queued", "at the TTL it is still queued");
    assert.equal(state([request("queued", ago(REQUEST_TTL_MS + 1))]), "expired");
    for (const status of ["attached", "failed", "cancelled"]) assert.equal(state([request(status)]), null, status);
    assert.equal(state([request("queued", ago(REQUEST_TTL_MS + 1)), request("queued")]), "queued", "a live retry wins");
    assert.equal(state([request("queued", ago(60_000), "7")]), null, "another item's request");
    for (const local of ["pending", "queued", "uncertain"]) assert.equal(state([], { status: local }), local);
    for (const local of ["success", "failed", "expired", "cancelled"]) assert.equal(state([request("queued")], { status: local }), "queued");

    assert.deepEqual(["pending", "queued", "uncertain", "expired", null].map(launchBlocks), [true, true, true, false, false]);
    assert.deepEqual(["pending", "queued", "uncertain", "expired", null].map(launchLabel),
        ["Submitting launch", "Launch queued", "Launch outcome unknown", "Launch outcome unknown", null]);
});

test("a launch request card states its outcome, including expired and cleared requests", () => {
    const at = ago(60_000), old = ago(REQUEST_TTL_MS + 1);
    assert.equal(requestOutcome({ status: "queued", at }, NOW), "Queued");
    assert.equal(requestOutcome({ status: "queued", at: old }, NOW), "Outcome unknown (no receipt after 15 minutes)");
    assert.equal(requestOutcome({ status: "cancelled", at: old }, NOW), "Cleared");
    assert.equal(requestOutcome({ status: "failed", at }, NOW), "Failed");
    assert.equal(requestOutcome({ status: "attached", at }, NOW), "Awaiting linked session evidence");
});

test("a stored request moves this panel's launch action to its outcome", () => {
    const update = (receipt, linkedSessionIds = []) => launchUpdate({ requestId: "r", at: ago(60_000), ...receipt }, { linkedSessionIds, now: NOW });
    assert.deepEqual(update({ status: "queued" }), { status: "queued", message: "Launch queued; waiting for an attached session receipt." });
    assert.deepEqual(update({ status: "failed", error: "Creation failed." }), { status: "failed", message: "Launch failed: Creation failed." });
    assert.equal(update({ status: "queued", at: ago(REQUEST_TTL_MS + 1) }).status, "expired");
    assert.match(update({ status: "queued", at: ago(REQUEST_TTL_MS + 1) }).message, /^Launch outcome unknown: no session receipt after 15 minutes\./);
    assert.equal(update({ status: "cancelled" }).status, "cancelled");
    assert.equal(update({ status: "attached", sessionId: "s1" }), null, "attached, but the trace has not shown the session yet");
    assert.equal(update({ status: "attached", sessionId: "s1" }, ["s1"]).status, "success");
    assert.equal(receiptMessage("open", { status: "acknowledged", message: "Navigating now." }), "Navigation: host acknowledged - Navigating now.");
    assert.equal(receiptMessage("open", { status: "queued" }), "Navigation queued; waiting for host acknowledgement.");
    assert.equal(receiptMessage("open", { status: "failed" }), "Navigation failed: The host rejected the request.");
});

test("execution evidence leads with one reason and never repeats a fact", () => {
    const execution = {
        reasons: [" ", "Session A: running.", "Session A: running"],
        signals: [{ kind: "session_busy", reason: "Session A: running" }, { kind: "pr_open" }, { kind: "blocked", reason: "Blocked by DEMO-9." }],
    };
    assert.equal(primaryReason(execution), "Session A: running.");
    assert.equal(primaryReason({ reasons: [], signals: [{ kind: "x" }, { kind: "y", reason: "Why" }] }), "Why");
    assert.equal(primaryReason({ reasons: [], signals: [] }), "No execution evidence reported.");
    const item = { id: "2", parentKey: "DEMO-1" };
    assert.deepEqual(executionEvidence(item, execution), ["pr open", "blocked: Blocked by DEMO-9."]);
    const trace = {
        sessions: [{ name: "Session A", activity: "busy" }, { activity: "idle", stale: true }],
        prs: [{ repo: "example/demo", number: 12, state: "OPEN", isDraft: true, title: "Add it" }, { repo: "example/demo", number: 13, state: "MERGED", stale: true }],
    };
    assert.deepEqual(executionEvidence(item, execution, trace), [
        "pr open", "blocked: Blocked by DEMO-9.", "Parent: DEMO-1", "Session A: busy", "Linked session: stale / idle",
        "example/demo#12: draft / OPEN - Add it", "example/demo#13: stale / MERGED",
    ]);
});

test("descendant session counts match descendants() for every issue, in one pass", () => {
    const check = (issueList, links) => {
        const sessionIdsFor = id => links[id] || [];
        const counts = descendantSessionCounts(issueList, sessionIdsFor);
        for (const item of issueList) {
            const expected = new Set(descendants(issueList, item.id).flatMap(child => sessionIdsFor(child.id))).size;
            assert.equal(counts.get(item.id) || 0, expected, item.key);
        }
        return counts;
    };
    // The verification fixture: sessions on DEMO-2, 3, 4 and 7 under the epic DEMO-1; DEMO-8 is a subtask of DEMO-6.
    const fixture = check(fixtureIssues, { 2: ["s0"], 3: ["s1"], 4: ["s2"], 7: ["s3"], 8: ["s4"] });
    assert.equal(fixture.get("1"), 5);
    assert.equal(fixture.get("6"), 1);
    // One session linked to several items in the same subtree counts once.
    check(rows, { 2: ["shared"], 3: ["shared", "other"], 5: ["outside"] });
    // A parent cycle stops at the repeat, as descendants() does.
    const cycle = [issue("1", "DEMO-1", "DEMO-2"), issue("2", "DEMO-2", "DEMO-1"), issue("3", "DEMO-3", "DEMO-1"), issue("4", "DEMO-4", "DEMO-4")];
    check(cycle, { 1: ["a"], 2: ["b"], 3: ["c"], 4: ["d"] });
    // A deterministic random forest.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const forest = Array.from({ length: 300 }, (_, index) => issue(String(index + 1), `DEMO-${index + 1}`,
        index && random() < 0.9 ? `DEMO-${1 + Math.floor(random() * index)}` : null));
    const links = Object.fromEntries(forest.filter(() => random() < 0.3).map(item => [item.id, [`s${Math.floor(random() * 40)}`]]));
    check(forest, links);
});

test("every Start button opens with the same mode: the execution's, else Plan for groups and Implement for leaves", () => {
    const prepare = mode => ({ primary: { kind: "prepare", mode } });
    assert.equal(defaultMode({ id: "6", level: 0 }, prepare("autopilot")), "autopilot");
    assert.equal(defaultMode({ id: "1", level: 1 }, prepare("plan")), "plan");
    const open = { primary: { kind: "open_session", sessionId: "s" } };
    assert.equal(defaultMode({ id: "6", level: 0 }, open), "autopilot", "a leaf with a session still defaults to Implement");
    assert.equal(defaultMode({ id: "8", level: -1 }, open), "autopilot");
    assert.equal(defaultMode({ id: "1", level: 1 }, open), "plan");
    assert.equal(defaultMode({ id: "project", level: 2 }, undefined), "plan");
    assert.equal(defaultMode({ id: "6", level: 0 }, { primary: { kind: "prepare" } }), "autopilot");
});

test("the banner follows the connection state: sign-in, automatic retry, or plain errors", () => {
    const base = { catalogErrors: [], error: null, backgroundError: null, warming: false, tree: { warnings: [] }, connection: null };
    const down = { state: "down", reason: "MCP server atlassian is stopped.", server: "atlassian", nextCheckAt: new Date(NOW + 4_200).toISOString() };
    assert.deepEqual(banner(base, { now: NOW }), { signIn: null, errors: [] });
    assert.deepEqual(banner({ ...base, catalogErrors: ["Jira: MCP server atlassian is stopped."], connection: down }, { now: NOW }).errors,
        ["Jira: MCP server atlassian is stopped.", "Reconnecting automatically in about 4s. No need to press Reload connections."]);
    assert.deepEqual(banner({ ...base, error: "timeout", warming: true, connection: down }, { now: NOW }).errors,
        ["Jira refresh failed: timeout. Last good data retained.", "Reconnecting now…"]);
    assert.deepEqual(banner({ ...base, error: "timeout", connection: { ...down, state: "ready", nextCheckAt: null } }, { now: NOW }).errors,
        ["Jira refresh failed: timeout. Last good data retained."], "no retry promise once the connection is ready");
    assert.deepEqual(banner({ ...base, error: "timeout" }, { now: NOW }).errors, ["Jira refresh failed: timeout. Last good data retained."], "no supervisor, no retry promise");
    const signin = { ...down, state: "signin", reason: "MCP server atlassian needs sign-in." };
    const expired = banner({
        ...base, connection: signin, error: "Re-authentication required", backgroundError: "Atlassian sign-in has expired.",
        catalogErrors: ["Jira: needs sign-in", "Copilot projects: timeout"],
    }, { now: NOW });
    assert.deepEqual(expired, { signIn: { server: "atlassian", connector: false }, errors: ["Copilot projects: timeout"] }, "one Sign in action, no Jira noise");
    assert.deepEqual(signInNeeded({ connection: { ...signin, server: null } }), { server: null, connector: false });
    assert.deepEqual(signInNeeded({ connection: { ...signin, server: "cc-_rovo", connector: true } }), { server: "cc-_rovo", connector: true },
        "the app's connector is signed in by the app, so the panel offers no Sign in button");
    assert.equal(signInNeeded({ connection: null }), null);
    assert.deepEqual(banner({ ...base, backgroundError: "disk full", tree: { warnings: ["Parent cycle"] } }, { now: NOW, unavailable: ["9"] }).errors, [
        "Background refresh failed: disk full", "Parent cycle",
        "Execution snapshot references unavailable work items: 9. Refresh the workbench to reconcile the sources.",
    ]);
});

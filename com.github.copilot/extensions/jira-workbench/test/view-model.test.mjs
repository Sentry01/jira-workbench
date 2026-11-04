import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIssue, buildTree, descendants, jiraFreshness, REQUEST_TTL_MS } from "../lib/model.mjs";
import {
    humanize, sourceFreshness, freshnessSummary, sessionState, sessionsBadge, sessionExists, launchState, launchBlocks, launchLabel,
    requestOutcome, receiptMessage, launchUpdate, launchReceipt, launchRejection, primaryReason, executionEvidence, matches, filterTree,
    descendantSessionCounts, defaultMode, signInNeeded, standaloneHost, banner, statusFilterGroups, sprintOptions, appliedSprint,
    smartCommitOption, retryNotice, nextFocusKey, resolveSnapshot, linksDigest, minuteKey, requestStatuses,
} from "../lib/view-model.mjs";
import { issues as fixtureIssues } from "../../../../verification/fixture.mjs";

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
    assert.deepEqual(keys(filterTree(buildTree(rows).roots, "OTHER-1")), ["OTHER-1", "DEMO-5"]);
    assert.deepEqual(keys(filterTree(buildTree(rows).roots, "", "done")), ["DEMO-1", "DEMO-2", "DEMO-3"]);
});

test("sprint options list the project's sprints, with No sprint only when some work has none", () => {
    const withSprints = (...lists) => lists.map(sprints => ({ ...rows[1], sprints }));
    assert.deepEqual(sprintOptions(withSprints([{ id: "10", name: "Sprint 10" }], [{ id: "9", name: "Sprint 9" }], [{ id: "9", name: "Sprint 9" }])),
        [{ value: "sprint:9", label: "Sprint 9" }, { value: "sprint:10", label: "Sprint 10" }]);
    assert.deepEqual(sprintOptions(withSprints([{ id: "9", name: "Sprint 9" }], [])).map(option => option.value), ["none", "sprint:9"]);
    assert.deepEqual(sprintOptions(withSprints([], [])), [], "known sprint field, but no sprints: no filter");
    assert.deepEqual(sprintOptions(rows), [], "no sprint data: no filter");
});

test("a saved sprint the project no longer offers applies as all, and applies again once it returns", () => {
    const offered = sprintOptions([{ ...rows[1], sprints: [{ id: "12", name: "Sprint 12" }] }, rows[2]]);
    assert.equal(appliedSprint(offered, "sprint:12"), "sprint:12");
    assert.equal(appliedSprint(offered, "none"), "none");
    assert.equal(appliedSprint(offered, "sprint:99"), "all", "a sprint not offered never hides work");
    assert.equal(appliedSprint([], "sprint:12"), "all", "no sprint data: no sprint filter");
    assert.equal(appliedSprint(offered, "all"), "all");
    assert.equal(appliedSprint(), "all");
});

test("an unfiltered tree keeps every node and child", () => {
    const tree = buildTree(rows).roots;
    assert.deepEqual(keys(filterTree(tree)), keys(tree));
    assert.deepEqual(keys(filterTree(tree, "   ", "all")), keys(tree));
});

test("sprint filtering matches membership and keeps hierarchy ancestors for both sprint and backlog work", () => {
    const sprintRows = rows.map((row, index) => ({
        ...row,
        sprints: index === 1 ? [{ id: "12", name: "Sprint 12" }] : [],
    }));
    assert.equal(matches(sprintRows[1], "", "all", "sprint:12"), true);
    assert.equal(matches(sprintRows[2], "", "all", "sprint:12"), false);
    assert.equal(matches(sprintRows[2], "", "all", "none"), true);
    assert.deepEqual(keys(filterTree(buildTree(sprintRows).roots, "", "all", "sprint:12")), ["DEMO-1", "DEMO-2"]);
    assert.deepEqual(keys(filterTree(buildTree(sprintRows).roots, "", "all", "none")), ["DEMO-1", "DEMO-2", "DEMO-3", "OTHER-1", "DEMO-5", "DEMO-4"]);
    assert.deepEqual(keys(filterTree(buildTree(sprintRows).roots)), keys(buildTree(sprintRows).roots));
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
    assert.equal(sessionState({ activity: "missing" }), "no longer exists");
    assert.equal(sessionsBadge([{ activity: "missing" }]), "Session no longer exists");
    assert.equal(sessionExists({ activity: "missing" }), false);
    assert.equal(sessionExists({ activity: "idle" }), true);
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
    assert.equal(requestOutcome({ status: "queued", at: old, claimedAt: ago(60_000) }, NOW), "Queued (claimed by the launching agent)");
    assert.equal(requestOutcome({ status: "queued", at, sendError: "Timed out" }, NOW), "Outcome unknown (Copilot did not confirm the prompt; no retry was sent)");
    assert.equal(requestOutcome({ status: "failed", at, supersededBy: "r2" }, NOW), "Superseded (no session was created)");
    assert.equal(requestOutcome({ status: "queued", at: old, claimedAt: old }, NOW), "Outcome unknown (claimed, no receipt after 10 minutes; blocks Start until cleared)");
});

test("an unconfirmed or claimed launch is never shown as done, and an unconfirmed one reads as unknown", () => {
    const state = requests => launchState({ requests, nodeId: "6", now: NOW });
    assert.equal(state([{ nodeId: "6", status: "queued", at: ago(60_000), sendError: "Timed out" }]), "uncertain");
    assert.equal(state([{ nodeId: "6", status: "queued", at: ago(REQUEST_TTL_MS + 1), claimedAt: ago(60_000) }]), "queued", "a claim keeps blocking past the TTL");
    assert.equal(state([{ nodeId: "6", status: "queued", at: ago(60_000), sendError: "Timed out", claimedAt: ago(1000) }]), "queued", "a claim proves delivery");
    const update = receipt => launchUpdate({ requestId: "r", at: ago(60_000), ...receipt }, { now: NOW });
    assert.deepEqual(update({ status: "queued", sendError: "Copilot did not confirm it received the prompt within 30s" }), {
        status: "uncertain",
        message: "Launch outcome unknown: Copilot did not confirm it received the prompt within 30s. No retry was sent. Refresh live state and inspect the launch receipt before starting again.",
    });
    assert.equal(update({ status: "queued", claimedAt: ago(1000) }).status, "queued");
    assert.deepEqual(update({ status: "failed", supersededBy: "r2", error: "Superseded by a newer launch; no session was created." }),
        { status: "failed", message: "Launch superseded by a newer launch; no session was created." });
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
    assert.deepEqual(banner(base, { now: NOW }), { signIn: null, errors: [], retryAt: null });
    assert.deepEqual(banner({ ...base, catalogErrors: ["Jira: MCP server atlassian is stopped."], connection: down }, { now: NOW }),
        { signIn: null, errors: ["Jira: MCP server atlassian is stopped.", "Reconnecting automatically. No need to press Reload connections."], retryAt: down.nextCheckAt });
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
    assert.deepEqual(expired, { signIn: { server: "atlassian", connector: false }, errors: ["Copilot projects: timeout"], retryAt: null }, "one Sign in action, no Jira noise");
    assert.deepEqual(signInNeeded({ connection: { ...signin, server: null } }), { server: null, connector: false });
    assert.deepEqual(signInNeeded({ connection: { ...signin, server: "cc-_rovo", connector: true } }), { server: "cc-_rovo", connector: true },
        "the app's connector is signed in by the app, so the panel offers no Sign in button");
    assert.equal(signInNeeded({ connection: null }), null);
    assert.deepEqual(banner({ ...base, backgroundError: "disk full", tree: { warnings: ["Parent cycle"] } }, { now: NOW, unavailable: ["9"] }).errors, [
        "Background refresh failed: disk full", "Parent cycle",
        "Execution snapshot references unavailable work items: 9. Refresh the workbench to reconcile the sources.",
    ]);
});

test("the alert text stays the same from one second to the next while reconnecting, so it is announced once", () => {
    const snapshot = {
        catalogErrors: ["Jira: MCP server atlassian is stopped."], error: "timeout", backgroundError: null, warming: false, tree: { warnings: [] },
        connection: { state: "down", reason: "stopped", server: "atlassian", nextCheckAt: new Date(NOW + 58_000).toISOString() },
    };
    const first = banner(snapshot, { now: NOW });
    for (const later of [1_000, 2_000, 30_000, 60_000]) assert.deepEqual(banner(snapshot, { now: NOW + later }), first);
    assert.equal(first.retryAt, snapshot.connection.nextCheckAt, "the next attempt is returned for display outside the alert");
    assert.equal(banner({ ...snapshot, warming: true }, { now: NOW }).retryAt, null, "no next attempt while one is running");
});

test("the next attempt shows as a clock time that changes once per attempt, not every second", () => {
    const at = new Date(NOW + 42_000).toISOString(), format = value => `T${Date.parse(value) - NOW}`;
    assert.equal(retryNotice(at, { now: NOW, format }), "Next attempt at T42000.");
    assert.equal(retryNotice(at, { now: NOW + 1_000, format }), "Next attempt at T42000.");
    assert.equal(retryNotice(at, { now: NOW + 42_000, format }), "Retrying now.");
    assert.equal(retryNotice(null, { now: NOW, format }), "");
    assert.equal(retryNotice("not a date", { now: NOW, format }), "");
});

test("after a notice is dismissed, focus moves to the next notice, else the previous one", () => {
    assert.equal(nextFocusKey(["a", "b", "c"], "b"), "c");
    assert.equal(nextFocusKey(["a", "b", "c"], "c"), "b");
    assert.equal(nextFocusKey(["a"], "a"), null);
    assert.equal(nextFocusKey(["a", "b"], "z"), null);
});

test("a panel with no Copilot session behind it shows one explanation, no per-source failures and no retry promise", () => {
    const reason = "This panel is not running in a Copilot session, so it cannot reach Jira or your sessions.";
    const standalone = { state: "standalone", reason, server: null, nextCheckAt: new Date(NOW + 60_000).toISOString() };
    const failing = {
        catalogErrors: ["Jira: getAccessibleAtlassianResources is unavailable.", "Copilot projects: Copilot did not offer list_repositories; update or restart Copilot."],
        error: "searchJiraIssuesUsingJql is unavailable", backgroundError: "timeout", warming: false, tree: { warnings: [] },
        issues: [{ id: "1" }], connection: standalone,
    };
    assert.equal(standaloneHost(failing), true);
    assert.equal(standaloneHost({ connection: { ...standalone, state: "down" } }), false);
    assert.equal(standaloneHost({ connection: null }), false);
    assert.deepEqual(banner(failing, { now: NOW }), { signIn: null, errors: [`${reason} The data shown is the last saved copy.`], retryAt: null });
    assert.deepEqual(banner({ ...failing, warming: true }, { now: NOW }).errors, [`${reason} The data shown is the last saved copy.`], "no Reconnecting now either");
    assert.deepEqual(banner({ ...failing, issues: [] }, { now: NOW }).errors, [reason], "no saved data, no claim about it");
    assert.deepEqual(banner({ ...failing, tree: { warnings: ["Parent cycle"] } }, { now: NOW, unavailable: ["9"] }).errors, [
        `${reason} The data shown is the last saved copy.`, "Parent cycle",
        "Execution snapshot references unavailable work items: 9. Refresh the workbench to reconcile the sources.",
    ], "problems in the saved data itself still show");
});

test("the status filter groups each project's own workflow statuses under their category", () => {
    const statuses = [{ name: "To Do", category: "new" }, { name: "In Progress", category: "indeterminate" },
        { name: "PR Waiting", category: "indeterminate" }, { name: "Done", category: "done" }];
    assert.deepEqual(statusFilterGroups(statuses), [
        { label: null, options: [{ value: "all", label: "All Jira statuses" }] },
        { label: "To do", options: [{ value: "new", label: "To do (any)" }, { value: "status:To Do", label: "To Do" }] },
        { label: "In progress", options: [{ value: "indeterminate", label: "In progress (any)" },
            { value: "status:In Progress", label: "In Progress" }, { value: "status:PR Waiting", label: "PR Waiting" }] },
        { label: "Done", options: [{ value: "done", label: "Done (any)" }, { value: "status:Done", label: "Done" }] },
    ]);
    const other = statusFilterGroups([{ name: "Odd", category: "unknown" }]);
    assert.deepEqual(other.find(group => group.label === "Other").options, [{ value: "status:Odd", label: "Odd" }], "unknown statuses get a group with no category option");
    assert.equal(statusFilterGroups([]).some(group => group.label === "Other"), false);
    assert.deepEqual(statusFilterGroups([], "status:PR Waiting").at(-1), { label: null, options: [{ value: "status:PR Waiting", label: "PR Waiting (not listed)" }] },
        "a saved status the project no longer lists stays selectable");
    assert.equal(statusFilterGroups(statuses, "status:PR Waiting").length, 4, "a listed status adds no extra option");
});


test("the Smart Commit comment option is offered only for a single issue", () => {
    assert.equal(smartCommitOption({ id: "project", key: "DEMO" }), null);
    assert.equal(smartCommitOption({ id: "2" }), null);
    assert.equal(smartCommitOption(null), null);
    const option = smartCommitOption({ id: "2", key: "DEMO-2" });
    assert.match(option.label, /DEMO-2 #comment/);
    assert.match(option.hint, /does not remove it/);
});

test("a claimed request past its window reads as unknown and keeps blocking Start", () => {
    const old = ago(REQUEST_TTL_MS + 1);
    const request = { requestId: "r", nodeId: "6", status: "queued", at: old, claimedAt: old };
    const state = launchState({ requests: [request], nodeId: "6", now: NOW });
    assert.equal(state, "uncertain");
    assert.ok(launchBlocks(state));
    const update = launchUpdate(request, { now: NOW });
    assert.equal(update.status, "uncertain");
    assert.match(update.message, /A session may still appear\. Start stays blocked until you clear the request; a late receipt still attaches its session\./);
});

test("a launch action finds its stored request by request ID, preview ID or the panel's client ID", () => {
    const requests = [{ requestId: "a", previewId: "p" }, { requestId: "b", clientId: "c" }];
    assert.equal(launchReceipt({ requestId: "a" }, requests).requestId, "a");
    assert.equal(launchReceipt({ previewId: "p" }, requests).requestId, "a");
    assert.equal(launchReceipt({ clientId: "c" }, requests).requestId, "b", "an Update Jira that timed out still reconciles");
    assert.equal(launchReceipt({ clientId: "x" }, requests), null);
    assert.equal(launchReceipt({}, [{ requestId: "z" }]), null);
});

test("an Update Jira that timed out settles as failed when the server reports it was rejected before queueing", () => {
    const rejected = [{ clientId: "c", error: "The repository mapping changed while preparing the sync." }];
    assert.deepEqual(launchRejection({ clientId: "c" }, rejected), { status: "failed", message: "Update Jira was not queued: The repository mapping changed while preparing the sync." });
    assert.equal(launchRejection({ clientId: "x" }, rejected), null);
    assert.equal(launchRejection({}, rejected), null);
    assert.equal(launchRejection({ clientId: "c" }), null);
});

test("a snapshot without the working set reuses the panel's copy only for the revision the panel holds", () => {
    const issues = [{ id: "1", key: "DEMO-1" }];
    const held = { issuesRevision: "a:1", issues };
    const full = { issuesRevision: "a:2", issues: [{ id: "2", key: "DEMO-2" }], executions: [] };
    assert.equal(resolveSnapshot(full, held), full, "a full snapshot is used as sent");
    const unchanged = { issuesRevision: "a:1", issues: null, executions: [{ nodeId: "1" }] };
    const resolved = resolveSnapshot(unchanged, held);
    assert.equal(resolved.issues, issues, "the held working set fills in");
    assert.deepEqual(resolved.executions, [{ nodeId: "1" }], "everything else comes from the response");
    const rejected = resolveSnapshot({ ...unchanged, syncRejections: [{ clientId: "c", error: "Rejected" }] }, { ...held, syncRejections: [] });
    assert.deepEqual(rejected.syncRejections, [{ clientId: "c", error: "Rejected" }], "fields sent on an unchanged poll replace the panel's");
    assert.equal(unchanged.issues, null, "the response is not modified");
    // A response compared against a revision this panel no longer (or never) held: the caller must refetch in full.
    assert.equal(resolveSnapshot({ issuesRevision: "a:1", issues: null }, { issuesRevision: "a:2", issues }), null);
    assert.equal(resolveSnapshot({ issuesRevision: "a:1", issues: null }, { issues: [] }), null);
    assert.equal(resolveSnapshot({ issuesRevision: "a:1", issues: null }, { issuesRevision: "a:1" }), null);
    assert.equal(resolveSnapshot({ issues: null }, { issues }), null);
    assert.equal(resolveSnapshot({ issuesRevision: "a:1" }, held), null, "a missing working set is never treated as unchanged");
    assert.equal(resolveSnapshot(null, held), null);
});

test("render digests ignore freshness stamps rows never show but keep what the inspector shows", () => {
    const links = stamp => ({ "c/42/2": {
        verifiedAt: `2026-11-03T10:15:${stamp}.000Z`,
        sessions: [{ id: "s1", activity: "idle", verifiedAt: `2026-11-03T10:15:${stamp}.000Z` }],
        prs: [], sourceStatus: { sessions: { state: "fresh", fetchedAt: `2026-11-03T10:15:${stamp}.000Z`, error: null } },
    } });
    assert.equal(linksDigest(links("01")), linksDigest(links("59")), "a re-observation with the same evidence keeps the row digest");
    const minute = value => value.slice(0, 16);
    assert.equal(linksDigest(links("01"), minute), linksDigest(links("59"), minute), "same minute, same inspector");
    const later = links("01");
    later["c/42/2"].sourceStatus.sessions.fetchedAt = "2026-11-03T10:16:00.000Z";
    assert.notEqual(linksDigest(links("01"), minute), linksDigest(later, minute), "the inspector shows the new minute");
    const changed = links("59");
    changed["c/42/2"].sessions[0].activity = "running";
    assert.notEqual(linksDigest(links("01")), linksDigest(changed), "observed evidence still changes the digest");
    const stale = links("59");
    stale["c/42/2"].sourceStatus.sessions.state = "stale";
    assert.notEqual(linksDigest(links("01")), linksDigest(stale), "a source turning stale changes the digest");
});

test("request statuses in a render digest change when a request crosses its expiry", () => {
    const at = "2026-11-03T10:00:00.000Z";
    const requests = [{ requestId: "r1", nodeId: "2", status: "queued", at }];
    const start = Date.parse(at);
    assert.deepEqual(requestStatuses(requests, start + 1000), ["queued"]);
    assert.deepEqual(requestStatuses(requests, start + REQUEST_TTL_MS + 1000), ["expired"]);
});

test("the inspector digest keys trace times by minute without formatting them", () => {
    assert.equal(minuteKey("2026-11-03T10:15:01.000Z"), minuteKey("2026-11-03T10:15:59.999Z"));
    assert.notEqual(minuteKey("2026-11-03T10:15:59.999Z"), minuteKey("2026-11-03T10:16:00.000Z"));
    assert.equal(minuteKey(null), null);
    assert.equal(minuteKey("not a time"), "not a time");
    const links = stamp => ({ "c/42/2": { verifiedAt: stamp, sessions: [], prs: [], sourceStatus: { sessions: { state: "fresh", fetchedAt: stamp } } } });
    assert.equal(linksDigest(links("2026-11-03T10:15:01.000Z"), minuteKey), linksDigest(links("2026-11-03T10:15:58.000Z"), minuteKey));
    assert.notEqual(linksDigest(links("2026-11-03T10:15:58.000Z"), minuteKey), linksDigest(links("2026-11-03T10:16:02.000Z"), minuteKey));
});

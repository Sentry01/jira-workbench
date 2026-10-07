import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Workbench } from "../lib/workbench.mjs";

const site = { id: "cloud-demo", name: "Demo", url: "https://demo.atlassian.net" };
const project = { id: "42", key: "DEMO", name: "Demo project" };
const copilot = { id: "copilot-uuid", name: "Demo repository", github_repo: "example/demo" };
const rows = [
    { id: "1", key: "DEMO-1", type: "Epic", level: 1, summary: "Epic", projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "Epic description" },
    { id: "2", key: "DEMO-2", type: "Story", level: 0, parentKey: "DEMO-1", summary: "Story", projectId: "42", category: "new", status: "To Do", labels: ["gh-7"], dependencies: [], description: "Acceptance criteria" },
];

async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), "jira-workbench-flow-"));
    t.after(() => rm(directory, { recursive: true }));
    const sent = [], store = new Store(directory);
    const gateway = {
        sites: async () => [site], projects: async () => [project],
        issues: async () => ({ issues: rows, fetchedAt: new Date().toISOString() }),
        call: async (name, args) => {
            if (name === "list_projects") return [copilot];
            if (name === "get_sessions_status") return { sessions: [{ id: "session-1", activity: { status: "idle" } }] };
            if (name === "list_sessions_and_chats") return [{ id: "session-1", name: "Session", project_id: copilot.id }];
            if (name === "get_session") return {
                id: args.project_session_id, project_id: options.wrongProject ? "different" : copilot.id,
                name: "Implementation", branch: "feature", created_pr_number: 9, created_pr_repo: "example/demo",
            };
            throw new Error(`Unexpected call ${name}`);
        },
    };
    const githubReads = [];
    const github = async (repo, number) => {
        githubReads.push(`${repo}#${number}`);
        return { number, url: `https://github.com/${repo}/pull/${number}`, title: "Verified", state: "OPEN", statusCheckRollup: [] };
    };
    const workbench = new Workbench({ gateway, store, github, send: async value => sent.push(value), instanceId: "test-workbench" });
    await workbench.catalog();
    await workbench.select({ cloudId: site.id, jiraProjectId: project.id });
    await workbench.idle();
    return { workbench, store, gateway, sent, githubReads };
}

test("trace refresh retains earlier PRs when the same session records another PR", async t => {
    const { workbench, gateway, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    const original = gateway.call;
    gateway.call = async (name, args) => {
        const result = await original(name, args);
        return name === "get_session" ? { ...result, created_pr_number: 10 } : result;
    };
    await workbench.refreshTrace("2");
    assert.deepEqual((await store.read()).links["cloud-demo/42/2"].prs.map(p => p.number).sort(), [9, 10].sort());
});


test("refreshing linked execution reads human intervention state once and keeps source freshness separate", async t => {
    const { workbench, gateway, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.linkSession({ nodeId: "1", sessionId: "session-1" });
    let statusReads = 0;
    const original = gateway.call;
    gateway.call = async (name, args) => {
        if (name === "get_sessions_status") {
            statusReads++;
            return { sessions: [{ id: "session-1", activity: { status: "idle" }, awaiting_user_input: true, awaiting_input: { question: "Choose a strategy", choices: ["A", "B"], request_id: "question-1" } }] };
        }
        return original(name, args);
    };
    await workbench.refreshExecution();
    assert.equal(statusReads, 1);
    const snapshot = await workbench.snapshot();
    assert.equal(snapshot.executions.find(item => item.nodeId === "2").primary.label, "Answer question");
    const trace = (await store.read()).links["cloud-demo/42/2"];
    assert.equal(trace.sessions[0].awaitingInput.question, "Choose a strategy");
    assert.equal(trace.sourceStatus.sessions.state, "fresh");
    assert.equal(trace.sourceStatus.github.state, "fresh");
});


test("navigation uses only existing trace identities and never creates or sends new work", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    const calls = [];
    workbench.hostActions = {
        openSession: async id => { calls.push(id); return { status: "acknowledged" }; },
        openPr: async (repo, number, options) => { calls.push(`${repo}#${number} via ${options.sessionId || "native PR view"}`); return { status: "acknowledged" }; },
    };
    assert.equal((await workbench.openSession({ nodeId: "2", sessionId: "session-1" })).status, "acknowledged");
    assert.equal((await workbench.openPr({ nodeId: "2", repo: "example/demo", number: 9 })).status, "acknowledged");
    await assert.rejects(workbench.openPr({ nodeId: "2", repo: "example/other", number: 9 }), /linked|trace/i);
    // session-1 created PR 9, so Review PR opens that session (its repo's built-in PR tab).
    assert.deepEqual(calls, ["session-1", "example/demo#9 via session-1"]);
    const link = (await workbench.store.read()).links["cloud-demo/42/2"];
    await workbench.store.update(data => { data.links["cloud-demo/42/2"].sessions[0].prNumber = 99; });
    await workbench.openPr({ nodeId: "2", repo: "example/demo", number: 9 });
    assert.equal(calls.at(-1), "example/demo#9 via native PR view", "no owning session: native PR view");
    assert.ok(link.prs.length);
    assert.equal(sent.length, 0);
});


test("session-only refresh does not relabel earlier GitHub evidence as newly verified", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    const previous = (await store.read()).links["cloud-demo/42/2"];
    workbench.github = async () => { throw new Error("Session-only refresh must not call GitHub"); };
    await workbench.refreshExecution({ source: "sessions" });
    const next = (await store.read()).links["cloud-demo/42/2"];
    assert.deepEqual(next.prs, previous.prs);
    assert.deepEqual(next.sourceStatus.github, previous.sourceStatus.github);
    assert.equal(next.verifiedAt, previous.verifiedAt);
});


test("failed session observation stays unknown while independently refreshed PR evidence stays fresh", async t => {
    const { workbench, gateway, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    const original = gateway.call;
    gateway.call = async (name, args) => {
        if (name === "get_sessions_status") throw new Error("Status service unavailable");
        return original(name, args);
    };
    await workbench.refreshExecution();
    const trace = (await store.read()).links["cloud-demo/42/2"];
    assert.equal(trace.sessions[0].activity, "unknown");
    assert.equal(trace.sourceStatus.sessions.state, "stale");
    assert.equal(trace.sourceStatus.github.state, "fresh");
    assert.equal(trace.prs[0].state, "OPEN");
});


test("session-only refresh preserves GitHub evidence updated concurrently by another panel", async t => {
    const { workbench, gateway, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    let entered, release;
    const entering = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    const original = gateway.call;
    gateway.call = async (name, args) => {
        if (name === "get_session") { entered(); await resume; }
        return original(name, args);
    };
    const pending = workbench.refreshExecution({ source: "sessions" });
    await entering;
    await store.update(data => {
        data.links["cloud-demo/42/2"].prs.push({ repo: "example/demo", number: 10, url: "https://github.com/example/demo/pull/10", state: "OPEN", sessionIds: ["session-1"] });
    });

    release();
    await pending;
    assert.deepEqual((await store.read()).links["cloud-demo/42/2"].prs.map(pr => pr.number).sort(), [9, 10].sort());
});


test("linking refuses a session ID that native navigation could never open", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await assert.rejects(workbench.linkSession({ nodeId: "2", sessionId: "-session-1" }), /valid app session ID/i);
    assert.equal(Object.keys((await store.read()).links).length, 0);
});

test("a session's PR repository comes only from its PR evidence, never its project repository", async t => {
    const { workbench, gateway, store, githubReads } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const original = gateway.call;
    let pr = { created_pr_number: 9, created_pr_repo: null };
    gateway.call = async (name, args) => {
        const result = await original(name, args);
        if (name !== "get_session") return result;
        const { created_pr_number: _number, created_pr_repo: _repo, ...rest } = result;
        return { ...rest, project_repo: "example/demo", ...pr };
    };
    const trace = () => store.read().then(data => data.links["cloud-demo/42/2"]);

    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    let link = await trace();
    assert.deepEqual([link.sessions[0].prNumber, link.sessions[0].prRepo], [null, null], "a PR number without its repository is not evidence");
    assert.deepEqual(link.prs, []);

    pr = { pr_number: 9, pr_repo_full_name: "example/demo" };
    await workbench.refreshTrace("2");
    link = await trace();
    assert.deepEqual([link.sessions[0].prNumber, link.sessions[0].prRepo], [null, null], "unobserved field names are not read");
    assert.deepEqual(githubReads, []);

    pr = { created_pr_number: 9, created_pr_repo: "example/other" };
    await workbench.refreshTrace("2");
    link = await trace();
    assert.equal(link.sessions[0].prRepo, "example/other");
    assert.deepEqual(githubReads, ["example/other#9"]);
    assert.deepEqual(link.prs.map(p => `${p.repo}#${p.number}`), ["example/other#9"]);
});

test("session observations read the host's observed status fields only", async t => {
    const { workbench, gateway, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    const original = gateway.call;
    let status = { id: "session-1", activity: null, activity_status: "busy", interrupted: true, awaiting_input: { requestId: "unobserved" } };
    gateway.call = async (name, args) => name === "get_sessions_status" ? { sessions: [status] } : original(name, args);
    await workbench.refreshExecution({ source: "sessions" });
    let [session] = (await store.read()).links["cloud-demo/42/2"].sessions;
    assert.equal(session.activity, "unknown");
    assert.equal(session.interrupted, false);
    assert.equal(session.awaitingInput.requestId, null);

    status = { id: "session-1", activity: { status: "busy", busy_for_seconds: 4 }, was_interrupted: true, awaiting_plan_approval: true,
        awaiting_user_input: true, awaiting_input: { question: "Which strategy?", choices: ["A"], request_id: "question-1" } };
    await workbench.refreshExecution({ source: "sessions" });
    [session] = (await store.read()).links["cloud-demo/42/2"].sessions;
    assert.equal(session.activity, "busy");
    assert.equal(session.interrupted, true);
    assert.equal(session.awaitingPlan, true);
    assert.deepEqual(session.awaitingInput, { question: "Which strategy?", choices: ["A"], requestId: "question-1" });
});

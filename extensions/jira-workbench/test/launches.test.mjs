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
const confirm = (workbench, preview) => workbench.launch({
    previewId: preview.id, contextHash: preview.brief?.hash,
    acknowledgedWarnings: preview.brief?.warnings.map(w => w.id) || [],
});

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

test("Update Jira queues one project-wide status sync session carrying linked evidence", async t => {
    const { workbench, store, sent } = await fixture(t);
    await assert.rejects(workbench.syncJira(), /repository/i);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await workbench.refreshTrace("2");
    const queued = await workbench.syncJira();
    assert.equal(queued.status, "queued");
    assert.equal(sent.length, 1);
    await assert.rejects(workbench.syncJira(), /queued/i);
    assert.equal(sent.length, 1);
    const request = (await store.read()).requests[queued.requestId];
    assert.equal(request.kind, "jira-sync");
    assert.equal(request.nodeId, "project");
    assert.equal(request.scope, "cloud-demo/42/project");
    assert.match(sent[0].prompt, /create_session/);
    assert.match(sent[0].prompt, /"project_id": "copilot-uuid"/);
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /"key": "DEMO-2"/);
    assert.match(kickoff, /"number": 9/);
    await workbench.recordSession({ requestId: queued.requestId, sessionId: "session-1" });
    assert.equal((await store.read()).links["cloud-demo/42/project"].sessions[0].id, "session-1");
});


test("Update Jira refuses stale Jira data", async t => {
    const { workbench, gateway, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    gateway.issues = async () => { throw new Error("Connection expired"); };
    await workbench.refresh();
    await assert.rejects(workbench.syncJira(), /refresh/i);
    assert.equal(sent.length, 0);
});


test("Update Jira passes stale flags and source freshness to the session", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    await store.update(data => {
        const link = data.links["cloud-demo/42/2"];
        link.sessions[0].stale = true;
        link.sourceStatus = { sessions: { state: "stale" } };
    });
    await workbench.syncJira();
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /"stale": true/);
    assert.match(kickoff, /"sessions": "stale"/);
    assert.match(kickoff, /"github": "unknown"/);
});


test("Update Jira refuses when the project selection changes before the request is persisted", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const original = store.update.bind(store);
    store.update = async mutate => {
        workbench.project = { id: "43", key: "OTHER", name: "Other project" };
        return original(mutate);
    };
    await assert.rejects(workbench.syncJira(), /project changed/i);
    store.update = original;
    assert.equal(Object.keys((await store.read()).requests).length, 0);
    assert.equal(sent.length, 0);
});


test("launch requires preview and confirmation; duplicate clicks create one request", async t => {
    const { workbench, store, sent } = await fixture(t);
    await assert.rejects(workbench.prepare({ nodeId: "2" }), /repository/i);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
    assert.equal(sent.length, 0);
    assert.equal(preview.node.key, "DEMO-2");
    await assert.rejects(workbench.launch({ previewId: "invented" }), /preview/i);
    const result = await confirm(workbench, preview);
    assert.equal(sent.length, 1);
    await assert.rejects(workbench.launch({ previewId: preview.id }), /preview|queued/i);
    const second = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
    await assert.rejects(confirm(workbench, second), /queued/i);
    assert.equal(Object.values((await store.read()).requests).length, 1);
    assert.equal(result.status, "queued");
});


test("receipt persists actual session and PR without changing Jira status or losing earlier sessions", async t => {
    const { workbench, store, sent, githubReads } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
    assert.ok(preview.brief.sources.every(source => source.kind === "jira"));
    const queued = await confirm(workbench, preview);
    await workbench.recordSession({ requestId: queued.requestId, sessionId: "session-1" });
    await workbench.recordSession({ requestId: queued.requestId, sessionId: "session-1" });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-2" });
    await store.update(data => { data.links["cloud-demo/42/2"].origins = [{ repo: "example/demo", number: 7 }]; });
    await workbench.refreshTrace("2");
    const data = await store.read();
    const links = data.links["cloud-demo/42/2"];
    assert.equal(links.sessions.length, 2);
    assert.equal(links.prs[0].number, 9);
    assert.equal(links.origins, undefined, "legacy GitHub source issues are dropped from stored traces");
    assert.ok(githubReads.length && githubReads.every(read => read === "example/demo#9"), "only session-reported PRs are read; gh-N labels trigger no GitHub reads");
    assert.equal((await workbench.snapshot()).issues.find(i => i.id === "2").status, "To Do");
    assert.equal(sent.length, 1);
});


test("a session from the wrong Copilot project cannot be linked by a launch receipt", async t => {
    const { workbench, store } = await fixture(t, { wrongProject: true });
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "plan" });
    const queued = await confirm(workbench, preview);
    await assert.rejects(workbench.recordSession({ requestId: queued.requestId, sessionId: "session-1" }), /project/i);
    assert.equal(Object.keys((await store.read()).links).length, 0);
});


test("hierarchy launch includes descendants but defaults to a single planning session", async t => {
    const { workbench } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "1" });
    assert.equal(preview.mode, "plan");
    assert.equal(preview.children.length, 1);
});


test("implementation enforces reviewed context and warnings while planning remains available", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const implement = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
    await assert.rejects(workbench.launch({ previewId: implement.id, contextHash: implement.brief?.hash }), /acknowledge/i);
    assert.equal(sent.length, 0);
    const plan = await workbench.prepare({ nodeId: "2", mode: "plan" });
    const queued = await workbench.launch({ previewId: plan.id, contextHash: plan.brief?.hash });
    assert.equal((await store.read()).requests[queued.requestId].brief.intent, "plan");
});


test("reviewed edits are recorded immutably with the launch and session receipt", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot", fields: { objective: "New objective", acceptanceCriteria: "An observable result", constraints: "No dependencies" } });
    assert.equal(preview.brief?.objective, "New objective");
    const queued = await confirm(workbench, preview);
    const request = (await store.read()).requests[queued.requestId];
    assert.equal(request.previewId, preview.id);
    assert.equal(request.contextHash, preview.brief.hash);
    assert.equal(request.brief.acceptanceCriteria[0], "An observable result");
    assert.match(sent[0].prompt, /An observable result/);
    assert.match(sent[0].prompt, new RegExp(preview.brief.hash));
    await workbench.recordSession({ requestId: queued.requestId, sessionId: "session-1" });
    await workbench.refreshTrace("2");
    assert.equal((await store.read()).links["cloud-demo/42/2"].sessions[0].contextHash, preview.brief.hash);
});


test("an edited or refreshed brief cannot be launched using a prior acknowledgement", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const original = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
    const edited = await workbench.prepare({ nodeId: "2", mode: "autopilot", fields: { objective: "Changed scope" } });
    await assert.rejects(workbench.launch({ previewId: edited.id, contextHash: original.brief?.hash, acknowledgedWarnings: ["missing-criteria"] }), /changed|review|hash/i);
    workbench.issues = workbench.issues.map(i => i.id === "2" ? { ...i, updated: "changed-revision" } : i);
    await assert.rejects(confirm(workbench, edited), /changed|review|hash/i);
    assert.equal(sent.length, 0);
});


const expire = (store, requestId) => store.update(data => { data.requests[requestId].at = new Date(Date.now() - 16 * 60_000).toISOString(); });
const launchIssue = async (workbench, nodeId = "2") => confirm(workbench, await workbench.prepare({ nodeId, mode: "plan" }));

test("a launch whose receipt never arrives stops blocking the issue after 15 minutes, and a late receipt still attaches", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stuck = await launchIssue(workbench);
    await assert.rejects(launchIssue(workbench), /already queued/i);
    await expire(store, stuck.requestId);
    assert.equal((await store.read()).requests[stuck.requestId].status, "queued", "expiry is derived, not written");
    const execution = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.deepEqual(execution.primary, { kind: "clear_request", label: "Clear stuck request", requestId: stuck.requestId });
    assert.ok(execution.views.includes("needs-me") && !execution.views.includes("running"));
    const retry = await launchIssue(workbench);
    assert.equal(sent.length, 2, "the retry is sent to the launching agent");
    await assert.rejects(launchIssue(workbench), /already queued/i, "the retry blocks duplicates again");
    assert.deepEqual(await workbench.recordSession({ requestId: stuck.requestId, sessionId: "session-1" }), { status: "attached", sessionId: "session-1" });
    const data = await store.read();
    assert.equal(data.requests[stuck.requestId].status, "attached");
    assert.equal(data.links["cloud-demo/42/2"].sessions[0].id, "session-1");
    assert.equal(data.requests[retry.requestId].status, "queued");
});

test("Clear stuck request cancels a queued request, unblocks the issue, and still accepts a late receipt", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stuck = await launchIssue(workbench);
    assert.deepEqual(await workbench.clearRequest({ requestId: stuck.requestId }), { status: "cancelled", requestId: stuck.requestId });
    const cleared = (await store.read()).requests[stuck.requestId];
    assert.equal(cleared.status, "cancelled");
    assert.ok(Date.parse(cleared.cancelledAt) <= Date.now());
    await assert.rejects(workbench.clearRequest({ requestId: stuck.requestId }), /queued or expired/i, "a cleared request cannot be cleared again");
    await assert.rejects(workbench.failRequest({ requestId: stuck.requestId, message: "late failure" }), /cleared/i);
    const execution = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.ok(execution.signals.some(s => s.kind === "request_cancelled"));
    assert.ok(!execution.signals.some(s => ["request_queued", "request_expired"].includes(s.kind)));
    const retry = await launchIssue(workbench);
    await workbench.recordSession({ requestId: stuck.requestId, sessionId: "session-1" });
    await assert.rejects(workbench.recordSession({ requestId: stuck.requestId, sessionId: "session-2" }), /different session receipt/i);
    const data = await store.read();
    assert.equal(data.requests[stuck.requestId].status, "attached");
    assert.equal(data.requests[retry.requestId].status, "queued");
});

test("an expired request can be cleared or failed; a finished one cannot be cleared", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const first = await launchIssue(workbench);
    await expire(store, first.requestId);
    assert.equal((await workbench.clearRequest({ requestId: first.requestId })).status, "cancelled");
    const second = await launchIssue(workbench);
    await expire(store, second.requestId);
    assert.deepEqual(await workbench.failRequest({ requestId: second.requestId, message: "create_session failed" }), { status: "failed", requestId: second.requestId });
    await assert.rejects(workbench.clearRequest({ requestId: second.requestId }), /queued or expired/i);
    const third = await launchIssue(workbench);
    await workbench.recordSession({ requestId: third.requestId, sessionId: "session-1" });
    await assert.rejects(workbench.clearRequest({ requestId: third.requestId }), /queued or expired/i);
    await assert.rejects(workbench.clearRequest({ requestId: "invented" }), /selected Jira project/i);
    await assert.rejects(workbench.clearRequest({}), /request ID/i);
});

test("a request from another Jira project cannot be cleared from this panel", async t => {
    const { workbench, store } = await fixture(t);
    const other = { requestId: "other", scope: "cloud-demo/43/7", nodeId: "7", status: "queued", at: new Date(Date.now() - 60 * 60_000).toISOString() };
    const spoofed = { ...other, requestId: "spoofed", nodeId: "2" };
    await store.update(data => { data.requests.other = other; data.requests.spoofed = spoofed; });
    await assert.rejects(workbench.clearRequest({ requestId: "other" }), /selected Jira project/i);
    await assert.rejects(workbench.clearRequest({ requestId: "spoofed" }), /selected Jira project/i, "the node ID must belong to the stored scope");
    await assert.rejects(workbench.clearRequest({ requestId: "__proto__" }), /selected Jira project/i);
    const data = await store.read();
    assert.equal(data.requests.other.status, "queued");
    assert.equal(data.requests.spoofed.status, "queued");
});

test("a stuck Update Jira request expires and clears like a launch, so it cannot block project sync forever", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stuck = await workbench.syncJira();
    await assert.rejects(workbench.syncJira(), /already queued/i);
    await expire(store, stuck.requestId);
    const project = (await workbench.snapshot()).executions.find(e => e.nodeId === "project");
    assert.deepEqual(project.primary, { kind: "clear_request", label: "Clear stuck request", requestId: stuck.requestId });
    const retry = await workbench.syncJira();
    assert.equal(sent.length, 2);
    assert.equal((await workbench.clearRequest({ requestId: retry.requestId })).status, "cancelled");
    await workbench.syncJira();
    await workbench.recordSession({ requestId: stuck.requestId, sessionId: "session-1" });
    assert.equal((await store.read()).requests[stuck.requestId].status, "attached");
});

test("a panel that closed before its receipt does not block a reopened panel after expiry", async t => {
    const { workbench, store, gateway } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stuck = await launchIssue(workbench);
    await workbench.close?.();
    const reopened = new Workbench({ gateway, store, github: async (repo, number) => ({ number, url: `https://github.com/${repo}/pull/${number}`, state: "OPEN", statusCheckRollup: [] }), send: async () => {}, instanceId: "reopened" });
    t.after(() => reopened.close?.());
    await reopened.catalog();
    await reopened.select({ cloudId: site.id, jiraProjectId: project.id });
    await reopened.idle();
    await assert.rejects(launchIssue(reopened), /already queued/i);
    await expire(store, stuck.requestId);
    assert.equal((await launchIssue(reopened)).status, "queued");
});

test("a stored launch keeps its reviewed brief but only the keys of its descendants", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "1", mode: "plan" });
    assert.deepEqual(preview.brief.children.map(child => child.summary), ["Story"]);
    const queued = await confirm(workbench, preview);
    const request = (await store.read()).requests[queued.requestId];
    assert.deepEqual(request.brief.children, ["DEMO-2"]);
    assert.equal(request.contextHash, preview.brief.hash);
    assert.equal(request.brief.hash, preview.brief.hash);
    assert.equal(request.brief.objective, preview.brief.objective);
    assert.deepEqual(request.brief.sources, preview.brief.sources);
    assert.equal(typeof preview.brief.children[0], "object", "the in-memory preview is not mutated");
});

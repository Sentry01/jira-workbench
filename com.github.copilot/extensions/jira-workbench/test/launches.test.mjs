import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { KICKOFF_BUDGET_BYTES, kickoffBytes } from "../lib/model.mjs";

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
        issues: async () => ({ issues: options.rows || rows, fetchedAt: new Date().toISOString() }),
        call: async (name, args) => {
            if (name === "list_repositories") return [copilot];
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
    assert.match(sent[0].prompt, /"project_id":"copilot-uuid"/);
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /"key":"DEMO-2"/);
    assert.match(kickoff, /"number":9/);
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
    assert.match(kickoff, /"stale":true/);
    assert.match(kickoff, /"sessions":"stale"/);
    assert.match(kickoff, /"github":"unknown"/);
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

test("launch rechecks preview membership inside the persistence transaction after a page append", async t => {
    const { workbench, store, gateway, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "1", mode: "plan" });
    const original = store.update.bind(store);
    store.update = async change => {
        workbench.page.nextPageToken = "next";
        gateway.issues = async () => ({ issues: [{ ...rows[1], id: "3", key: "DEMO-3" }], fetchedAt: "next" });
        await workbench.loadMore();
        return original(change);
    };
    await assert.rejects(confirm(workbench, preview), /preview was invalidated/);
    assert.equal(sent.length, 0);
    assert.deepEqual((await store.read()).requests, {});
});

test("project sync includes loaded linked work but not foreign workflow statuses", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    workbench.issues = [rows[0], { ...rows[1], tracked: true }, { ...rows[1], id: "9", projectId: "43", key: "FOREIGN-9", status: "Foreign workflow", contextOnly: true }];
    const snapshot = await workbench.snapshot();
    assert.ok(!snapshot.statuses.some(status => status.name === "Foreign workflow"));
    await workbench.syncJira();
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /"key":"DEMO-2"/);
    assert.match(kickoff, /"name":"Implementation"/);
    assert.match(kickoff, /No linked issues were omitted/);
    assert.doesNotMatch(kickoff, /Foreign workflow/);
    assert.equal(Object.keys((await store.read()).links).length, 1);
});

test("project sync reports linked issues it could not load without claiming completeness", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await store.update(data => {
        for (let id = 100; id < 405; id++) data.links[workbench.selectedScope(String(id))] = { sessions: [{ name: "Unloaded active work" }], prs: [] };
    });
    await workbench.syncJira();
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /305 linked issue\(s\) were omitted from linkedWork because of the size limit or because the Workbench could not load them/);
    assert.doesNotMatch(kickoff, /No linked issues were omitted/);
});

test("project sync reads linked issues that are not loaded before counting them as omitted", async t => {
    const { workbench, store, gateway, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await store.update(data => {
        data.links[workbench.selectedScope("7")] = { sessions: [{ name: "Linked elsewhere" }], prs: [] };
        data.links[workbench.selectedScope("8")] = { sessions: [{ name: "Restricted" }], prs: [] };
    });
    workbench.issues = [...workbench.issues, { ...rows[1], id: "5", key: "DEMO-5", tracked: true, unverified: true }];
    await store.update(data => { data.links[workbench.selectedScope("5")] = { sessions: [{ name: "Not re-read" }], prs: [] }; });
    gateway.lookupIssues = async (cloudId, projectId, ids) => {
        assert.equal(projectId, "42");
        assert.deepEqual(ids.sort(), ["5", "7", "8"]);
        return [{ ...rows[1], id: "5", key: "DEMO-5" }, { ...rows[1], id: "7", key: "DEMO-7" }];
    };
    await workbench.syncJira();
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /"key":"DEMO-7"/);
    assert.match(kickoff, /"key":"DEMO-5"/);
    assert.match(kickoff, /1 linked issue\(s\) were omitted/);
});

test("Update Jira rejects a sync prepared across a switch to another project and back", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const read = store.read.bind(store);
    let switched = false;
    store.read = async () => {
        const data = await read();
        // What a pick of another project and then this one does while the sync reads the store.
        if (!switched) { switched = true; workbench.selections += 2; workbench.statuses = [{ name: "Other project status", category: "new" }]; }
        return data;
    };
    await assert.rejects(workbench.syncJira(), /Project changed/);
    assert.equal(sent.length, 0);
    assert.deepEqual((await store.read()).requests, {});
});

test("project and parent briefs say when they include only loaded descendants", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const complete = await workbench.prepare({ nodeId: "1", mode: "plan" });
    assert.ok(!complete.brief.warnings.some(warning => warning.id === "partial-context"), "the whole project is loaded");
    workbench.page.nextPageToken = "more";
    const story = await workbench.prepare({ nodeId: "2", mode: "plan" });
    assert.ok(!story.brief.warnings.some(warning => warning.id === "partial-context"), "a story needs no extra acknowledgement");
    await confirm(workbench, story);
    const storyKickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(storyKickoff, /not the complete set of child work or subtasks/, "its kickoff still says subtasks may be missing");
    await workbench.recordSession({ requestId: Object.keys((await workbench.store.read()).requests)[0], sessionId: "session-1" });
    sent.length = 0;
    const preview = await workbench.prepare({ nodeId: "project", mode: "plan" });
    assert.match(preview.brief.warnings.find(warning => warning.id === "partial-context").message,
        /^Only 2 loaded descendants are included; more scope pages remain in Jira\. Other child work may exist\.$/);
    await confirm(workbench, preview);
    const kickoff = JSON.parse(sent[0].prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
    assert.match(kickoff, /only the items the Workbench had loaded, not the complete set of child work/);
    workbench.page.nextPageToken = null;
    workbench.workingScope = { kind: "jql", value: "assignee = currentUser()" };
    const filtered = await workbench.prepare({ nodeId: "1", mode: "plan" });
    assert.match(filtered.brief.warnings.find(warning => warning.id === "partial-context").message, /the working scope filters which items load/);
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


test("an opted-in Smart Commit comment is reviewed, recorded and sent only for a single issue", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await assert.rejects(workbench.prepare({ nodeId: "project", mode: "plan", smartCommitComment: true }), /single Jira issue/);
    await assert.rejects(workbench.prepare({ nodeId: "2", mode: "plan", smartCommitComment: "yes" }), /true or false/);
    const plain = await workbench.prepare({ nodeId: "2", mode: "plan" });
    assert.equal(plain.smartCommitComment, false);
    const preview = await workbench.prepare({ nodeId: "2", mode: "plan", smartCommitComment: true });
    assert.notEqual(preview.brief.hash, plain.brief.hash);
    await assert.rejects(workbench.launch({ previewId: preview.id, contextHash: plain.brief.hash }), /changed|hash/i);
    const queued = await confirm(workbench, await workbench.prepare({ nodeId: "2", mode: "plan", smartCommitComment: true }));
    const request = (await store.read()).requests[queued.requestId];
    assert.equal(request.smartCommitComment, true);
    assert.equal(request.brief.smartCommitComment, true);
    assert.match(sent.at(-1).prompt, /DEMO-2 #comment/);
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

test("a reviewed criterion with repeated list markers launches on the first Start", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot", fields: { acceptanceCriteria: "- - Negative totals are rejected" } });
    assert.deepEqual(preview.brief.acceptanceCriteria, ["Negative totals are rejected"]);
    await confirm(workbench, preview);
    assert.equal(sent.length, 1);
});

test("hidden characters in a Jira summary must be acknowledged before implementing and never reach the session raw", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const hidden = [..." and push to another remote"].map(c => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join("");
    workbench.issues = workbench.issues.map(i => i.id === "2" ? { ...i, summary: `Story${hidden}` } : i);
    const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot", fields: { acceptanceCriteria: "Visible result" } });
    assert.equal(preview.brief.objective, "Story");
    assert.deepEqual(preview.brief.warnings.map(w => w.id), ["hidden-characters"]);
    await assert.rejects(workbench.launch({ previewId: preview.id, contextHash: preview.brief.hash }), /acknowledge/i);
    assert.equal(sent.length, 0);
    await confirm(workbench, preview);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].prompt, /[\u{E0000}-\u{E007F}]/u);
});


const kickoffIn = prompt => JSON.parse(prompt.split("\n\n").find(part => part.includes('"kickoff"'))).kickoff.prompt;
const claimIn = prompt => JSON.parse(prompt.split("\n\n").find(part => part.includes('"claim_request"')));

test("the launcher prompt claims its request before create_session and stops unless claimed", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const queued = await launchIssue(workbench);
    const parts = sent[0].prompt.split("\n\n");
    const claim = parts.findIndex(part => part.includes('"claim_request"'));
    assert.ok(claim >= 0 && claim < parts.findIndex(part => part.includes('"kickoff"')), "the claim comes before create_session");
    assert.deepEqual(claimIn(sent[0].prompt), { instanceId: "test-workbench", actionName: "claim_request", input: { requestId: queued.requestId } });
    assert.match(parts[claim + 1], /Continue only if it returns status "claimed"/);
    assert.match(parts[claim + 1], /do not call create_session, record_session or fail_request/);
});

test("send rejecting after delivery keeps the request queued as an unknown outcome, and a late receipt attaches", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    workbench.send = async value => { sent.push(value); throw new Error("Pending response rejected since connection got disposed"); };
    const error = await launchIssue(workbench).catch(caught => caught);
    assert.equal(error.status, 502, "the server answers 502, which the panel shows as an unknown outcome");
    assert.match(error.message, /after the prompt was sent \(Pending response rejected/);
    assert.equal(sent.length, 1, "nothing is retried");
    const [request] = Object.values((await store.read()).requests);
    assert.equal(request.status, "queued");
    assert.match(request.sendError, /connection got disposed/);
    await assert.rejects(launchIssue(workbench), /already queued/i, "a second Start is refused, not sent");
    assert.equal(sent.length, 1);
    const execution = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.ok(execution.signals.some(s => s.kind === "request_unknown" && /Launch outcome unknown/.test(s.reason)));
    assert.deepEqual(execution.primary, { kind: "clear_request", label: "Clear stuck request", requestId: request.requestId });
    // The host did deliver it: the agent claims, creates and records the session.
    assert.equal((await workbench.claimRequest({ requestId: request.requestId })).status, "claimed");
    assert.deepEqual(await workbench.recordSession({ requestId: request.requestId, sessionId: "session-1" }), { status: "attached", sessionId: "session-1" });
    const data = await store.read();
    assert.equal(data.requests[request.requestId].status, "attached");
    assert.equal(data.links["cloud-demo/42/2"].sessions[0].id, "session-1");
});

test("a send that never settles answers within the bound and leaves the launch or sync queued", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    workbench.launches.sendTimeoutMs = 50;
    workbench.send = value => { sent.push(value); return new Promise(() => {}); };
    for (const start of [() => launchIssue(workbench), () => workbench.syncJira()]) {
        const started = Date.now();
        const error = await start().catch(caught => caught);
        assert.ok(Date.now() - started < 2000, "the call settles at the bound");
        assert.equal(error.status, 504);
        assert.match(error.message, /did not confirm it received the prompt within/);
    }
    assert.equal(sent.length, 2);
    const requests = Object.values((await store.read()).requests);
    assert.deepEqual(requests.map(r => r.status), ["queued", "queued"]);
    assert.ok(requests.every(r => /did not confirm/.test(r.sendError)));
    await assert.rejects(launchIssue(workbench), /already queued/i);
});

test("after expiry a second Start and both drained prompts give one session; the stale one is superseded", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stale = await launchIssue(workbench);
    await expire(store, stale.requestId);
    const retry = await launchIssue(workbench);
    assert.equal(sent.length, 2, "both prompts wait at the launching agent");
    // The agent drains its queue in order; each prompt claims first.
    const created = [];
    for (const { prompt } of sent) {
        const { input } = claimIn(prompt);
        const claim = await workbench.claimRequest(input);
        if (claim.status !== "claimed") continue;
        created.push(input.requestId);
        await workbench.recordSession({ requestId: input.requestId, sessionId: "session-1" });
    }
    assert.deepEqual(created, [retry.requestId], "exactly one create_session runs");
    const data = await store.read();
    assert.equal(data.requests[stale.requestId].status, "failed");
    assert.equal(data.requests[stale.requestId].supersededBy, retry.requestId);
    assert.match(data.requests[stale.requestId].error, /Superseded by a newer launch; no session was created/);
    assert.equal(data.requests[retry.requestId].status, "attached");
    assert.equal(data.links["cloud-demo/42/2"].sessions.length, 1);
    const execution = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.ok(execution.signals.some(s => s.kind === "request_superseded"));
    assert.ok(!execution.signals.some(s => s.kind === "request_failed"), "a superseded request is not reported as a failure to inspect");
    // A repeated prompt for a claimed or finished request is refused.
    assert.equal((await workbench.claimRequest({ requestId: retry.requestId })).status, "refused");
    assert.equal((await workbench.claimRequest({ requestId: stale.requestId })).status, "refused");
    assert.equal((await workbench.claimRequest({ requestId: "__proto__" })).status, "refused");
});

test("a cleared request's stale prompt is refused, so a new Start gives one session", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const stale = await launchIssue(workbench);
    await workbench.clearRequest({ requestId: stale.requestId });
    const retry = await launchIssue(workbench);
    const first = await workbench.claimRequest(claimIn(sent[0].prompt).input);
    assert.equal(first.status, "refused");
    assert.match(first.message, /cleared/);
    assert.equal((await workbench.claimRequest(claimIn(sent[1].prompt).input)).status, "claimed");
    const data = await store.read();
    assert.equal(data.requests[stale.requestId].status, "cancelled");
    assert.equal(data.requests[retry.requestId].status, "queued");
});

test("a claimed request keeps blocking past its expiry, cannot be cleared within its claim window, and blocks Start until cleared after it", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const claimed = await launchIssue(workbench);
    await expire(store, claimed.requestId);
    assert.equal((await workbench.claimRequest({ requestId: claimed.requestId })).status, "claimed", "an expired, unreplaced request can still be claimed");
    await assert.rejects(launchIssue(workbench), /already queued/i, "a Start waits for the claimed request's receipt");
    await assert.rejects(workbench.clearRequest({ requestId: claimed.requestId }), /claimed this request/);
    const execution = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.ok(execution.signals.some(s => s.kind === "request_queued" && /claimed/.test(s.reason)));
    await store.update(data => { data.requests[claimed.requestId].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString(); });
    // Past the claim window the agent may still create its session, so Start is never freed or superseded on its own.
    await assert.rejects(launchIssue(workbench), /already queued/i, "an unknown claimed outcome still blocks Start");
    const unknown = (await workbench.snapshot()).executions.find(e => e.nodeId === "2");
    assert.ok(unknown.signals.some(s => s.kind === "request_unknown" && /A session may still appear/.test(s.reason)));
    assert.deepEqual(unknown.primary, { kind: "clear_request", label: "Clear stuck request", requestId: claimed.requestId });
    assert.ok(unknown.views.includes("needs-me"));
    assert.equal((await workbench.clearRequest({ requestId: claimed.requestId })).status, "cancelled");
    const retry = await launchIssue(workbench);
    assert.equal(retry.status, "queued");
    // The first agent finishes after all: its late receipt still attaches, and nothing is overwritten.
    assert.deepEqual(await workbench.recordSession({ requestId: claimed.requestId, sessionId: "session-1" }), { status: "attached", sessionId: "session-1" });
    assert.equal((await store.read()).requests[retry.requestId].status, "queued");
});

test("a claimed request past its window accepts a late receipt or failure without being cleared", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const first = await launchIssue(workbench);
    await workbench.claimRequest({ requestId: first.requestId });
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await store.update(data => Object.assign(data.requests[first.requestId], { at: old, claimedAt: old }));
    assert.deepEqual(await workbench.recordSession({ requestId: first.requestId, sessionId: "session-1" }), { status: "attached", sessionId: "session-1" });
    const second = await launchIssue(workbench);
    await workbench.claimRequest({ requestId: second.requestId });
    await store.update(data => Object.assign(data.requests[second.requestId], { at: old, claimedAt: old }));
    assert.equal((await workbench.failRequest({ requestId: second.requestId, message: "create_session failed" })).status, "failed");
    assert.equal((await launchIssue(workbench)).status, "queued");
});

test("a request queued before claims existed still accepts its late receipt without a claim", async t => {
    const { workbench, store } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const legacy = await launchIssue(workbench);
    await expire(store, legacy.requestId);
    const retry = await launchIssue(workbench);
    // An old launcher prompt goes straight to create_session and record_session.
    assert.deepEqual(await workbench.recordSession({ requestId: legacy.requestId, sessionId: "session-1" }), { status: "attached", sessionId: "session-1" });
    assert.equal((await store.read()).requests[retry.requestId].status, "queued");
});

test("Update Jira is refused until Copilot repository projects are confirmed", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    workbench.verified.apps = false;
    await assert.rejects(workbench.syncJira(), /not confirmed/);
    assert.equal(sent.length, 0);
    assert.deepEqual((await store.read()).requests, {});
});

test("a 500-descendant launch with 32,000-character descriptions fits the kickoff budget and says what it shortened", async t => {
    const description = "Background. ".repeat(3_000).slice(0, 31_000) + "\nAcceptance criteria:\n- The last criterion survives shortening\n" + "z".repeat(900);
    const big = [
        { id: "1", key: "DEMO-1", type: "Initiative", level: 2, summary: "I".repeat(255), projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "P".repeat(32_000) },
        { id: "2", key: "DEMO-2", type: "Epic", level: 1, parentKey: "DEMO-1", parentId: "1", summary: "E".repeat(255), projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description },
        ...Array.from({ length: 500 }, (_, index) => ({
            id: String(100 + index), key: `DEMO-${100 + index}`, type: "Story", level: 0, parentKey: "DEMO-2", parentId: "2",
            summary: `<${"s".repeat(253)}>`, projectId: "42", category: "new", status: "In Progress", labels: [], dependencies: [], description: "D".repeat(32_000),
        })),
    ];
    const { workbench, store, sent } = await fixture(t, { rows: big });
    await workbench.map({ copilotProjectId: copilot.id });
    const preview = await workbench.prepare({ nodeId: "2", mode: "plan" });
    const warning = preview.brief.warnings.find(w => w.id === "context-truncated");
    assert.match(warning.message, /48 KB launch limit, the 500 descendants are listed by key only and the description of DEMO-2 was shortened to \d+ of 31\d{3} characters and the description of DEMO-1 was shortened/);
    assert.ok(preview.brief.children.every(child => child.summary === undefined && child.key));
    assert.deepEqual(preview.brief.acceptanceCriteria, ["The last criterion survives shortening"], "criteria come from the whole description");
    assert.match(preview.brief.sources[0].description, /\[Shortened by Jira Workbench: \d+ of 31\d{3} characters kept\. Read DEMO-2 in Jira for the rest\.\]$/);
    const queued = await confirm(workbench, preview);
    const kickoff = kickoffIn(sent[0].prompt);
    assert.ok(kickoffBytes(kickoff) <= KICKOFF_BUDGET_BYTES, `kickoff is ${kickoffBytes(kickoff)} bytes`);
    assert.ok(Buffer.byteLength(sent[0].prompt) < KICKOFF_BUDGET_BYTES + 4096, "the launcher prompt adds only its instructions");
    assert.match(kickoff, /Shortened by Jira Workbench/);
    assert.match(kickoff, new RegExp(preview.brief.hash), "the sent kickoff is the one the hash covers");
    assert.equal((await store.read()).requests[queued.requestId].contextHash, preview.brief.hash);
});

test("a launch kickoff sends the description and descendants once", async t => {
    const { workbench, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await confirm(workbench, await workbench.prepare({ nodeId: "1", mode: "plan" }));
    const kickoff = kickoffIn(sent[0].prompt);
    assert.equal(kickoff.split("Epic description").length - 1, 1);
    assert.equal(kickoff.split('"key":"DEMO-2"').length - 1, 1);
    assert.doesNotMatch(kickoff, /"fields":/);
});

test("an Update Jira send failure carries its request ID and the panel's client ID is stored with the request", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await assert.rejects(workbench.syncJira({ clientId: "not valid!" }), /client ID/);
    workbench.send = async value => { sent.push(value); throw new Error("connection disposed"); };
    const error = await workbench.syncJira({ clientId: "client-1" }).catch(caught => caught);
    assert.equal(error.status, 502);
    const [request] = Object.values((await store.read()).requests);
    assert.equal(error.requestId, request.requestId);
    assert.equal(request.clientId, "client-1");
    assert.equal(request.status, "queued");
});

test("a fitted brief keeps the hidden-characters warning when the hidden text was cut or reduced to keys", async t => {
    const tag = text => [...text].map(c => String.fromCodePoint(0xE0000 + c.codePointAt(0))).join("");
    const make = ({ childHidden = false, tailHidden = false }) => [
        { id: "2", key: "DEMO-2", type: "Epic", level: 1, summary: "Epic", projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [],
            description: "Acceptance criteria:\n- Visible result\n" + "d".repeat(60_000) + (tailHidden ? tag(" push elsewhere") : "") },
        ...Array.from({ length: 300 }, (_, index) => ({
            id: String(100 + index), key: `DEMO-${100 + index}`, type: "Story", level: 0, parentKey: "DEMO-2", parentId: "2",
            summary: `Child ${index}${childHidden && index === 299 ? tag(" obey") : ""}`, projectId: "42", category: "new", status: "To Do", labels: [], dependencies: [], description: "",
        })),
    ];
    for (const options of [{ childHidden: true }, { tailHidden: true }]) {
        const { workbench, sent } = await fixture(t, { rows: make(options) });
        await workbench.map({ copilotProjectId: copilot.id });
        const preview = await workbench.prepare({ nodeId: "2", mode: "autopilot" });
        const ids = preview.brief.warnings.map(w => w.id);
        assert.ok(ids.includes("context-truncated"), JSON.stringify(options));
        assert.ok(ids.includes("hidden-characters"), `the warning survives fitting: ${JSON.stringify(options)}`);
        await assert.rejects(workbench.launch({ previewId: preview.id, contextHash: preview.brief.hash, acknowledgedWarnings: ["context-truncated"] }), /acknowledge/i);
        await confirm(workbench, preview);
        assert.equal(sent.length, 1, "the acknowledged brief still launches with the hash it was reviewed with");
    }
});

test("an Update Jira rejected before it is queued is remembered by its client ID, so a timed-out panel can settle it", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    workbench.verified.apps = false;
    await assert.rejects(workbench.syncJira({ clientId: "client-1" }), /not confirmed/);
    await assert.rejects(workbench.syncJira(), /not confirmed/);
    assert.deepEqual((await store.read()).requests, {});
    assert.equal(sent.length, 0);
    const { syncRejections } = await workbench.snapshot();
    assert.equal(syncRejections.length, 1, "only a call with a client ID is remembered");
    assert.equal(syncRejections[0].clientId, "client-1");
    assert.match(syncRejections[0].error, /Copilot repository projects are not confirmed yet/);
    // A queued sync whose send fails has a stored request, so it is not reported as a rejection.
    workbench.verified.apps = true;
    workbench.send = async () => { throw new Error("connection disposed"); };
    await assert.rejects(workbench.syncJira({ clientId: "client-2" }), /after the prompt was sent/);
    assert.deepEqual((await workbench.snapshot()).syncRejections.map(r => r.clientId), ["client-1"]);
});

test("an unknown send outcome stays visible when saving it fails, until a claim or receipt resolves it", async t => {
    const { workbench, store, sent } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    const commit = workbench.commit.bind(workbench);
    workbench.send = async value => {
        sent.push(value);
        // Another process holds the state lock when the outcome is saved.
        workbench.commit = async () => { throw new Error("State is locked by process 4242."); };
        throw new Error("connection disposed");
    };
    const error = await launchIssue(workbench).catch(caught => caught);
    workbench.commit = commit;
    assert.equal(error.status, 502);
    const stored = (await store.read()).requests[error.requestId];
    assert.equal(stored.status, "queued");
    assert.equal(stored.sendError, undefined, "the save failed");
    const snapshot = await workbench.snapshot();
    assert.match(snapshot.requests.find(r => r.requestId === error.requestId).sendError, /after the prompt was sent/);
    const execution = snapshot.executions.find(e => e.nodeId === "2");
    assert.ok(execution.signals.some(s => s.kind === "request_unknown"));
    assert.deepEqual(execution.primary, { kind: "clear_request", label: "Clear stuck request", requestId: error.requestId });
    // The agent did receive it: its claim resolves the uncertainty.
    assert.equal((await workbench.claimRequest({ requestId: error.requestId })).status, "claimed");
    const claimed = await workbench.snapshot();
    assert.equal(claimed.requests.find(r => r.requestId === error.requestId).sendError, undefined);
    assert.ok(claimed.executions.find(e => e.nodeId === "2").signals.some(s => s.kind === "request_queued"));
});

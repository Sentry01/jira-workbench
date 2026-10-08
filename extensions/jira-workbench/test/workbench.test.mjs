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

test("switching project requires catalog membership and repository mapping is separate", async t => {
    const { workbench } = await fixture(t);
    await assert.rejects(workbench.select({ cloudId: site.id, jiraProjectId: "999" }), /project/i);
    await assert.rejects(workbench.map({ copilotProjectId: "42" }), /Copilot/i);
    await workbench.map({ copilotProjectId: copilot.id });
    const snapshot = await workbench.snapshot();
    assert.equal(snapshot.mapping.id, copilot.id);
    assert.equal(snapshot.project.id, "42");
    assert.equal(snapshot.tree.roots[0].children.length, 1);
});


test("failed refresh preserves last good hierarchy and marks it stale", async t => {
    const { workbench, gateway } = await fixture(t);
    gateway.issues = async () => { throw new Error("Connection expired"); };
    await workbench.refresh();
    const snapshot = await workbench.snapshot();
    assert.equal(snapshot.issues.length, 2);
    assert.match(snapshot.error, /Connection expired/);
    assert.equal(snapshot.stale, true);
});


test("project-scoped preferences survive reopening and reject stale-project writes", async t => {
    const { workbench, store, gateway } = await fixture(t);
    const scope = "cloud-demo/42/project";
    await workbench.savePreferences({ scope, preferences: { view: "hierarchy", selected: "2", query: "Loading", collapsed: ["1"], sprint: "sprint:12", scrollTop: 120 } });
    const other = new Workbench({ gateway, store, github: async () => ({}), send: async () => {}, instanceId: "other-panel" });
    await other.catalog();
    await other.select({ cloudId: site.id, jiraProjectId: project.id });
    await other.idle();
    assert.equal((await other.snapshot()).preferences.selected, "2");
    assert.equal((await other.snapshot()).preferences.sprint, "sprint:12");
    await assert.rejects(workbench.savePreferences({ scope: "other/42/project", preferences: { selected: "2" } }), /project|scope/i);
    await assert.rejects(workbench.savePreferences({ scope, preferences: { view: "invented" } }), /view/i);
    await assert.rejects(workbench.savePreferences({ scope, preferences: { sprint: "other-value" } }), /sprint/i);
});


test("project coordination enters the queue only for its own linked session or launch", async t => {
    const { workbench, gateway } = await fixture(t);
    await workbench.map({ copilotProjectId: copilot.id });
    await workbench.linkSession({ nodeId: "2", sessionId: "session-1" });
    assert.equal((await workbench.snapshot()).executions.some(item => item.nodeId === "project"), false);
    await workbench.linkSession({ nodeId: "project", sessionId: "session-1" });
    const original = gateway.call;
    gateway.call = async (name, args) => name === "get_sessions_status"
        ? { sessions: [{ id: "session-1", activity: { status: "idle" }, awaiting_plan_approval: true }] }
        : original(name, args);
    await workbench.refreshExecution();
    assert.equal((await workbench.snapshot()).executions.find(item => item.nodeId === "project")?.primary.label, "Review plan");
});

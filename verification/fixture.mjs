import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A synthetic project used by verification and documentation screenshots.
// It contains no real Jira, GitHub, or session data.

export const sessionIds = [2, 3, 4, 7].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
export const scope = "demo-site/42/project";

export function resolveRoot() {
    return process.env.WORKBENCH_ROOT
        || join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions/jira-workbench");
}

export async function loadModules(root = resolveRoot()) {
    const load = file => import(pathToFileURL(join(root, file)));
    const [{ Workbench }, { Store }, { HostActions }, { startServer }] = await Promise.all([
        load("lib/workbench.mjs"), load("lib/store.mjs"), load("lib/host-actions.mjs"), load("lib/server.mjs"),
    ]);
    return { Workbench, Store, HostActions, startServer };
}

const node = (n, extras = {}) => ({
    id: String(n), key: `DEMO-${n}`, projectId: "42", summary: `Work item ${n}`, type: "Story", level: 0,
    parentKey: n === 1 ? null : "DEMO-1", description: "An explicit source reference.", labels: [],
    category: "new", status: "To Do", dependencies: [], assignee: "Unassigned", priority: "Medium",
    updated: "revision-1", ...extras,
});

export const issues = [
    node(1, { type: "Epic", level: 1, summary: "Daily execution" }),
    node(2, { summary: "Needs your answer" }), node(3, { summary: "Running with a PR" }),
    node(4, { summary: "Merged work" }),
    node(5, { summary: "Missing criteria and blocked", dependencies: [{ key: "DEMO-6", relationship: "is blocked by", status: "To Do", category: "new" }] }),
    node(6, { summary: "Ready example", description: "## Acceptance criteria\n- Display the result" }),
    node(7, { summary: "Interrupted run" }), node(8, { parentKey: "DEMO-6", type: "Subtask", level: -1 }),
];

export async function createFixture({ directory, root = resolveRoot() }) {
    const modules = await loadModules(root);
    const sent = [], navigations = [], navigationSelections = [];
    const navigation = {
        pending: null, releaseFn: null, enteredFn: null,
        hold() { navigation.pending = new Promise(resolve => { navigation.releaseFn = resolve; }); },
        entered() { return new Promise(resolve => { navigation.enteredFn = resolve; }); },
        release() { navigation.releaseFn?.(); navigation.pending = null; navigation.releaseFn = null; },
    };
    const runtime = {
        send: async input => sent.push(input),
        rpc: { tools: {
            getCurrentMetadata: async () => ({ tools: [{ name: "navigate_to" }, { name: "navigate_to_github_item" }] }),
            execute: async input => {
                navigations.push(input);
                navigationSelections.push((await store.read()).preferences?.[scope]?.selected);
                navigation.enteredFn?.();
                if (navigation.pending) await navigation.pending;
                return { resultType: "success", textResultForLlm: "Navigating now." };
            },
        } },
    };
    const gateway = {
        sites: async () => [{ id: "demo-site", url: "https://example.atlassian.net", name: "Example" }],
        projects: async () => [{ id: "42", key: "DEMO", name: "Daily execution demo" }, { id: "43", key: "ALT", name: "Another project" }],
        issues: async (site, project) => ({ issues: project === "42" ? issues : [], fetchedAt: new Date().toISOString() }),
        // Project 42's workflow has a step no demo issue is in yet; project 43 lists none.
        statuses: async (site, project) => project === "42" ? [
            { name: "To Do", category: "new" }, { name: "In Progress", category: "indeterminate" },
            { name: "PR Waiting", category: "indeterminate" }, { name: "Done", category: "done" },
        ] : null,
        call: async (name, args) => {
            if (name === "list_projects") return [{ id: "app-project", name: "Example repo", github_repo: "example/demo" }];
            if (name === "get_sessions_status") return { sessions: sessionIds.map((id, index) => ({
                id, activity: { status: index === 1 ? "busy" : "idle" },
                awaiting_user_input: index === 0,
                awaiting_input: index === 0 ? { question: "Which behavior should be preserved?", choices: ["Existing", "New"], request_id: "q1" } : null,
                was_interrupted: index === 3,
            })) };
            if (name === "get_session") {
                const index = sessionIds.indexOf(args.project_session_id);
                return {
                    id: args.project_session_id, name: `Session ${index}`, project_id: "app-project", branch: `feature-${index}`,
                    created_pr_number: index === 3 ? null : 12 + index, created_pr_repo: "example/demo",
                };
            }
            throw new Error(`Unexpected fake gateway call: ${name}`);
        },
    };
    const github = async (repo, number) => ({
        number, repo, url: `https://github.com/${repo}/pull/${number}`,
        title: `Verified PR ${number}`, state: number === 14 ? "MERGED" : "OPEN", isDraft: false,
        statusCheckRollup: [], reviewDecision: "REVIEW_REQUIRED",
    });
    const store = new modules.Store(directory);
    const workbench = new modules.Workbench({
        gateway, store, github, instanceId: "fixture-workbench", send: runtime.send,
        hostActions: new modules.HostActions({ session: runtime, instanceId: "fixture-workbench" }),
    });
    return { workbench, store, gateway, github, sent, navigations, navigationSelections, navigation, startServer: modules.startServer };
}

/** Select the demo project, map its repository, and link the demo sessions. */
export async function seedProject(workbench) {
    await workbench.catalog();
    await workbench.select({ cloudId: "demo-site", jiraProjectId: "42" });
    await workbench.map({ copilotProjectId: "app-project" });
    for (const [index, n] of [2, 3, 4, 7].entries()) await workbench.linkSession({ nodeId: String(n), sessionId: sessionIds[index] });
    await workbench.refreshExecution();
}

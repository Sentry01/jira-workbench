import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection } from "./lib/connection.mjs";
import { Store } from "./lib/store.mjs";
import { Cache } from "./lib/cache.mjs";
import { Workbench } from "./lib/workbench.mjs";
import { startServer } from "./lib/server.mjs";
import { readPr } from "./lib/github.mjs";
import { HostActions } from "./lib/host-actions.mjs";
import { Updater } from "./lib/updater.mjs";
import { version } from "./lib/version.mjs";

const panels = new Map();
const stateDir = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "jira-workbench", "artifacts", ".local");
const store = new Store(stateDir), cache = new Cache(stateDir);
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
const string = { type: "string", minLength: 1 };
const schema = (properties = {}, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const action = (name, description, inputSchema, run) => ({
    name, description, inputSchema,
    handler: async ctx => {
        const entry = panels.get(ctx.instanceId);
        if (!entry) throw new CanvasError("workbench_not_open", "Reopen Jira Workbench first.");
        try { return await run(entry.workbench, ctx.input); }
        catch (error) { throw new CanvasError("workbench_action_failed", error.message); }
    },
});

let connection, updater;
const session = await joinSession({
    canvases: [createCanvas({
        id: "jira-workbench", displayName: "Jira Workbench",
        description: "Browse any Jira project's hierarchy and trace issues to Copilot sessions and GitHub PRs; Jira read-only.",
        inputSchema: schema({ cloudId: string, jiraProjectId: string }, []),
        actions: [
            action("get_state", "Read the hierarchy, durable trace links, queued launches and source freshness.", schema(), w => w.snapshot()),
            action("refresh_catalog", "Discover accessible Jira sites and Copilot repository projects.", schema(), w => w.catalog({ fresh: true })),
            action("select_project", "Show a Jira project, including its backlog, epics and subtasks.", schema({ cloudId: string, jiraProjectId: string }), (w, input) => w.select(input)),
            action("configure_repository", "Save the separate Copilot repository mapping for the selected Jira project.", schema({ copilotProjectId: string }), (w, input) => w.map(input)),
            action("refresh", "Refresh Jira hierarchy; preserve but mark stale data on failure.", schema(), w => w.refresh({ fresh: true })),
            action("refresh_execution", "Reconcile linked session intervention signals and GitHub evidence for this project.", schema({ source: { type: "string", enum: ["all", "sessions", "github"] } }, []), (w, input) => w.refreshExecution(input)),
            action("refresh_trace", "Verify sessions, PRs and checks for a hierarchy item.", schema({ nodeId: string }), (w, input) => w.refreshTrace(input.nodeId)),
            action("link_session", "Link an existing app session to an issue ID or project node after checking repository identity.", schema({ nodeId: string, sessionId: string }), (w, input) => w.linkSession(input)),
            action("record_session", "Record the actual session returned by create_session for a queued Workbench launch.", schema({ requestId: string, sessionId: string }), (w, input) => w.recordSession(input)),
            action("fail_request", "Record why a queued session launch could not be completed.", schema({ requestId: string, message: string }), (w, input) => w.failRequest(input)),
            action("record_navigation", "Acknowledge the actual native navigation result for a queued fallback request.", schema({ requestId: string, ok: { type: "boolean" }, message: string }), (w, input) => w.hostActions.acknowledge(input)),
            action("inspect_connections", "List available integration tool names for troubleshooting; does not execute them.", schema(), async w => (await w.gateway.metadata()).filter(t => /Jira|Atlassian|list_projects|get_session|list_sessions|navigate_to/.test(t.name)).map(t => ({ name: t.name, mcpToolName: t.mcpToolName }))),
        ],
        open: async ctx => {
            await ready;
            let entry = panels.get(ctx.instanceId);
            if (!entry) {
                const workbench = new Workbench({
                    gateway: connection.gateway, store, cache, github: readPr,
                    hostActions: new HostActions({ session, instanceId: ctx.instanceId }),
                    send: options => session.send(options), instanceId: ctx.instanceId,
                });
                const requested = ctx.input?.cloudId && ctx.input?.jiraProjectId ? { cloudId: ctx.input.cloudId, jiraProjectId: ctx.input.jiraProjectId } : null;
                // Paint from the shared disk snapshot now; live sources revalidate behind the open panel.
                await workbench.hydrate(requested).catch(() => false);
                // One updater per extension process, shared by its panels and checking only while one is open.
                updater ??= new Updater({ ...await version(), session });
                const server = await startServer(workbench, { updater });
                entry = { workbench, server };
                panels.set(ctx.instanceId, entry);
                updater.acquire();
                connection.attach(workbench);
                void workbench.background(() => workbench.warm(requested));
            }
            return { title: "Jira Workbench", url: entry.server.url, status: "Read-only Jira · hierarchy and traceability" };
        },
        onClose: async ctx => {
            const entry = panels.get(ctx.instanceId);
            if (!entry) return;
            panels.delete(ctx.instanceId);
            connection.detach(entry.workbench);
            updater.release();
            entry.workbench.close();
            await entry.server.close();
        },
    })],
});
// The one supervisor of the Atlassian connection, shared by every panel: the first open often races MCP startup.
connection = new Connection(session).start();
resolveReady();

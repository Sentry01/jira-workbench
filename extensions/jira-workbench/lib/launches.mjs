import { randomUUID } from "node:crypto";
import { launchPrompt, jiraSyncPrompt, descendants, requestStatus } from "./model.mjs";
import { createBrief, acknowledgeBrief } from "./brief.mjs";
import { dependencyWarnings } from "./execution.mjs";

// Launch and request lifecycle: briefs, previews, queued requests and their receipts, failures or clears.
// Panel state (selection, issues, previews, store, send) stays on the Workbench and is read through it.
export class Launches {
    constructor(workbench) { this.workbench = workbench; }
    makeBrief(node, mode, fields, mapping) {
        const wb = this.workbench;
        return createBrief({
            node, parent: wb.issues.find(issue => issue.key === node.parentKey),
            children: descendants(wb.issues, node.id), mapping, siteUrl: wb.site.url, mode, fields,
            dependencyWarnings: dependencyWarnings(node),
        });
    }
    async prepare({ nodeId, mode, fields }) {
        const wb = this.workbench;
        const scope = wb.selectedScope(nodeId), node = wb.node(nodeId);
        if (wb.error) throw new Error("Refresh Jira successfully before starting work from stale data.");
        if (wb.cached) throw new Error("Jira is still refreshing the cached snapshot. Try again when it is current.");
        const data = await wb.store.read(), mapping = data.mappings[wb.selectedScope()];
        if (scope !== wb.selectedScope(nodeId)) throw new Error("Project changed while preparing the brief.");
        if (!mapping) throw new Error("Select the Copilot repository for this Jira project before starting a session.");
        if (!wb.verified.apps) throw new Error("Copilot repository projects are not confirmed yet. Reload connections and try again.");
        if (!wb.appProjects.some(p => p.id === mapping.id)) throw new Error("The mapped Copilot project is no longer available; choose another repository.");
        mode ||= node.level > 0 ? "plan" : "autopilot";
        if (!["plan", "autopilot"].includes(mode)) throw new Error("Choose Plan or Autopilot.");
        const children = descendants(wb.issues, nodeId).map(child => ({ id: child.id, key: child.key, summary: child.summary, status: child.status }));
        if (children.length > 500) throw new Error("This scope contains more than 500 descendants. Select a smaller epic or issue.");
        const preview = {
            id: randomUUID(), scope, node, children, mapping, mode, expiresAt: Date.now() + 300_000,
            existing: data.links[scope]?.sessions || [],
            cloudId: wb.site.id, jiraProjectId: wb.project.id, siteUrl: wb.site.url,
            brief: this.makeBrief(node, mode, fields, mapping),
        };
        for (const [id, p] of wb.previews) if (p.expiresAt < Date.now()) wb.previews.delete(id);
        wb.previews.set(preview.id, preview);
        return preview;
    }
    async launch({ previewId, contextHash, acknowledgedWarnings }) {
        const wb = this.workbench;
        const preview = wb.previews.get(previewId);
        if (!preview || preview.expiresAt < Date.now()) throw new Error("The launch preview expired or was already used. Review the scope again.");
        if (preview.scope !== wb.selectedScope(preview.node.id)) throw new Error("Project changed after preview. Review the scope again.");
        if (wb.error) throw new Error("Jira data is stale. Refresh and review the brief again.");
        if (wb.cached) throw new Error("Jira data is a cached snapshot. Refresh and review the brief again.");
        const currentData = await wb.store.read();
        const currentMapping = currentData.mappings[wb.selectedScope()];
        if (!currentMapping || currentMapping.id !== preview.mapping.id) throw new Error("Repository mapping changed after preview.");
        const currentBrief = this.makeBrief(wb.node(preview.node.id), preview.mode, preview.brief.fields, currentMapping);
        if (currentBrief.hash !== preview.brief.hash) throw new Error("Source context or warnings changed. Review a new preview before launching.");
        const acknowledged = acknowledgeBrief(preview.brief, { contextHash, acknowledgedWarnings });
        const requestId = randomUUID();
        const request = {
            requestId, previewId: preview.id, scope: preview.scope, nodeId: preview.node.id, issueKey: preview.node.key,
            cloudId: preview.cloudId, jiraProjectId: preview.jiraProjectId,
            copilotProjectId: preview.mapping.id, mode: preview.mode, status: "queued", at: new Date().toISOString(),
            // Descendants are kept as keys only: the UI never shows their summaries, and contextHash covers them.
            contextHash: preview.brief.hash, acknowledgedWarnings: acknowledged,
            brief: { ...structuredClone(preview.brief), children: preview.brief.children.map(child => child.key) },
        };
        await wb.store.update(data => {
            if (data.mappings[wb.selectedScope()]?.id !== preview.mapping.id) throw new Error("Repository mapping changed after preview.");
            if (Object.values(data.requests).some(r => r.scope === preview.scope && requestStatus(r) === "queued"))
                throw new Error("A session request is already queued for this scope. Wait for its receipt; do not create a duplicate.");
            data.requests[requestId] = request;
        });
        wb.previews.delete(previewId);
        try {
            await wb.send({ prompt: launchPrompt({
                ...preview, requestId, instanceId: wb.instanceId,
                copilotProjectId: preview.mapping.id, repo: preview.mapping.repo,
            }) });
        } catch (error) {
            await this.failRequest({ requestId, message: `Could not queue launch: ${error.message}` });
            throw error;
        }
        return { status: "queued", requestId };
    }
    async syncJira() {
        const wb = this.workbench;
        const site = wb.site, project = wb.project;
        if (!site || !project) throw new Error("Select a Jira project first.");
        if (wb.error) throw new Error("Refresh Jira successfully before syncing statuses from stale data.");
        if (wb.cached) throw new Error("Jira data is a cached snapshot. Refresh before syncing statuses.");
        const scope = wb.selectedScope(), data = await wb.store.read(), mapping = data.mappings[scope];
        if (scope !== wb.selectedScope()) throw new Error("Project changed while preparing the sync.");
        if (!mapping) throw new Error("Select the Copilot repository for this Jira project before syncing statuses.");
        if (!wb.appProjects.some(p => p.id === mapping.id)) throw new Error("The mapped Copilot project is no longer available; choose another repository.");
        const linked = wb.issues.flatMap(issue => {
            const link = data.links[wb.selectedScope(issue.id)];
            if (!link?.sessions?.length && !link?.prs?.length) return [];
            const freshness = name => link.sourceStatus?.[name]?.state || "unknown";
            return [{
                key: issue.key, summary: issue.summary, status: issue.status, category: issue.category,
                sourceFreshness: { sessions: freshness("sessions"), github: freshness("github") },
                sessions: (link.sessions || []).map(s => ({ name: s.name, activity: s.activity, stale: Boolean(s.stale), branch: s.branch, prRepo: s.prRepo, prNumber: s.prNumber })),
                prs: (link.prs || []).map(pr => ({ repo: pr.repo, number: pr.number, state: pr.state, isDraft: pr.isDraft, stale: Boolean(pr.stale), url: pr.url })),
            }];
        });
        const evidence = linked.slice(0, 300);
        const requestId = randomUUID();
        const prompt = jiraSyncPrompt({
            requestId, instanceId: wb.instanceId, cloudId: site.id, siteUrl: site.url,
            jiraProjectId: project.id, projectKey: project.key,
            copilotProjectId: mapping.id, repo: mapping.repo, evidence, omittedLinkedIssues: linked.length - evidence.length,
        });
        await wb.store.update(current => {
            if (wb.selectedScope() !== scope || wb.site?.id !== site.id || wb.project?.id !== project.id)
                throw new Error("Project changed while preparing the sync. Confirm Update Jira again for the selected project.");
            if (current.mappings[scope]?.id !== mapping.id) throw new Error("Repository mapping changed while preparing the sync.");
            if (Object.values(current.requests).some(r => r.scope === scope && requestStatus(r) === "queued"))
                throw new Error("A session request is already queued for this project. Wait for its receipt; do not create a duplicate.");
            current.requests[requestId] = {
                requestId, kind: "jira-sync", scope, nodeId: "project", issueKey: project.key,
                cloudId: site.id, jiraProjectId: project.id, copilotProjectId: mapping.id,
                mode: "autopilot", status: "queued", at: new Date().toISOString(),
            };
        });
        try { await wb.send({ prompt }); }
        catch (error) {
            await this.failRequest({ requestId, message: `Could not queue Jira sync: ${error.message}` });
            throw error;
        }
        return { status: "queued", requestId };
    }
    async recordSession({ requestId, sessionId }) {
        const wb = this.workbench;
        const data = await wb.store.read(), request = data.requests[requestId];
        if (!request) throw new Error("Unknown launch request; no session was attached.");
        const status = requestStatus(request);
        if (status === "attached") {
            if (request.sessionId !== sessionId) throw new Error("This request already has a different session receipt.");
            return { status: "attached", sessionId };
        }
        // A late receipt for an expired or cleared request still records the session that was actually created.
        if (!["queued", "expired", "cancelled"].includes(status)) throw new Error("This request is not awaiting a session receipt.");
        await wb.attach(request.scope, sessionId, request.copilotProjectId, requestId);
        return { status: "attached", sessionId };
    }
    async failRequest({ requestId, message }) {
        const wb = this.workbench;
        if (typeof message !== "string" || !message.trim()) throw new Error("A failure message is required.");
        await wb.store.update(data => {
            const request = data.requests[requestId];
            if (request?.status === "cancelled") throw new Error("This request was cleared in the Workbench; no failure was recorded.");
            if (!request || !["queued", "expired"].includes(requestStatus(request))) throw new Error("This request is not awaiting a receipt.");
            Object.assign(request, { status: "failed", error: message.slice(0, 2000) });
        });
        return { status: "failed", requestId };
    }
    // The user's way out of a request whose receipt never arrived; a late receipt can still attach it.
    async clearRequest({ requestId } = {}) {
        const wb = this.workbench;
        if (typeof requestId !== "string" || !requestId) throw new Error("A request ID is required.");
        wb.selectedScope();
        await wb.store.update(data => {
            const request = Object.hasOwn(data.requests, requestId) ? data.requests[requestId] : null;
            if (typeof request?.nodeId !== "string" || !request.nodeId || request.scope !== wb.selectedScope(request.nodeId))
                throw new Error("That request is not in the selected Jira project.");
            if (!["queued", "expired"].includes(requestStatus(request)))
                throw new Error("Only a queued or expired request can be cleared.");
            Object.assign(request, { status: "cancelled", cancelledAt: new Date().toISOString() });
        });
        return { status: "cancelled", requestId };
    }
}

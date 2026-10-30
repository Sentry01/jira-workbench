import { randomUUID } from "node:crypto";
import { launchPrompt, jiraSyncPrompt, descendants, projectStatuses, requestStatus, writableIssue, issueParent, issueIndex } from "./model.mjs";
import { createBrief, acknowledgeBrief } from "./brief.mjs";
import { dependencyWarnings } from "./execution.mjs";

// The loaded working set can miss children when the scope filters items or more pages remain.
const partialScope = wb => ({ filtered: wb.workingScope.kind !== "project", more: Boolean(wb.page.nextPageToken) });

// Launch and request lifecycle: briefs, previews, queued requests and their receipts, failures or clears.
// Panel state (selection, issues, previews, store, send) stays on the Workbench and is read through it.
export class Launches {
    constructor(workbench) { this.workbench = workbench; }
    makeBrief(node, mode, fields, mapping, smartCommitComment = false) {
        const wb = this.workbench;
        const children = descendants(wb.issues, node.id);
        const { filtered, more } = partialScope(wb);
        // A project or parent brief lists only loaded descendants; say so whenever the working set is not the whole project.
        const partial = node.level > 0 && (filtered || more) ? [{
            id: "partial-context",
            message: `Only ${children.length} loaded descendant${children.length === 1 ? " is" : "s are"} included${more ? "; more scope pages remain in Jira" : ""}${filtered ? "; the working scope filters which items load" : ""}. Other child work may exist.`,
        }] : [];
        return createBrief({
            node, parent: issueParent(node, issueIndex(wb.issues)),
            children, mapping, siteUrl: wb.site.url, mode, fields,
            dependencyWarnings: [...partial, ...dependencyWarnings(node)], smartCommitComment,
        });
    }
    async prepare({ nodeId, mode, fields, smartCommitComment = false }) {
        const wb = this.workbench;
        const scope = wb.selectedScope(nodeId), node = wb.node(nodeId);
        const workingSetKey = wb.loadKey(), scopeGeneration = wb.refreshGeneration;
        if (node.contextOnly) throw new Error("This item is context only. Include it in a project working scope before launching work.");
        if (node.unverified) throw new Error("Jira did not re-read this linked item. Refresh before starting work from it.");
        if (wb.error) throw new Error("Refresh Jira successfully before starting work from stale data.");
        if (wb.cached) throw new Error("Jira is still refreshing the cached snapshot. Try again when it is current.");
        const data = await wb.store.read(), mapping = data.mappings[wb.selectedScope()];
        if (scope !== wb.selectedScope(nodeId)) throw new Error("Project changed while preparing the brief.");
        if (workingSetKey !== wb.loadKey() || scopeGeneration !== wb.refreshGeneration) throw new Error("Working scope changed while preparing the brief.");
        if (!mapping) throw new Error("Select the Copilot repository for this Jira project before starting a session.");
        if (!wb.verified.apps) throw new Error("Copilot repository projects are not confirmed yet. Reload connections and try again.");
        if (!wb.appProjects.some(p => p.id === mapping.id)) throw new Error("The mapped Copilot project is no longer available; choose another repository.");
        mode ||= node.level > 0 ? "plan" : "autopilot";
        if (!["plan", "autopilot"].includes(mode)) throw new Error("Choose Plan or Autopilot.");
        if (typeof smartCommitComment !== "boolean") throw new Error("The Smart Commit comment choice must be true or false.");
        if (smartCommitComment && !writableIssue(node, wb.site.id)) throw new Error("A Smart Commit comment is available only for a single Jira issue.");
        const children = descendants(wb.issues, nodeId).map(child => ({ id: child.id, key: child.key, summary: child.summary, status: child.status }));
        if (children.length > 500) throw new Error("This scope contains more than 500 descendants. Select a smaller epic or issue.");
        const preview = {
            id: randomUUID(), scope, node, children, mapping, mode, smartCommitComment, expiresAt: Date.now() + 300_000,
            workingSetKey, scopeGeneration,
            existing: data.links[scope]?.sessions || [],
            cloudId: wb.site.id, jiraProjectId: wb.project.id, siteUrl: wb.site.url,
            brief: this.makeBrief(node, mode, fields, mapping, smartCommitComment),
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
        if (preview.workingSetKey !== wb.loadKey()) throw new Error("Working scope changed after preview. Review the scope again.");
        if (wb.error) throw new Error("Jira data is stale. Refresh and review the brief again.");
        if (wb.cached) throw new Error("Jira data is a cached snapshot. Refresh and review the brief again.");
        const currentData = await wb.store.read();
        if (preview.workingSetKey !== wb.loadKey() || preview.scopeGeneration !== wb.refreshGeneration)
            throw new Error("Working scope changed after preview. Review the scope again.");
        const currentMapping = currentData.mappings[wb.selectedScope()];
        if (!currentMapping || currentMapping.id !== preview.mapping.id) throw new Error("Repository mapping changed after preview.");
        const currentBrief = this.makeBrief(wb.node(preview.node.id), preview.mode, preview.brief.fields, currentMapping, preview.smartCommitComment);
        if (currentBrief.hash !== preview.brief.hash) throw new Error("Source context or warnings changed. Review a new preview before launching.");
        const acknowledged = acknowledgeBrief(preview.brief, { contextHash, acknowledgedWarnings });
        const requestId = randomUUID();
        const request = {
            requestId, previewId: preview.id, scope: preview.scope, nodeId: preview.node.id, issueKey: preview.node.key,
            cloudId: preview.cloudId, jiraProjectId: preview.jiraProjectId,
            copilotProjectId: preview.mapping.id, mode: preview.mode, smartCommitComment: preview.smartCommitComment,
            status: "queued", at: new Date().toISOString(),
            // Descendants are kept as keys only: the UI never shows their summaries, and contextHash covers them.
            contextHash: preview.brief.hash, acknowledgedWarnings: acknowledged,
            brief: { ...structuredClone(preview.brief), children: preview.brief.children.map(child => child.key) },
        };
        await wb.commit(data => {
            if (wb.previews.get(previewId) !== preview || preview.expiresAt < Date.now())
                throw new Error("The launch preview was invalidated while launching. Review the scope again.");
            if (preview.workingSetKey !== wb.loadKey() || preview.scopeGeneration !== wb.refreshGeneration)
                throw new Error("Working scope changed while launching. Review the scope again.");
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
                // Any issue that can have children, including a story's subtasks; the scope was checked unchanged above.
                partialChildren: preview.node.level >= 0 && Object.values(partialScope(wb)).some(Boolean),
            }) });
        } catch (error) {
            await this.failRequest({ requestId, message: `Could not queue launch: ${error.message}` });
            throw error;
        }
        return { status: "queued", requestId };
    }
    async syncJira() {
        const wb = this.workbench;
        // Read everything from the selected project now: an await below can outlast a project switch.
        const site = wb.site, project = wb.project, selection = wb.selections, issues = wb.issues, statuses = wb.statuses;
        if (!site || !project) throw new Error("Select a Jira project first.");
        if (wb.error) throw new Error("Refresh Jira successfully before syncing statuses from stale data.");
        if (wb.cached) throw new Error("Jira data is a cached snapshot. Refresh before syncing statuses.");
        const scope = wb.selectedScope(), data = await wb.store.read(), mapping = data.mappings[scope];
        if (wb.selections !== selection) throw new Error("Project changed while preparing the sync.");
        if (!mapping) throw new Error("Select the Copilot repository for this Jira project before syncing statuses.");
        if (!wb.appProjects.some(p => p.id === mapping.id)) throw new Error("The mapped Copilot project is no longer available; choose another repository.");
        const prefix = scope.slice(0, scope.lastIndexOf("/") + 1);
        const durable = Object.entries(data.links).filter(([key, link]) => key.startsWith(prefix)
            && /^\d+$/.test(key.slice(prefix.length)) && (link.sessions?.length || link.prs?.length));
        const candidates = durable.slice(0, 300);
        const byId = new Map(issues.filter(issue => issue.projectId === project.id && !issue.unverified).map(issue => [issue.id, issue]));
        // Linked issues not loaded here (linked by another panel since the last read, or not re-read) are read now.
        const missing = candidates.map(([key]) => key.slice(prefix.length)).filter(id => !byId.has(id));
        if (missing.length && wb.gateway.lookupIssues) {
            try { for (const issue of await wb.jira(options => wb.gateway.lookupIssues(site.id, project.id, missing, options))) byId.set(issue.id, issue); }
            catch { /* identities that could not be read are reported as omitted below */ }
        }
        const evidence = candidates.flatMap(([key, link]) => {
            const issue = byId.get(key.slice(prefix.length));
            if (!issue) return [];
            const freshness = name => link.sourceStatus?.[name]?.state || "unknown";
            return [{
                key: issue.key, summary: issue.summary, status: issue.status, category: issue.category,
                sourceFreshness: { sessions: freshness("sessions"), github: freshness("github") },
                sessions: (link.sessions || []).map(s => ({ name: s.name, activity: s.activity, stale: Boolean(s.stale), branch: s.branch, prRepo: s.prRepo, prNumber: s.prNumber })),
                prs: (link.prs || []).map(pr => ({ repo: pr.repo, number: pr.number, state: pr.state, isDraft: pr.isDraft, stale: Boolean(pr.stale), url: pr.url })),
            }];
        });
        const omittedLinkedIssues = durable.length - evidence.length;
        const requestId = randomUUID();
        const prompt = jiraSyncPrompt({
            requestId, instanceId: wb.instanceId, cloudId: site.id, siteUrl: site.url,
            jiraProjectId: project.id, projectKey: project.key,
            copilotProjectId: mapping.id, repo: mapping.repo, evidence, omittedLinkedIssues,
            statuses: projectStatuses(statuses, issues.filter(issue => issue.projectId === project.id)),
        });
        await wb.store.update(current => {
            // The selection count also rejects a switch to another project and back while this was prepared.
            if (wb.selections !== selection || wb.selectedScope() !== scope || wb.site?.id !== site.id || wb.project?.id !== project.id)
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

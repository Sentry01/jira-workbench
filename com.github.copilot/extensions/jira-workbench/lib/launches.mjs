import { randomUUID } from "node:crypto";
import { launchPrompt, launchKickoff, jiraSyncPrompt, descendants, projectStatuses, requestStatus, writableIssue, issueParent, issueIndex, kickoffBytes, KICKOFF_BUDGET_BYTES, CLAIM_TTL_MS, BLOCKING_REQUEST } from "./model.mjs";
import { createBrief, acknowledgeBrief } from "./brief.mjs";
import { dependencyWarnings } from "./execution.mjs";

// The loaded working set can miss children when the scope filters items or more pages remain.
const partialScope = wb => ({ filtered: wb.workingScope.kind !== "project", more: Boolean(wb.page.nextPageToken) });

// session.send has no time limit of its own; past this the launch outcome is reported as unknown.
const SEND_TIMEOUT_MS = 30_000;
// Update Jira calls refused before queueing, kept by the panel's client ID for this panel's lifetime.
const SYNC_REJECTIONS_KEPT = 20;

const clip = (text, limit) => text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");

// Shares a character total across texts: short texts keep their length, the longest give up the most.
function share(lengths, total) {
    const limits = [];
    let left = Math.max(0, total), count = lengths.length;
    for (const [length, index] of lengths.map((length, index) => [length, index]).sort((a, b) => a[0] - b[0])) {
        limits[index] = Math.min(length, Math.floor(left / count--));
        left -= limits[index];
    }
    return limits;
}

// Fits a launch to the kickoff budget before its brief is hashed, so the hash covers exactly what is sent. First the
// descendants become keys only, then the selected and parent descriptions are shortened with an explicit marker, and a
// hashed warning says what was left out. Context that still does not fit is refused rather than sent.
function fitBrief(build, measure, { node, parent, children }) {
    let brief = build({ children, node, parent, warnings: [] });
    if (measure(brief) <= KICKOFF_BUDGET_BYTES) return brief;
    const notes = [], keys = children.map(({ id, key }) => ({ id, key }));
    if (children.length) notes.push(`the ${children.length} descendant${children.length === 1 ? " is" : "s are"} listed by key only`);
    const warning = extra => [{
        id: "context-truncated",
        message: `To fit the ${KICKOFF_BUDGET_BYTES / 1024} KB launch limit, ${[...notes, ...extra].join(" and ")}. The session can read the full issues in Jira.`,
    }];
    brief = build({ children: keys, node, parent, warnings: warning([]) });
    let over = measure(brief) - KICKOFF_BUDGET_BYTES;
    const texts = [node, parent].filter(issue => issue?.description);
    let limits = texts.map(issue => issue.description.length);
    for (let round = 0; over > 0 && round < 8 && limits.some(Boolean); round++) {
        limits = share(limits, limits.reduce((sum, limit) => sum + limit, 0) - over);
        const cut = issue => {
            const index = texts.indexOf(issue), limit = limits[index], length = issue?.description?.length;
            if (index < 0 || limit >= length) return issue;
            return { ...issue, description: `${clip(issue.description, limit)}\n\n[Shortened by Jira Workbench: ${limit} of ${length} characters kept. Read ${issue.key} in Jira for the rest.]` };
        };
        const extra = texts.flatMap((issue, index) => limits[index] < issue.description.length
            ? [`the description of ${issue.key} was shortened to ${limits[index]} of ${issue.description.length} characters`] : []);
        brief = build({ children: keys, node: cut(node), parent: cut(parent), warnings: warning(extra) });
        over = measure(brief) - KICKOFF_BUDGET_BYTES;
    }
    if (over > 0) throw new Error(`The Jira context for ${node.key} is too large to launch (${Math.ceil((over + KICKOFF_BUDGET_BYTES) / 1024)} KB of ${KICKOFF_BUDGET_BYTES / 1024} KB) even with shortened descriptions. Select a smaller scope or trim the issue's links.`);
    return brief;
}

// Launch and request lifecycle: briefs, previews, queued requests and their receipts, failures or clears.
// Panel state (selection, issues, previews, store, send) stays on the Workbench and is read through it.
export class Launches {
    constructor(workbench) {
        this.workbench = workbench;
        this.sendTimeoutMs = SEND_TIMEOUT_MS;
        this.syncRejections = new Map();
        // Unknown send outcomes not yet saved (the state write failed), by request ID, shown until saved or resolved.
        this.sendErrors = new Map();
    }
    makeBrief(node, mode, fields, mapping, smartCommitComment = false) {
        const wb = this.workbench;
        const children = descendants(wb.issues, node.id);
        const { filtered, more } = partialScope(wb);
        // A project or parent brief lists only loaded descendants; say so whenever the working set is not the whole project.
        const partial = node.level > 0 && (filtered || more) ? [{
            id: "partial-context",
            message: `Only ${children.length} loaded descendant${children.length === 1 ? " is" : "s are"} included${more ? "; more scope pages remain in Jira" : ""}${filtered ? "; the working scope filters which items load" : ""}. Other child work may exist.`,
        }] : [];
        const parent = issueParent(node, issueIndex(wb.issues));
        const build = ({ children: listed, node: selected, parent: context, warnings }) => createBrief({
            node: selected, parent: context, children: listed, mapping, siteUrl: wb.site.url, mode, fields,
            dependencyWarnings: [...partial, ...dependencyWarnings(node), ...warnings], smartCommitComment,
            criteriaText: node.description, hiddenIn: [node, parent, ...children],
        });
        // Measured as the launch sends it; the partial-children sentence is counted whether or not it is sent.
        const measure = brief => kickoffBytes(launchKickoff({
            cloudId: wb.site.id, jiraProjectId: wb.project.id, repo: mapping.repo, siteUrl: wb.site.url,
            node, mode, brief, smartCommitComment, partialChildren: true,
        }));
        return fitBrief(build, measure, { node, parent, children });
    }
    // Sends a launcher prompt. A rejection does not prove the host refused it (it can admit the prompt and then lose
    // the reply), and a send that never settles says nothing either, so both keep the request queued: its receipt
    // still attaches, the duplicate fence still holds, and nothing is retried.
    async deliver(requestId, prompt) {
        const wb = this.workbench;
        let timer;
        const sending = Promise.resolve().then(() => wb.send({ prompt }));
        sending.catch(() => {});
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(
                new Error(`Copilot did not confirm it received the prompt within ${Math.round(this.sendTimeoutMs / 1000)}s`), { status: 504 })), this.sendTimeoutMs);
        });
        try { await Promise.race([sending, timeout]); }
        catch (error) {
            const status = error?.status === 504 ? 504 : 502;
            const cause = status === 504 ? error.message : `Copilot reported an error after the prompt was sent (${String(error?.message || error).slice(0, 300)})`;
            this.sendErrors.set(requestId, cause);
            await wb.commit(data => {
                const request = Object.hasOwn(data.requests, requestId) ? data.requests[requestId] : null;
                if (request?.status === "queued") request.sendError = cause;
            }).then(() => this.sendErrors.delete(requestId), () => {});
            throw Object.assign(new Error(cause), { status, outcome: "unknown", requestId });
        } finally { clearTimeout(timer); }
    }
    // A stored request as the panel should see it: with its unsaved unknown send outcome, until a claim, a receipt,
    // a failure or a clear resolves it, or a later write saves it.
    withSendError(request) {
        const cause = this.sendErrors.get(request?.requestId);
        if (cause === undefined) return request;
        if (request.status !== "queued" || request.claimedAt || request.sendError) {
            this.sendErrors.delete(request.requestId);
            return request;
        }
        return { ...request, sendError: cause };
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
        const prompt = launchPrompt({
            ...preview, requestId, instanceId: wb.instanceId,
            copilotProjectId: preview.mapping.id, repo: preview.mapping.repo,
            // Any issue that can have children, including a story's subtasks; the scope was checked unchanged above.
            partialChildren: preview.node.level >= 0 && Object.values(partialScope(wb)).some(Boolean),
        });
        await wb.commit(data => {
            if (wb.previews.get(previewId) !== preview || preview.expiresAt < Date.now())
                throw new Error("The launch preview was invalidated while launching. Review the scope again.");
            if (preview.workingSetKey !== wb.loadKey() || preview.scopeGeneration !== wb.refreshGeneration)
                throw new Error("Working scope changed while launching. Review the scope again.");
            if (data.mappings[wb.selectedScope()]?.id !== preview.mapping.id) throw new Error("Repository mapping changed after preview.");
            if (Object.values(data.requests).some(r => r.scope === preview.scope && BLOCKING_REQUEST.has(requestStatus(r))))
                throw new Error("A session request is already queued for this scope. Wait for its receipt; do not create a duplicate.");
            data.requests[requestId] = request;
        });
        wb.previews.delete(previewId);
        await this.deliver(requestId, prompt);
        return { status: "queued", requestId };
    }
    // clientId: an ID the panel chose before calling, stored with the request so the panel can match it after a timeout.
    async syncJira({ clientId } = {}) {
        if (clientId !== undefined && (typeof clientId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(clientId)))
            throw new Error("The Update Jira client ID must be 1 to 64 letters, digits or hyphens.");
        let queued;
        try { queued = await this.queueSync(clientId); }
        catch (error) {
            // Refused before any request was stored. The panel may have stopped waiting already, so it settles its
            // action from this terminal outcome instead of a stored request.
            if (clientId) {
                this.syncRejections.set(clientId, { clientId, error: String(error?.message || error).slice(0, 500), at: new Date().toISOString() });
                for (const key of this.syncRejections.keys()) if (this.syncRejections.size > SYNC_REJECTIONS_KEPT) this.syncRejections.delete(key);
            }
            throw error;
        }
        await this.deliver(queued.requestId, queued.prompt);
        return { status: "queued", requestId: queued.requestId };
    }
    async queueSync(clientId) {
        const wb = this.workbench;
        // Read everything from the selected project now: an await below can outlast a project switch.
        const site = wb.site, project = wb.project, selection = wb.selections, issues = wb.issues, statuses = wb.statuses;
        if (!site || !project) throw new Error("Select a Jira project first.");
        if (wb.error) throw new Error("Refresh Jira successfully before syncing statuses from stale data.");
        if (wb.cached) throw new Error("Jira data is a cached snapshot. Refresh before syncing statuses.");
        const scope = wb.selectedScope(), data = await wb.store.read(), mapping = data.mappings[scope];
        if (wb.selections !== selection) throw new Error("Project changed while preparing the sync.");
        if (!mapping) throw new Error("Select the Copilot repository for this Jira project before syncing statuses.");
        if (!wb.verified.apps) throw new Error("Copilot repository projects are not confirmed yet. Reload connections and try again.");
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
                throw new Error("Project changed while preparing the sync. Confirm Sync Jira statuses again for the selected project.");
            if (current.mappings[scope]?.id !== mapping.id) throw new Error("Repository mapping changed while preparing the sync.");
            if (Object.values(current.requests).some(r => r.scope === scope && BLOCKING_REQUEST.has(requestStatus(r))))
                throw new Error("A session request is already queued for this project. Wait for its receipt; do not create a duplicate.");
            current.requests[requestId] = {
                requestId, kind: "jira-sync", scope, nodeId: "project", issueKey: project.key,
                cloudId: site.id, jiraProjectId: project.id, copilotProjectId: mapping.id,
                mode: "autopilot", status: "queued", at: new Date().toISOString(),
                ...(clientId ? { clientId } : {}),
            };
        });
        return { requestId, prompt };
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
        // A late receipt for an expired, cleared or superseded request still records the session that was actually
        // created. Requests queued before claims existed carry no claim, so a receipt never requires one.
        if (!["queued", "unknown", "expired", "cancelled"].includes(status) && !(status === "failed" && request.supersededBy))
            throw new Error("This request is not awaiting a session receipt.");
        await wb.attach(request.scope, sessionId, request.copilotProjectId, requestId);
        return { status: "attached", sessionId };
    }
    // The launching agent's first step: the one prompt that claims a request may create its session. A stale prompt
    // (its request cleared, already claimed, or replaced by a newer Start for the scope) is told to stop instead.
    // Returned rather than thrown, so a superseded request is persisted.
    async claimRequest({ requestId } = {}) {
        const wb = this.workbench;
        if (typeof requestId !== "string" || !requestId) throw new Error("A request ID is required.");
        return wb.commit(data => {
            const request = Object.hasOwn(data.requests, requestId) ? data.requests[requestId] : null;
            const refuse = reason => ({ status: "refused", requestId, message: `${reason} Do not create a session.` });
            if (!request || typeof request !== "object") return refuse("Unknown launch request.");
            if (request.claimedAt) return refuse("Another launch prompt already claimed this request.");
            const status = requestStatus(request);
            if (status === "cancelled") return refuse("The user cleared this request in Jira Workbench.");
            if (status === "attached") return refuse("This request already has a session.");
            if (!["queued", "expired"].includes(status)) return refuse("This request is no longer waiting for a session.");
            const at = Date.parse(request.at);
            const newer = Object.entries(data.requests).find(([id, other]) => id !== requestId
                && other?.scope === request.scope && Date.parse(other.at) > at);
            if (newer) {
                const message = "Superseded by a newer launch; no session was created.";
                Object.assign(request, { status: "failed", error: message, supersededBy: newer[0], completedAt: new Date().toISOString() });
                return { status: "superseded", requestId, message: `${message} Do not create a session.` };
            }
            request.claimedAt = new Date().toISOString();
            return { status: "claimed", requestId };
        });
    }
    async failRequest({ requestId, message }) {
        const wb = this.workbench;
        if (typeof message !== "string" || !message.trim()) throw new Error("A failure message is required.");
        await wb.store.update(data => {
            const request = data.requests[requestId];
            if (request?.status === "cancelled") throw new Error("This request was cleared in the Workbench; no failure was recorded.");
            if (!request || !["queued", "unknown", "expired"].includes(requestStatus(request))) throw new Error("This request is not awaiting a receipt.");
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
            if (!["queued", "unknown", "expired"].includes(requestStatus(request)))
                throw new Error("Only a queued or expired request can be cleared.");
            if (Date.now() - Date.parse(request.claimedAt) <= CLAIM_TTL_MS)
                throw new Error("The launching agent claimed this request and may be creating its session. Wait for its receipt before clearing it.");
            Object.assign(request, { status: "cancelled", cancelledAt: new Date().toISOString() });
        });
        return { status: "cancelled", requestId };
    }
}

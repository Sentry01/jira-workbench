import { objects, settle } from "./runtime.mjs";
import { assertSessionId } from "./validate.mjs";

async function mapLimit(items, limit, work) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index], index); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// Host fields, as observed in get_session and get_sessions_status results: id, name, branch, project_id,
// activity.status (activity can be null or absent), awaiting_user_input, awaiting_plan_approval,
// was_interrupted, created_pr_number and created_pr_repo. awaiting_input ({ question, choices, request_id }) is
// the shape get_sessions_status documents for a session blocked on input.
// A PR is evidence only when the host names both its number and its repository: a session's own project_repo
// says nothing about where its PR was opened.
function sessionRecord(detail, id, status = detail) {
    const input = status.awaiting_input;
    const pr = detail.created_pr_number && detail.created_pr_repo;
    return {
        id: detail.id || id, name: detail.name || id, branch: detail.branch || null,
        activity: status.activity?.status || detail.activity?.status || "unknown", projectId: detail.project_id,
        awaitingInput: status.awaiting_user_input || input ? {
            question: typeof input?.question === "string" ? input.question : "This session is waiting for your input.",
            choices: Array.isArray(input?.choices) ? input.choices.filter(c => typeof c === "string") : [],
            requestId: input?.request_id || null,
        } : null,
        awaitingPlan: status.awaiting_plan_approval === true,
        interrupted: status.was_interrupted === true,
        error: typeof status.error === "string" ? status.error : null,
        prNumber: pr ? detail.created_pr_number : null,
        prRepo: pr ? detail.created_pr_repo : null,
        verifiedAt: new Date().toISOString(),
    };
}

// Applies one observed trace to the latest persisted state without regressing a newer concurrent observation.
function mergeTrace(current, { scope, previous, next, stamp, source }) {
    const link = current.links[scope] || previous;
    const newer = name => Date.parse(link.sourceStatus?.[name]?.fetchedAt || "") > Date.parse(stamp);
    const applySessions = source !== "github" && !newer("sessions");
    const applyGithub = source !== "sessions" && !newer("github");
    const sourceStatus = { ...link.sourceStatus };
    if (applySessions) sourceStatus.sessions = next.sourceStatus.sessions;
    if (applyGithub) sourceStatus.github = next.sourceStatus.github;
    if (source === "sessions" && next.sourceStatus.github?.state === "unknown"
        && next.sessions.some(s => s.prNumber && !link.prs.some(pr => pr.number === s.prNumber && pr.repo === s.prRepo)))
        sourceStatus.github = next.sourceStatus.github;
    const sessions = applySessions ? next.sessions.map(record => {
        const live = link.sessions.find(s => s.id === record.id);
        return { ...live, ...record, ...(live?.contextHash ? { contextHash: live.contextHash } : {}) };
    }) : link.sessions;
    if (applySessions) sessions.push(...link.sessions.filter(s => !previous.sessions.some(p => p.id === s.id) && !sessions.some(n => n.id === s.id)));
    const prs = applyGithub ? [...next.prs, ...link.prs.filter(pr => !next.prs.some(p => p.url === pr.url))] : link.prs;
    const errors = [...new Set(Object.values(sourceStatus).flatMap(s => s?.error ? [s.error] : []))];
    // `origins` held GitHub source issues in older stores; that trace step was retired.
    const { origins: _retired, ...kept } = link;
    current.links[scope] = {
        ...kept, ...next, sessions, prs, sourceStatus, errors,
        verifiedAt: source === "all" && applySessions && applyGithub ? stamp : link.verifiedAt || null,
    };
    return current.links[scope];
}

// Observation of linked sessions and PRs: linking, trace and execution refresh, and native navigation.
// Panel state (selection, issues, store, gateway, github, hostActions) stays on the Workbench and is read through it.
export class Trace {
    constructor(workbench) { this.workbench = workbench; }
    async attach(scope, sessionId, projectId, requestId = null) {
        const wb = this.workbench;
        assertSessionId(sessionId);
        const detail = await wb.gateway.call("get_session", { project_session_id: sessionId });
        if (detail.project_id !== projectId) throw new Error("The session belongs to a different Copilot project than the selected repository.");
        const record = sessionRecord(detail, sessionId);
        await wb.store.update(data => {
            const link = data.links[scope] ||= { sessions: [], prs: [] };
            const index = link.sessions.findIndex(s => s.id === record.id);
            if (requestId) record.contextHash = data.requests[requestId].contextHash;
            if (index < 0) link.sessions.push(record); else link.sessions[index] = { ...link.sessions[index], ...record };
            if (requestId) {
                const r = data.requests[requestId];
                if (r.status === "attached" && r.sessionId !== sessionId) throw new Error("A different receipt already fulfilled this request.");
                Object.assign(r, { status: "attached", sessionId, completedAt: new Date().toISOString() });
            }
        });
        return record;
    }
    async linkSession({ nodeId, sessionId }) {
        const wb = this.workbench;
        wb.node(nodeId);
        const mapping = (await wb.store.read()).mappings[wb.selectedScope()];
        if (!mapping) throw new Error("Select a Copilot repository before linking a session.");
        return this.attach(wb.selectedScope(nodeId), sessionId, mapping.id);
    }
    async openSession({ nodeId, sessionId }) {
        const wb = this.workbench;
        const link = (await wb.store.read()).links[wb.selectedScope(nodeId)];
        if (!link?.sessions.some(s => s.id === sessionId)) throw new Error("This session is not linked to the selected item.");
        if (!wb.hostActions) throw new Error("Native session navigation is unavailable in this runtime.");
        return wb.hostActions.openSession(sessionId);
    }
    async openPr({ nodeId, repo, number }) {
        const wb = this.workbench;
        const link = (await wb.store.read()).links[wb.selectedScope(nodeId)];
        if (!link?.prs.some(pr => pr.repo === repo && pr.number === number)) throw new Error("This PR is not linked to the selected trace.");
        if (!wb.hostActions) throw new Error("Native PR navigation is unavailable in this runtime.");
        const owner = link.sessions.find(s => s.prNumber === number && s.prRepo?.toLowerCase() === repo.toLowerCase());
        return wb.hostActions.openPr(repo, number, owner ? { sessionId: owner.id } : {});
    }
    async refreshExecution({ source = "all" } = {}) {
        const wb = this.workbench;
        if (!["all", "sessions", "github"].includes(source)) throw new Error("Choose a supported execution source.");
        const scope = wb.selectedScope(), key = `${scope}/${source}`;
        if (wb.executionRefreshes.has(key)) return wb.executionRefreshes.get(key);
        const pending = (async () => {
            const data = await wb.store.read();
            const targets = ["project", ...wb.issues.map(i => i.id)]
                .map(nodeId => wb.selectedScope(nodeId))
                .filter(scope => data.links[scope])
                .map(scope => ({ scope, previous: data.links[scope] }));
            const linkedSessions = targets.some(target => target.previous.sessions.length);
            // Polling only asks about sessions; with none linked there is nothing to observe or write.
            if (source === "sessions" && !linkedSessions) return wb.snapshot();
            let statuses = [], statusError = null;
            if (source !== "github" && linkedSessions) {
                try { statuses = objects(await wb.gateway.call("get_sessions_status", {})); }
                catch (error) { statusError = error.message; }
            }
            const traces = await mapLimit(targets, 4, target => this.collectTrace({ ...target, source, statuses, statusError }));
            if (traces.length) await wb.store.update(current => { for (const trace of traces) mergeTrace(current, trace); });
            return wb.snapshot();
        })();
        wb.executionRefreshes.set(key, pending);
        try { return await pending; }
        finally { wb.executionRefreshes.delete(key); }
    }
    async refreshTrace(nodeId) {
        const wb = this.workbench;
        wb.node(nodeId);
        const scope = wb.selectedScope(nodeId);
        const data = await wb.store.read();
        const trace = await this.collectTrace({ scope, previous: data.links[scope] || { sessions: [], prs: [] } });
        return wb.store.update(current => mergeTrace(current, trace));
    }
    // Observes every source for one scope concurrently, then folds results in stored order so
    // evidence and error attribution stay deterministic.
    async collectTrace({ scope, previous, source = "all", statuses, statusError = null }) {
        const wb = this.workbench;
        const stamp = new Date().toISOString();
        const next = {
            sessions: source === "github" ? previous.sessions : [], prs: source === "sessions" ? previous.prs : [], errors: [],
            verifiedAt: source === "all" ? stamp : previous.verifiedAt || null, sourceStatus: { ...previous.sourceStatus },
        };
        if (source !== "github" && previous.sessions.length && statuses === undefined) {
            try { statuses = objects(await wb.gateway.call("get_sessions_status", {})); }
            catch (error) { statusError = error.message; }
        }
        statuses ||= [];
        if (statusError) next.errors.push(`Live session activity unavailable: ${statusError}`);
        let sessionError = statusError, githubError = null;
        const observations = await mapLimit(previous.sessions, 4, async stored => {
            const result = { stored, record: stored, observed: false, pr: null, error: null };
            try {
                if (source !== "github") {
                    const detail = await wb.gateway.call("get_session", { project_session_id: stored.id });
                    const status = statuses.find(s => s.id === stored.id || s.id === detail.id);
                    result.record = { ...stored, ...sessionRecord(detail, stored.id, status || detail), stale: Boolean(statusError) };
                    result.observed = true;
                }
                if (source !== "sessions" && result.record.prNumber && result.record.prRepo)
                    result.pr = await wb.github(result.record.prRepo, result.record.prNumber);
            } catch (error) { result.error = error; }
            return result;
        });
        for (const { stored, record, observed, pr, error } of observations) {
            if (observed) next.sessions.push(record);
            if (pr) {
                let target = next.prs.find(p => p.url === pr.url);
                if (!target) {
                    target = { ...pr, repo: record.prRepo, sessionIds: [], evidence: "Copilot session PR metadata; verified on GitHub" };
                    next.prs.push(target);
                }
                target.sessionIds.push(record.id);
            }
            if (!error && source === "sessions" && record.prNumber && !previous.prs.some(p => p.number === record.prNumber && p.repo === record.prRepo))
                next.sourceStatus.github = { state: "unknown", error: "Session reports a PR not yet checked on GitHub.", fetchedAt: previous.sourceStatus?.github?.fetchedAt || null };
            if (!error) continue;
            next.errors.push(`Session ${stored.id}: ${error.message}`);
            if (source !== "github" && !observed) sessionError = error.message;
            else githubError = error.message;
            if (!next.sessions.some(s => s.id === stored.id)) next.sessions.push({ ...stored, activity: "unknown", stale: true });
            next.prs.push(...previous.prs.filter(p => p.sessionIds?.includes(stored.id) && !next.prs.some(n => n.url === p.url)).map(p => ({ ...p, stale: true })));
        }
        const earlier = [];
        for (const old of source === "sessions" ? [] : previous.prs)
            if (!next.prs.some(pr => pr.url === old.url) && !earlier.some(pr => pr.url === old.url)) earlier.push(old);
        const verified = await mapLimit(earlier, 4, old => settle(wb.github(old.repo, old.number)));
        earlier.forEach((old, index) => {
            const { value, error } = verified[index];
            if (!error) { next.prs.push({ ...old, ...value, stale: false }); return; }
            next.errors.push(`Earlier PR ${old.repo}#${old.number}: ${error.message}`);
            githubError = error.message;
            next.prs.push({ ...old, stale: true });
        });
        if (source !== "github") next.sourceStatus.sessions = { state: sessionError ? "stale" : "fresh", fetchedAt: stamp, error: sessionError };
        if (source !== "sessions") next.sourceStatus.github = { state: githubError ? "stale" : "fresh", fetchedAt: stamp, error: githubError };
        return { scope, previous, next, stamp, source };
    }
}

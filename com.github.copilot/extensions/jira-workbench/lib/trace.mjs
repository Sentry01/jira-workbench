import { objects, settle } from "./runtime.mjs";
import { assertSessionId } from "./validate.mjs";

// Unchanged polls keep their freshness stamps in memory and persist them at most this often; a session already known
// in full is read by background polls with get_session at most this often (get_sessions_status carries its live
// state every poll); an explicit refresh reads every session in full.
const STAMP_PERSIST_MS = 60_000;
const DETAIL_EVERY_MS = 60_000;

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
// The ID is always the one asked for: observed live (Oct 2026), the host can return `id` masked as "******", and
// storing that echo lost the session from the trace for good.
function sessionRecord(detail, id, status = detail) {
    const input = status.awaiting_input;
    const pr = detail.created_pr_number && detail.created_pr_repo;
    return {
        id, name: detail.name || id, branch: detail.branch || null,
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

// A linked session the host no longer knows is re-checked by this many polls, then only by an explicit trace refresh.
export const MISSING_POLLS = 3;

function mergeSession(live, record) {
    const merged = { ...live, ...record, ...(live?.contextHash ? { contextHash: live.contextHash } : {}) };
    if (record.activity !== "missing") { delete merged.missingSince; delete merged.missingPolls; }
    return merged;
}

// Applies one observed trace to the latest persisted state without regressing a newer concurrent observation.
// observed: the IDs of sessions this trace actually read (not skipped or failed); skipped: the IDs a poll did not ask
// about, whose persisted record is kept as it is now, since another refresh may have read them meanwhile.
function mergeTrace(current, { scope, previous, next, stamp, source, observed = [], skipped = [] }) {
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
    // A newer sessions source can come from a poll that skipped a session confirmed missing. It did not observe that
    // session, so this trace's own observation of it still applies unless the session was read after this trace began.
    const sessions = applySessions ? next.sessions.map(record => {
        const live = link.sessions.find(s => s.id === record.id);
        return skipped.includes(record.id) && live ? live : mergeSession(live, record);
    })
        : source === "github" ? link.sessions : link.sessions.map(live => {
            const record = observed.includes(live.id) && next.sessions.find(s => s.id === live.id);
            return record && !(Date.parse(live.verifiedAt || "") > Date.parse(stamp)) ? mergeSession(live, record) : live;
        });
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

// A trace's content without its observation times: two observations that differ only in these say the same thing.
const content = link => JSON.stringify(link ?? null, (key, value) => key === "verifiedAt" || key === "fetchedAt" ? undefined : value);

// Whether persisting this trace would change anything but observation times.
function changes(stored, trace) {
    const preview = mergeTrace({ links: { [trace.scope]: structuredClone(stored ?? trace.previous) } }, trace);
    return content(preview) !== content(stored);
}

// The observation times a trace was stored with: they change with every write of its sources.
const stampsOf = link => JSON.stringify([link?.sourceStatus?.sessions?.fetchedAt, link?.sourceStatus?.github?.fetchedAt, link?.verifiedAt]);

// The stored trace with the newer observation times this process kept in memory instead of writing. They apply only
// to the content they verified: once anyone stores something else, that content keeps its own times.
export function withStamps(link, stamps) {
    if (!stamps || !link || content(link) !== stamps.content) return link;
    const later = (a, b) => a && (!b || Date.parse(a) > Date.parse(b)) ? a : b;
    const sourceStatus = { ...link.sourceStatus };
    for (const name of ["sessions", "github"])
        if (sourceStatus[name] && stamps[name]) sourceStatus[name] = { ...sourceStatus[name], fetchedAt: later(stamps[name], sourceStatus[name].fetchedAt) };
    return { ...link, sourceStatus, verifiedAt: later(stamps.verifiedAt, link.verifiedAt || null) || null };
}

// A session record that names its branch and PR needs no get_session: its live state comes from get_sessions_status.
function complete(stored, status) {
    const named = status.name || (stored.name && stored.name !== stored.id);
    const pr = (status.created_pr_number && status.created_pr_repo) || (stored.prNumber && stored.prRepo);
    return Boolean(named && (status.branch || stored.branch) && pr);
}

// The host fields of a session as last observed, updated by what get_sessions_status reports now.
function knownDetail(stored, status) {
    const pr = status.created_pr_number && status.created_pr_repo
        ? { created_pr_number: status.created_pr_number, created_pr_repo: status.created_pr_repo }
        : { created_pr_number: stored.prNumber, created_pr_repo: stored.prRepo };
    return { id: stored.id, name: status.name || stored.name, branch: status.branch || stored.branch, project_id: status.project_id ?? stored.projectId, ...pr };
}

// Observation of linked sessions and PRs: linking, trace and execution refresh, and native navigation.
// Panel state (selection, issues, store, gateway, github, hostActions) stays on the Workbench and is read through it.
export class Trace {
    constructor(workbench) {
        this.workbench = workbench;
        // Observation times not yet written (by scope), when they were last written, and when each session was last
        // read in full. The first unchanged minute after startup is not written either.
        this.stamps = new Map();
        this.persistedAt = Date.now();
        // The observation times this panel last stored for each trace, and how many observations are in progress.
        this.written = new Map();
        this.collecting = 0;
        this.detailAt = new Map();
    }
    async attach(scope, sessionId, projectId, requestId = null) {
        const wb = this.workbench;
        assertSessionId(sessionId);
        const detail = await wb.gateway.call("get_session", { project_session_id: sessionId });
        if (detail.project_id !== projectId) throw new Error("The session belongs to a different Copilot project than the selected repository.");
        const record = sessionRecord(detail, sessionId);
        await wb.commit(data => {
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
        wb.traceNode(nodeId);
        const mapping = (await wb.store.read()).mappings[wb.selectedScope()];
        if (!mapping) throw new Error("Select a Copilot repository before linking a session.");
        return this.attach(wb.selectedScope(nodeId), sessionId, mapping.id);
    }
    async openSession({ nodeId, sessionId }) {
        const wb = this.workbench;
        wb.traceNode(nodeId);
        const link = (await wb.store.read()).links[wb.selectedScope(nodeId)];
        if (!link?.sessions.some(s => s.id === sessionId)) throw new Error("This session is not linked to the selected item.");
        if (!wb.hostActions) throw new Error("Native session navigation is unavailable in this runtime.");
        return wb.hostActions.openSession(sessionId);
    }
    async openPr({ nodeId, repo, number }) {
        const wb = this.workbench;
        wb.traceNode(nodeId);
        const link = (await wb.store.read()).links[wb.selectedScope(nodeId)];
        if (!link?.prs.some(pr => pr.repo === repo && pr.number === number)) throw new Error("This PR is not linked to the selected trace.");
        if (!wb.hostActions) throw new Error("Native PR navigation is unavailable in this runtime.");
        // A deleted session cannot open its PR; the native PR view can.
        const owner = link.sessions.find(s => s.activity !== "missing" && s.prNumber === number && s.prRepo?.toLowerCase() === repo.toLowerCase());
        return wb.hostActions.openPr(repo, number, owner ? { sessionId: owner.id } : {});
    }
    // poll: the panel's background session poll, which stops asking about sessions confirmed missing. Any other
    // refresh, such as Refresh Sessions, is the user's request and checks them again.
    // `reuseRecent`: a background pass (after a pick or revalidation) may use a PR read from the last minute. Requests
    // from the panel always read GitHub, deduplicated within the refresh.
    async refreshExecution({ source = "all", poll = false } = {}, { reuseRecent = false } = {}) {
        const wb = this.workbench;
        if (!["all", "sessions", "github"].includes(source)) throw new Error("Choose a supported execution source.");
        poll = poll === true;
        const scope = wb.selectedScope(), generation = wb.refreshGeneration;
        const key = `${wb.loadKey()}/${generation}/${source}${poll ? "/poll" : ""}${reuseRecent ? "/recent" : ""}`;
        if (wb.executionRefreshes.has(key)) return wb.executionRefreshes.get(key);
        const pending = (async () => {
            const data = await wb.store.read();
            if (generation !== wb.refreshGeneration || scope !== wb.currentScope()) return wb.snapshot();
            // Only this project's own issues: cross-project context has no trace under this project's mapping.
            const targets = ["project", ...wb.issues.filter(issue => issue.projectId === wb.project.id).map(issue => issue.id)]
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
            const github = this.reader(!reuseRecent);
            const traces = await mapLimit(targets, 4, target => this.collectTrace({ ...target, source, poll, statuses, statusError, github }));
            if (traces.length) await this.persist(traces);
            return wb.snapshot();
        })();
        wb.executionRefreshes.set(key, pending);
        try { return await pending; }
        finally { wb.executionRefreshes.delete(key); }
    }
    // One GitHub read per PR for a whole refresh: the first lookup of a PR may bypass the recent-read cache, and every
    // later lookup of it in the same refresh, from any issue or read path, shares that result.
    reader(fresh) {
        const reads = new Map();
        return (repo, number) => {
            const key = `${String(repo).toLowerCase()}#${number}`;
            if (!reads.has(key)) reads.set(key, this.workbench.github(repo, number, { fresh }));
            return reads.get(key);
        };
    }
    // Writes the traces unless the write would change nothing but observation times. Skipping is safe only when no
    // other observation can be ordered against these times: the stored traces must be exactly what this panel last
    // wrote (no other panel or process has written them since) and no other observation is running in this panel.
    // Otherwise the times are written, so mergeTrace can keep an older observation from replacing this newer one.
    // Times kept in memory are written at least once a minute.
    async persist(traces) {
        const now = Date.now(), store = this.workbench.store;
        if (!this.collecting && now - this.persistedAt < STAMP_PERSIST_MS) {
            const current = await store.read();
            if (traces.every(trace => this.written.get(trace.scope) === stampsOf(current.links[trace.scope]) && !changes(current.links[trace.scope], trace))) {
                for (const trace of traces) this.keep(trace, current.links[trace.scope]);
                return;
            }
        }
        const written = await store.update(current => traces.map(trace => this.merge(current, trace)));
        this.persistedAt = now;
        traces.forEach((trace, index) => this.wrote(trace.scope, written[index]));
    }
    // Merges a trace and, while the stored content is still what they checked, the times kept in memory for it, so
    // a write by one source also saves the newer times of sources it did not observe.
    merge(current, trace) {
        const kept = this.stamps.get(trace.scope);
        if (kept && current.links[trace.scope]) current.links[trace.scope] = withStamps(current.links[trace.scope], kept);
        return { link: mergeTrace(current, trace), kept };
    }
    // Forgets the kept times just written, unless another check kept newer ones meanwhile.
    wrote(scope, { link, kept }) {
        if (this.stamps.get(scope) === kept) this.stamps.delete(scope);
        this.written.set(scope, stampsOf(link));
    }
    keep({ scope, next, source }, stored) {
        const stamps = { ...this.stamps.get(scope), content: content(stored) };
        for (const name of ["sessions", "github"]) if (source !== (name === "sessions" ? "github" : "sessions")) stamps[name] = next.sourceStatus[name]?.fetchedAt;
        if (source === "all") stamps.verifiedAt = next.verifiedAt;
        this.stamps.set(scope, stamps);
    }
    async refreshTrace(nodeId) {
        const wb = this.workbench;
        wb.traceNode(nodeId);
        const scope = wb.selectedScope(nodeId);
        const data = await wb.store.read();
        const trace = await this.collectTrace({ scope, previous: data.links[scope] || { sessions: [], prs: [] }, github: this.reader(true) });
        const written = await wb.store.update(current => this.merge(current, trace));
        this.wrote(scope, written);
        return written.link;
    }
    async collectTrace(options) {
        this.collecting++;
        try { return await this.observe(options); }
        finally { this.collecting--; }
    }
    // Observes every source for one scope concurrently, then folds results in stored order so
    // evidence and error attribution stay deterministic.
    // `github`: the refresh's PR reader; an explicit refresh reads its PRs from GitHub again rather than reuse a read
    // from the last minute.
    async observe({ scope, previous, source = "all", poll = false, statuses, statusError = null, github = this.reader(false) }) {
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
            const result = { stored, record: stored, observed: false, read: false, skipped: false, pr: null, error: null };
            // Polls stop asking about a session confirmed missing; an explicit refresh still checks it.
            if (poll && stored.activity === "missing" && stored.missingPolls >= MISSING_POLLS) {
                result.observed = result.skipped = true;
                return result;
            }
            if (source !== "github") {
                try {
                    const listed = statuses.find(s => s.id === stored.id);
                    const due = Date.now() - (this.detailAt.get(stored.id) ?? -Infinity) >= DETAIL_EVERY_MS;
                    let detail, status = listed;
                    if (!poll || !listed || source === "all" || due || !complete(stored, listed)) {
                        detail = await wb.gateway.call("get_session", { project_session_id: stored.id });
                        this.detailAt.set(stored.id, Date.now());
                        status ||= statuses.find(s => s.id === detail.id);
                    } else detail = knownDetail(stored, listed);
                    result.record = { ...stored, ...sessionRecord(detail, stored.id, status || detail), stale: Boolean(statusError) };
                } catch (error) {
                    // The host's own answer that the session is gone (deleted): a fact about the session, not a failed read.
                    if (!error.notFound) { result.error = error; return result; }
                    result.record = { ...stored, activity: "missing", missingSince: stored.missingSince || stamp,
                        missingPolls: (stored.activity === "missing" ? stored.missingPolls || 0 : 0) + 1, stale: false,
                        awaitingInput: null, awaitingPlan: false, interrupted: false, error: null, verifiedAt: new Date().toISOString() };
                }
                result.observed = result.read = true;
            }
            // A deleted session's recorded PR still needs verifying; a failed lookup is GitHub's, not the session's.
            if (source !== "sessions" && result.record.prNumber && result.record.prRepo) {
                try { result.pr = await github(result.record.prRepo, result.record.prNumber); }
                catch (error) { result.error = error; }
            }
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
        const verified = await mapLimit(earlier, 4, old => settle(github(old.repo, old.number)));
        earlier.forEach((old, index) => {
            const { value, error } = verified[index];
            if (!error) { next.prs.push({ ...old, ...value, stale: false }); return; }
            next.errors.push(`Earlier PR ${old.repo}#${old.number}: ${error.message}`);
            githubError = error.message;
            next.prs.push({ ...old, stale: true });
        });
        if (source !== "github") next.sourceStatus.sessions = { state: sessionError ? "stale" : "fresh", fetchedAt: stamp, error: sessionError };
        if (source !== "sessions") next.sourceStatus.github = { state: githubError ? "stale" : "fresh", fetchedAt: stamp, error: githubError };
        return { scope, previous, next, stamp, source, observed: observations.filter(o => o.read).map(o => o.stored.id),
            skipped: observations.filter(o => o.skipped).map(o => o.stored.id) };
    }
}

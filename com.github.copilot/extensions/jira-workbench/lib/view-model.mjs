// Pure view-model helpers for the panel: every input is explicit, with no DOM and no node: imports.
// The server serves this file as /view-model.mjs next to /model.mjs, which it imports.
import { REQUEST_TTL_MS, CLAIM_TTL_MS, jiraFreshness, requestStatus, issueIndex, issueParent, projectStatuses } from "./model.mjs";

const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

export const humanize = value => String(value || "unknown").replace(/[_-]/g, " ");

// The panel's work views. A project with no saved choice, or an unknown one, opens in the hierarchy.
export const WORK_VIEWS = ["hierarchy", "execution", "kanban"];
export const workView = value => WORK_VIEWS.includes(value) ? value : "hierarchy";

// Why a loaded row is not ordinary scope work; shown as a badge and in the row's accessible name.
export function scopeLabel(item) {
    if (item.contextOnly) return item.missing ? "Missing / restricted" : "Context only";
    return item.tracked ? item.unverified ? "Linked, not re-read from Jira" : "Linked, outside scope" : "";
}

export function workingSetSummary({ issues = [], page = {}, fetchedAt, cached }) {
    const loaded = issues.filter(issue => !issue.contextOnly && !issue.tracked).length;
    const context = issues.filter(issue => issue.contextOnly).length;
    const tracked = issues.filter(issue => issue.tracked && !issue.contextOnly).length;
    const complete = Boolean(fetchedAt) && !cached && !page.nextPageToken;
    return `${loaded} scope items loaded${page.total == null ? "" : ` of ${page.total} matching`}; ${context} context items${tracked ? `; ${tracked} linked items outside the loaded pages` : ""}. ${page.nextPageToken ? "More scope results remain." : complete ? "All scope pages loaded." : "Scope not yet verified."} Counts and progress describe loaded items, not complete child totals.`;
}

// Freshness of one live source across some traces. `time` formats a timestamp for display.
export function sourceFreshness(traces, source, time) {
    const linked = traces.filter(trace => source === "sessions" ? trace.sessions.length : trace.prs.length);
    if (!linked.length) return {
        label: "not needed", needed: false,
        detail: source === "sessions" ? "No linked session records." : "No linked pull request records.",
    };
    const statuses = linked.map(trace => {
        const status = trace.sourceStatus?.[source];
        return { ...status, state: ["fresh", "stale"].includes(status?.state) ? status.state : "unknown" };
    });
    const states = new Set(statuses.map(status => status.state));
    const label = states.has("unknown") ? states.size > 1 ? "partly unavailable" : "unavailable" :
        states.has("stale") ? states.size > 1 ? "partly stale" : "stale" : "fresh";
    return {
        label, needed: true,
        detail: [...new Set(statuses.map(status => `${status.state === "unknown" ? "Linked evidence unavailable" : status.state}; ${time(status.fetchedAt)}${status.error ? `; ${status.error}` : ""}`))].join("\n"),
    };
}

// The inspector's one-line freshness for a single trace. Jira uses the same label as the connection bar.
export function freshnessSummary(snapshot, trace, time) {
    return `Jira: ${jiraFreshness(snapshot, time).text}. Sessions: ${sourceFreshness([trace], "sessions", time).label}. GitHub: ${sourceFreshness([trace], "github", time).label}.`;
}

// A linked session the host reported as not found (deleted): nothing can be opened or observed.
export const sessionExists = session => session.activity !== "missing";

export function sessionState(session) {
    if (!sessionExists(session)) return "no longer exists";
    const observations = [];
    if (session.stale) observations.push("stale");
    if (session.awaitingInput) observations.push("needs your input");
    if (session.awaitingPlan) observations.push("plan awaiting approval");
    if (session.interrupted) observations.push("interrupted");
    observations.push(session.activity || "activity unknown");
    return observations.join(" / ");
}

// The single badge a queue row shows for its linked sessions.
export function sessionsBadge(sessions) {
    if (!sessions.length) return null;
    if (sessions.length > 1) return `${sessions.length} sessions`;
    const [session] = sessions;
    if (!sessionExists(session)) return "Session no longer exists";
    return session.stale ? "Stale session" : session.awaitingInput ? "Needs input" : session.awaitingPlan ? "Plan approval" :
        session.interrupted ? "Interrupted" : session.activity ? `Session: ${humanize(session.activity)}` : "Session unknown";
}

const BLOCKING = new Set(["pending", "queued", "uncertain"]);
const EXPIRED = `Launch outcome unknown: no session receipt after ${REQUEST_TTL_MS / 60_000} minutes. Check the project's sessions before starting again.`;
const UNCLAIMED = `Launch outcome unknown: the launching agent claimed it but reported no session within ${CLAIM_TTL_MS / 60_000} minutes. A session may still appear. Start stays blocked until you clear the request; a late receipt still attaches its session.`;

// One work item's launch state: this panel's own launch action first, then the stored requests.
// An expired request is reported but, like a cleared one, never blocks a new launch.
export function launchState({ local = null, requests = [], nodeId, now = Date.now() }) {
    if (local && BLOCKING.has(local.status)) return local.status;
    const own = requests.filter(request => request.nodeId === nodeId);
    const statuses = own.map(request => requestStatus(request, now));
    if (statuses.includes("unknown")) return "uncertain";
    if (own.some(request => request.sendError && !request.claimedAt && requestStatus(request, now) === "queued")) return "uncertain";
    if (statuses.includes("queued")) return "queued";
    if (statuses.includes("expired")) return "expired";
    return null;
}
export const launchBlocks = state => BLOCKING.has(state);
export function launchLabel(state) {
    return { pending: "Submitting launch", queued: "Launch queued", uncertain: "Launch outcome unknown", expired: "Launch outcome unknown" }[state] || null;
}

// The status line of a launch request card in the trace.
export function requestOutcome(request, now = Date.now()) {
    const status = requestStatus(request, now);
    if (status === "queued" && request.claimedAt) return "Queued (claimed by the launching agent)";
    if (status === "unknown") return `Outcome unknown (claimed, no receipt after ${CLAIM_TTL_MS / 60_000} minutes; blocks Start until cleared)`;
    if (status === "queued" && request.sendError) return "Outcome unknown (Copilot did not confirm the prompt; no retry was sent)";
    if (status === "queued") return "Queued";
    if (status === "failed" && request.supersededBy) return "Superseded (no session was created)";
    if (status === "expired") return `Outcome unknown (no receipt after ${REQUEST_TTL_MS / 60_000} minutes)`;
    if (status === "cancelled") return "Cleared";
    if (status === "failed") return "Failed";
    return "Awaiting linked session evidence";
}

export function receiptMessage(kind, receipt) {
    const label = kind === "launch" ? "Launch" : "Navigation";
    if (receipt.status === "failed") return `${label} failed: ${receipt.message || receipt.error || "The host rejected the request."}`;
    if (receipt.status === "acknowledged") return `${label}: host acknowledged${receipt.message ? ` - ${receipt.message.replace(/\.$/, "")}` : ""}.`;
    return `${label} queued; ${kind === "launch" ? "waiting for an attached session receipt" : "waiting for host acknowledgement"}${receipt.message ? ` - ${receipt.message}` : ""}.`;
}

// The stored request behind this panel's launch action: by its request ID, or by the ID the panel knew before the
// call returned (a launch's preview, an Update Jira client ID), so a timed-out or failed call still reconciles.
export function launchReceipt(record, requests = []) {
    return requests.find(r => (record.requestId && r.requestId === record.requestId)
        || (record.previewId && r.previewId === record.previewId)
        || (record.clientId && r.clientId === record.clientId)) || null;
}

// An Update Jira the server refused before storing a request (the panel may have timed out waiting): failed, with why.
export function launchRejection(record, rejections = []) {
    const rejected = record.clientId && rejections.find(r => r.clientId === record.clientId);
    return rejected ? { status: "failed", message: `Update Jira was not queued: ${rejected.error}` } : null;
}

// What a stored request says about this panel's own launch action, or null to keep the action as it is
// (an attached receipt whose session the trace has not shown yet).
export function launchUpdate(receipt, { linkedSessionIds = [], now = Date.now() } = {}) {
    const status = requestStatus(receipt, now);
    if (status === "failed" && receipt.supersededBy)
        return { status: "failed", message: "Launch superseded by a newer launch; no session was created." };
    if (status === "failed") return { status: "failed", message: receiptMessage("launch", receipt) };
    if (status === "queued" && receipt.sendError && !receipt.claimedAt)
        return { status: "uncertain", message: `Launch outcome unknown: ${receipt.sendError}. No retry was sent. Refresh live state and inspect the launch receipt before starting again.` };
    if (status === "unknown") return { status: "uncertain", message: UNCLAIMED };
    if (status === "expired") return { status: "expired", message: EXPIRED };
    if (status === "cancelled") return { status: "cancelled", message: "Launch request cleared without a session receipt. A late receipt still attaches its session." };
    if (status === "queued") return { status: "queued", message: receiptMessage("launch", receipt) };
    if (status === "attached" && linkedSessionIds.includes(receipt.sessionId))
        return { status: "success", message: "Session receipt attached. Inspect the linked session for its observed activity." };
    return null;
}

export function primaryReason(execution) {
    return execution.reasons.find(reason => reason.trim()) || execution.signals.find(signal => signal.reason)?.reason || "No execution evidence reported.";
}

// Evidence beyond the primary reason, without repeating a fact. With a trace, linked records are listed too.
export function executionEvidence(item, execution, trace = null) {
    const evidence = [], seen = new Set();
    const normalize = text => text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").toLocaleLowerCase();
    seen.add(normalize(primaryReason(execution)));
    const add = (text, fact = text) => {
        const key = normalize(fact);
        if (!key || seen.has(key)) return;
        seen.add(key);
        evidence.push(text);
    };
    for (const reason of execution.reasons) add(reason);
    for (const signal of execution.signals) {
        if (signal.reason) add(`${humanize(signal.kind)}: ${signal.reason}`, signal.reason);
        else add(humanize(signal.kind));
    }
    if (trace) {
        if (item.parentKey) add(`Parent: ${item.parentKey}`);
        for (const session of trace.sessions) add(`${session.name || "Linked session"}: ${sessionState(session)}`);
        for (const pr of trace.prs) add(`${pr.repo}#${pr.number}: ${pr.stale ? "stale / " : ""}${pr.isDraft ? "draft / " : ""}${humanize(pr.state)}${pr.title ? ` - ${pr.title}` : ""}`);
    }
    return evidence;
}

// The one search rule for both views: key, summary, assignee and parent key, plus the Jira status filter: a status
// category, or "status:<name>" for one of the project's own workflow statuses, and the sprint filter.
export function matches(item, query = "", category = "all", sprint = "all") {
    const search = query.trim().toLocaleLowerCase();
    return (!search || [item.key, item.summary, item.assignee, item.parentKey].filter(Boolean).join(" ").toLocaleLowerCase().includes(search))
        && (category === "all" || (category.startsWith("status:") ? item.status === category.slice(7) : item.category === category))
        && (sprint === "all" || (sprint === "none" ? !item.sprints?.length : (item.sprints || []).some(each => `sprint:${each.id}` === sprint)));
}

// The sprint filter's options: the sprints the loaded issues belong to, plus "No sprint" when some work has none.
// Empty when the project has no sprint data, so the filter stays hidden.
export function sprintOptions(issues = []) {
    const sprints = new Map(issues.flatMap(item => item.sprints || []).map(sprint => [sprint.id, sprint.name]));
    if (!sprints.size) return [];
    const options = [...sprints].sort((a, b) => nameOrder(a[1], b[1]))
        .map(([id, name]) => ({ value: `sprint:${id}`, label: name }));
    return issues.some(item => !item.sprints?.length) ? [{ value: "none", label: "No sprint" }, ...options] : options;
}

// The sprint filter actually applied: the saved choice while the project offers it, otherwise "all". The saved choice
// itself is kept, so it applies again once a refresh brings that sprint back.
export function appliedSprint(options = [], selected = "all") {
    return options.some(option => option.value === selected) ? selected : "all";
}

const CATEGORY_LABELS = { new: "To do", indeterminate: "In progress", done: "Done", unknown: "Other" };

// The status filter's options for one project: "All", then each category with an "(any)" option and that project's
// own workflow statuses (e.g. "PR Waiting"). A saved exact status the project no longer lists stays selectable.
export function statusFilterGroups(statuses = [], selected = "all") {
    const groups = Object.entries(CATEGORY_LABELS).flatMap(([category, label]) => {
        const own = (statuses || []).filter(status => status.category === category);
        if (category === "unknown" && !own.length) return [];
        return [{ label, options: [
            ...category === "unknown" ? [] : [{ value: category, label: `${label} (any)` }],
            ...own.map(status => ({ value: `status:${status.name}`, label: status.name })),
        ] }];
    });
    const missing = typeof selected === "string" && selected.startsWith("status:")
        && !groups.some(group => group.options.some(option => option.value === selected));
    return [
        { label: null, options: [{ value: "all", label: "All Jira statuses" }] },
        ...groups,
        ...missing ? [{ label: null, options: [{ value: selected, label: `${selected.slice(7)} (not listed)` }] }] : [],
    ];
}

// Keeps matching nodes and the ancestors of matches. With no filter, every node keeps all its children.
// With nothing filtered every node matches, so the tree is returned as is; callers must not change it.
export function filterTree(roots, query = "", category = "all", sprint = "all") {
    if (!query.trim() && category === "all" && sprint === "all") return roots;
    return roots.flatMap(node => {
        const children = filterTree(node.children, query, category, sprint);
        return matches(node.issue, query, category, sprint) || children.length ? [{ ...node, children }] : [];
    });
}

// The Kanban board: one column per workflow status in category order (To do, In progress, Done, then any other), each
// holding the loaded work items in that status that pass the shared filters, in working-set order. Parents and
// context-only ancestors stay in the hierarchy. A status seen only on loaded work (another project in a JQL scope) gets
// its own column. Every column shows while the status filter is "all", empty or not, as on a Jira board; a status
// filter keeps the columns it selects plus any that still hold matching work.
export function kanbanBoard(issues = [], statuses = [], { query = "", category = "all", sprint = "all" } = {}) {
    const work = issues.filter(item => !item.contextOnly && item.level <= 0);
    const columns = new Map(projectStatuses(statuses, work).map(status => [status.name, { ...status, items: [] }]));
    for (const item of work) if (matches(item, query, category, sprint)) columns.get(item.status)?.items.push(item);
    const selected = column => category === "all"
        || (category.startsWith("status:") ? column.name === category.slice(7) : column.category === category);
    return [...columns.values()].filter(column => selected(column) || column.items.length);
}

// What a work view with no rows says instead.
export function emptyWorkMessage(view, { issues = [], executions = [] } = {}) {
    if (view === "execution" && !executions.length)
        return "No execution entries reported for this project. Refresh live state, or inspect and start project work from the header.";
    if (!issues.length) return "No visible issues in this project.";
    if (view !== "kanban") return "No matching work in this view. Choose All work or clear the search, Jira status and sprint filters.";
    return issues.some(item => !item.contextOnly && item.level <= 0)
        ? "No matching work on the board. Clear the search, Jira status and sprint filters."
        : "No loaded work items for the board. Epics and other parents are in Hierarchy.";
}

// The hierarchy's visible rows in display order: depth, parent, position among siblings and expansion. A collapsed
// node's subtree is left out.
export function flattenTree(roots, isExpanded) {
    const rows = [];
    const add = (nodes, depth, parentId) => nodes.forEach((node, index) => {
        const expanded = isExpanded(node.issue.id);
        rows.push({ node, depth, parentId, index, count: nodes.length, expanded });
        if (expanded) add(node.children, depth + 1, node.issue.id);
    });
    add(roots, 0, "");
    return rows;
}

const UNOBSERVED = "Live execution state has not been observed. Refresh live state to check.";
// Executions by node, built once per snapshot. A repeated node keeps its first record, as a linear find did.
export function indexExecutions(executions = []) {
    const index = new Map();
    for (const execution of executions) if (!index.has(execution.nodeId)) index.set(execution.nodeId, execution);
    return index;
}
export function executionFor(index, id) {
    return index.get(id) || {
        nodeId: id, views: ["all"], signals: [], reasons: [UNOBSERVED],
        primary: { kind: "inspect", label: "Inspect work" }, rank: Number.MAX_SAFE_INTEGER,
    };
}

// A clock label for a stored timestamp; `format` is a cached Intl.DateTimeFormat, which throws on an invalid date.
export function timeLabel(value, format) {
    if (!value) return "not refreshed";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Invalid Date" : format(date);
}

// Distinct linked session IDs among each issue's descendants (as model.mjs descendants() defines them), for every
// issue at once: one key index, then each linked issue walks up its own ancestors. Parent cycles stop at a repeat.
export function descendantSessionCounts(issues, sessionIdsFor) {
    const byKey = issueIndex(issues);
    const found = new Map();
    for (const issue of issues) {
        const ids = sessionIdsFor(issue.id);
        if (!ids.length) continue;
        const seen = new Set([issue.key]);
        for (let parent = issueParent(issue, byKey); parent && !seen.has(parent.key); parent = issueParent(parent, byKey)) {
            seen.add(parent.key);
            if (!found.has(parent.id)) found.set(parent.id, new Set());
            for (const id of ids) found.get(parent.id).add(id);
        }
    }
    return new Map([...found].map(([id, sessions]) => [id, sessions.size]));
}

// The launch mode every Start button opens with: the execution's own prepare mode when it has one, otherwise
// Plan for the project and parent issues and Implement (autopilot) for leaves, as the server defaults.
export function defaultMode(item, execution) {
    const primary = execution?.primary;
    if (primary?.kind === "prepare" && ["plan", "autopilot"].includes(primary.mode)) return primary.mode;
    return item.id === "project" || item.level > 0 ? "plan" : "autopilot";
}

// The opt-in Smart Commit comment in the launch brief: offered only for a single issue; the server re-validates it.
export function smartCommitOption(node) {
    if (!node || node.id === "project" || !node.key) return null;
    return {
        label: `Smart Commit comment: let the session comment on ${node.key} once, from its final commit (${node.key} #comment ...).`,
        hint: "Jira's GitHub integration posts the comment when the commit is pushed. It needs Smart Commits enabled and a commit email that matches your Jira account, and reverting the commit does not remove it.",
    };
}

// { server, connector } while the Atlassian sign-in is needed (the server name can be unknown), otherwise null.
// A connector is the Copilot app's Atlassian connection: the app signs it in, not the Workbench or /mcp auth.
export const signInNeeded = snapshot => snapshot.connection?.state === "signin"
    ? { server: snapshot.connection.server, connector: Boolean(snapshot.connection.connector) } : null;

// No Copilot session behind the panel (opened from Canvases in the sidebar): nothing reconnects it, so the panel
// shows the saved data, explains once, and disables the actions that need a session or Jira.
export const standaloneHost = snapshot => snapshot.connection?.state === "standalone";

// The sign-in call to action and the error banner. An expired sign-in is one clear call to action, not a pile of
// per-source failures and a retry promise; a panel with no session behind it is one explanation.
// `unavailable` lists execution node IDs with no loaded work item.
// The errors go into an assertive alert, so they never carry a ticking number: the next attempt is returned as
// `retryAt` for display outside the alert (see retryNotice), and the alert text changes only when the state does.
export function banner(snapshot, { unavailable = [] } = {}) {
    const signIn = signInNeeded(snapshot), connection = snapshot.connection;
    const data = [
        ...snapshot.tree.warnings,
        ...(snapshot.ancestorWarnings || []),
        ...(snapshot.pageError ? [snapshot.pageError] : []),
        ...(unavailable.length ? [`Execution snapshot references unavailable work items: ${unavailable.join(", ")}. Refresh the workbench to reconcile the sources.`] : []),
    ];
    if (standaloneHost(snapshot))
        return { signIn: null, errors: [`${connection.reason}${snapshot.issues?.length ? " The data shown is the last saved copy." : ""}`, ...data], retryAt: null };
    const errors = [
        ...(signIn ? snapshot.catalogErrors.filter(message => !message.startsWith("Jira:")) : snapshot.catalogErrors),
        ...(snapshot.error && !signIn ? [`Jira refresh failed: ${snapshot.error}. Last good data retained.`] : []),
        ...(snapshot.backgroundError && !(signIn && /sign-in has expired/.test(snapshot.backgroundError)) ? [`Background refresh failed: ${snapshot.backgroundError}`] : []),
        ...data,
    ];
    const nextCheckAt = connection && connection.state !== "ready" ? connection.nextCheckAt : null;
    let retryAt = null;
    if (!signIn && (snapshot.catalogErrors.length || snapshot.error) && (snapshot.warming || nextCheckAt)) {
        errors.push(snapshot.warming ? "Reconnecting now…" : "Reconnecting automatically. No need to press Reload connections.");
        if (!snapshot.warming) retryAt = nextCheckAt;
    }
    return { signIn, errors, retryAt };
}

// The next automatic attempt as a clock time: it changes once per attempt, never every second.
export function retryNotice(retryAt, { now = Date.now(), format }) {
    const at = Date.parse(retryAt);
    if (!retryAt || Number.isNaN(at)) return "";
    return at <= now ? "Retrying now." : `Next attempt at ${format(retryAt)}.`;
}

// The panel's own server can disappear for good: after an update or extension reload the host may stop this
// session's Workbench process without starting a new one, and reopening the panel in the same session does not
// bring it back. Network failures (not error responses) in a row decide it; any answer resets the count.
export const SERVER_LOST_AFTER = 3;
export const SERVER_LOST_MESSAGE = "This panel lost its connection to the Workbench, usually because the extension stopped after an update or reload. "
    + "Reopening it in this session may not help: restart the GitHub Copilot app, or open Jira Workbench from a new Copilot session.";
export function serverLost(failures) {
    return failures >= SERVER_LOST_AFTER;
}

// How long the panel waits between polls: every second while reconnecting so a recovery shows at once, every 5s
// when healthy, and every 30s once its server is gone, since nothing in this panel can bring it back.
export function pollDelayMs({ reconnecting = false, lost = false } = {}) {
    return lost ? 30_000 : reconnecting ? 1000 : 5000;
}

// Where keyboard focus goes when the item with `removed` key leaves a list: the next item, else the previous one.
export function nextFocusKey(keys, removed) {
    const index = keys.indexOf(removed);
    if (index < 0) return null;
    return keys[index + 1] ?? keys[index - 1] ?? null;
}

// The snapshot to apply. While the panel's working-set revision is current the server sends `issues: null`, and the
// panel's own copy fills in. Null when the panel does not hold the revision the server compared against (responses
// raced, or the panel never had it): the caller must then read the full snapshot rather than keep a stale set.
export function resolveSnapshot(snapshot, held) {
    if (!snapshot || typeof snapshot !== "object") return null;
    if (Array.isArray(snapshot.issues)) return snapshot;
    if (snapshot.issues !== null || !snapshot.issuesRevision || snapshot.issuesRevision !== held?.issuesRevision || !Array.isArray(held.issues)) return null;
    return { ...snapshot, issues: held.issues };
}

// Trace links for a render digest. Every observation rewrites `verifiedAt` and `fetchedAt` even when the evidence is
// unchanged; rows never show them, and the inspector shows them through `format` (to the minute), so only a change
// that is visible changes the digest.
export const linksDigest = (links, format = () => undefined) =>
    JSON.stringify(links, (key, value) => key === "verifiedAt" || key === "fetchedAt" ? format(value) : value);

// The minute a timestamp falls in, for the inspector digest: the inspector shows trace times to the minute, and this
// changes exactly when that label does without formatting every stamp on every poll. Unparseable values stay as sent.
export const minuteKey = value => {
    const at = Date.parse(value);
    return Number.isNaN(at) ? value : Math.floor(at / 60_000);
};

// Request statuses depend on the clock: a queued request turns expired without any field changing.
export const requestStatuses = (requests = [], now = Date.now()) => requests.map(request => requestStatus(request, now));

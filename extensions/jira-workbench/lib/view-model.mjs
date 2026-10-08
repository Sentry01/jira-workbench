// Pure view-model helpers for the panel: every input is explicit, with no DOM and no node: imports.
// The server serves this file as /view-model.mjs next to /model.mjs, which it imports.
import { REQUEST_TTL_MS, jiraFreshness, requestStatus } from "./model.mjs";

export const humanize = value => String(value || "unknown").replace(/[_-]/g, " ");

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

export function sessionState(session) {
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
    return session.stale ? "Stale session" : session.awaitingInput ? "Needs input" : session.awaitingPlan ? "Plan approval" :
        session.interrupted ? "Interrupted" : session.activity ? `Session: ${humanize(session.activity)}` : "Session unknown";
}

const BLOCKING = new Set(["pending", "queued", "uncertain"]);
const EXPIRED = `Launch outcome unknown: no session receipt after ${REQUEST_TTL_MS / 60_000} minutes. Check the project's sessions before starting again.`;

// One work item's launch state: this panel's own launch action first, then the stored requests.
// An expired request is reported but, like a cleared one, never blocks a new launch.
export function launchState({ local = null, requests = [], nodeId, now = Date.now() }) {
    if (local && BLOCKING.has(local.status)) return local.status;
    const statuses = requests.filter(request => request.nodeId === nodeId).map(request => requestStatus(request, now));
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
    if (status === "queued") return "Queued";
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

// What a stored request says about this panel's own launch action, or null to keep the action as it is
// (an attached receipt whose session the trace has not shown yet).
export function launchUpdate(receipt, { linkedSessionIds = [], now = Date.now() } = {}) {
    const status = requestStatus(receipt, now);
    if (status === "failed") return { status: "failed", message: receiptMessage("launch", receipt) };
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
// category, or "status:<name>" for one of the project's own workflow statuses.
export function matches(item, query = "", category = "all") {
    const search = query.trim().toLocaleLowerCase();
    return (!search || [item.key, item.summary, item.assignee, item.parentKey].filter(Boolean).join(" ").toLocaleLowerCase().includes(search))
        && (category === "all" || (category.startsWith("status:") ? item.status === category.slice(7) : item.category === category));
}

// Keeps matching nodes and the ancestors of matches. With no filter, every node keeps all its children.
export function filterTree(roots, query = "", category = "all") {
    const unfiltered = !query.trim() && category === "all";
    return roots.flatMap(node => {
        const children = filterTree(node.children, query, category);
        const hit = matches(node.issue, query, category);
        return hit || children.length ? [{ ...node, children: hit && unfiltered ? node.children : children }] : [];
    });
}

// Distinct linked session IDs among each issue's descendants (as model.mjs descendants() defines them), for every
// issue at once: one key index, then each linked issue walks up its own ancestors. Parent cycles stop at a repeat.
export function descendantSessionCounts(issues, sessionIdsFor) {
    const byKey = new Map(issues.map(issue => [issue.key, issue]));
    const found = new Map();
    for (const issue of issues) {
        const ids = sessionIdsFor(issue.id);
        if (!ids.length) continue;
        const seen = new Set([issue.key]);
        for (let parent = byKey.get(issue.parentKey); parent && !seen.has(parent.key); parent = byKey.get(parent.parentKey)) {
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

// { server, connector } while the Atlassian sign-in is needed (the server name can be unknown), otherwise null.
// A connector is the Copilot app's Atlassian connection: the app signs it in, not the Workbench or /mcp auth.
export const signInNeeded = snapshot => snapshot.connection?.state === "signin"
    ? { server: snapshot.connection.server, connector: Boolean(snapshot.connection.connector) } : null;

// The sign-in call to action and the error banner. An expired sign-in is one clear call to action, not a pile of
// per-source failures and a retry promise. `unavailable` lists execution node IDs with no loaded work item.
export function banner(snapshot, { now = Date.now(), unavailable = [] } = {}) {
    const signIn = signInNeeded(snapshot), connection = snapshot.connection;
    const errors = [
        ...(signIn ? snapshot.catalogErrors.filter(message => !message.startsWith("Jira:")) : snapshot.catalogErrors),
        ...(snapshot.error && !signIn ? [`Jira refresh failed: ${snapshot.error}. Last good data retained.`] : []),
        ...(snapshot.backgroundError && !(signIn && /sign-in has expired/.test(snapshot.backgroundError)) ? [`Background refresh failed: ${snapshot.backgroundError}`] : []),
        ...snapshot.tree.warnings,
        ...(unavailable.length ? [`Execution snapshot references unavailable work items: ${unavailable.join(", ")}. Refresh the workbench to reconcile the sources.`] : []),
    ];
    const retryAt = connection && connection.state !== "ready" ? connection.nextCheckAt : null;
    if (!signIn && (snapshot.catalogErrors.length || snapshot.error) && (snapshot.warming || retryAt))
        errors.push(snapshot.warming ? "Reconnecting now…" : `Reconnecting automatically in about ${Math.max(1, Math.round((Date.parse(retryAt) - now) / 1000))}s. No need to press Reload connections.`);
    return { signIn, errors };
}

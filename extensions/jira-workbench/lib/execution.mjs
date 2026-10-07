import { REQUEST_TTL_MS, requestStatus } from "./model.mjs";

export function dependencyWarnings(issue) {
    return (issue.dependencies || []).filter(dependency =>
        ["is blocked by", "blocked by"].includes((dependency.relationship || "").trim().toLowerCase())
        && dependency.category !== "done",
    ).map(dependency => ({
        id: `dependency:${dependency.key}`,
        message: `${issue.key} is blocked by ${dependency.key} (status: ${dependency.status || "Unknown"}; category: ${dependency.category || "unknown"}).`,
    }));
}

function checkKind(check) {
    const result = check.conclusion || check.state;
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(result))
        return "checks_failed";
    if (check.state === "SUCCESS" || (check.status === "COMPLETED" && check.conclusion === "SUCCESS"))
        return "checks_passed";
    if (check.status === "COMPLETED" && ["SKIPPED", "NEUTRAL"].includes(check.conclusion))
        return "checks_skipped";
    if (["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(check.status) || ["PENDING", "EXPECTED"].includes(check.state))
        return "checks_pending";
    return "checks_unknown";
}

export function deriveExecution({ issue, trace = {}, requests = [], mapping = null, jiraStale = false, now = Date.now() }) {
    const views = new Set(["all"]), signals = [];
    const sessions = trace.sessions || [], prs = trace.prs || [];
    const isProject = issue.id === "project";
    let primary, rank = Infinity;
    const signal = (kind, reason, reference = {}) => signals.push({ kind, reason, ...reference });
    // Ranks order observed attention, not readiness; every observation still contributes its views.
    const offer = (priority, action, view) => {
        if (view) views.add(view);
        if (priority < rank) { primary = action; rank = priority; }
    };
    const uncertainSource = source => Boolean(trace.sourceStatus?.[source]
        && trace.sourceStatus[source].state !== "fresh");
    // A trace error can come from either source, so its refresh re-reads the project's whole live state.
    const refresh = source => ({
        kind: "refresh", source,
        label: source === "jira" ? "Refresh Jira" : source === "all" ? "Refresh live state" : "Refresh trace",
    });

    for (const source of ["sessions", "github"]) {
        if (uncertainSource(source)) {
            const state = trace.sourceStatus[source].state === "stale" ? "stale" : "unknown";
            signal(`${source}_${state}`, `${source} source is ${state}; refresh to verify linked work.`);
            offer(50, refresh(source), "needs-me");
        }
    }
    for (const error of trace.errors || []) {
        signal("trace_error", error);
        offer(50, refresh("all"), "needs-me");
    }
    if (jiraStale) {
        signal("jira_stale", "Jira data is stale; refresh before preparing new work.");
        offer(50, refresh("jira"), "needs-me");
    }
    if (!isProject && !["new", "indeterminate", "done"].includes(issue.category)) {
        signal("jira_unknown", "Jira status category is unknown; refresh before preparing new work.");
        offer(50, refresh("jira"), "needs-me");
    }
    if (!mapping) {
        signal("missing_mapping", "Choose a configured repository before preparing new work.");
        offer(70, { kind: "inspect", label: "Choose repository" }, "needs-me");
    }
    for (const warning of dependencyWarnings(issue)) {
        signal("blocked", warning.message);
        offer(80, { kind: "inspect", label: "Inspect dependencies" }, "needs-me");
    }
    if (issue.category === "done") {
        signal("jira_done", `Jira status is ${issue.status} (done category).`);
        offer(90, { kind: "inspect", label: "Inspect trace" });
    }

    for (const session of sessions) {
        const reference = { sessionId: session.id };
        const name = session.name || session.id;
        const uncertain = session.stale || uncertainSource("sessions") || !["busy", "idle"].includes(session.activity);
        const observed = uncertain ? "last observed: " : "";
        const open = label => ({ kind: "open_session", label, ...reference });
        if (session.stale) {
            signal("session_stale", `${name}: session metadata is stale.`, reference);
            offer(50, refresh("sessions"), "needs-me");
        }
        if (session.awaitingInput) {
            signal("awaiting_input", `${name}: ${observed}${session.awaitingInput.question || "Awaiting your input."}`, reference);
            if (!uncertain) offer(0, open("Answer question"), "needs-me");
        }
        if (session.awaitingPlan) {
            signal("awaiting_plan", `${name}: ${observed}awaiting plan approval.`, reference);
            if (!uncertain) offer(10, open("Review plan"), "needs-me");
        }
        if (session.interrupted) {
            signal("interrupted", `${name}: ${observed}execution was interrupted.`, reference);
            if (!uncertain) offer(20, open("Inspect interruption"), "needs-me");
        }
        if (session.error) {
            signal("session_error", `${name}: ${observed}${session.error}`, reference);
            if (!uncertain) offer(20, open("Inspect failure"), "needs-me");
        }
        if (session.activity === "busy") {
            signal("session_busy", `${name}: ${uncertain ? "last observed running; refresh to verify" : "running"}.`, reference);
            if (!uncertain) offer(40, open("Open session"), "running");
        } else if (session.activity === "idle") {
            if (!uncertain) {
                signal("session_idle", `${name}: idle session; inspect existing work.`, reference);
                offer(60, open("Open session"));
            }
        } else {
            signal("session_unknown", `${name}: session activity is unknown.`, reference);
            offer(50, refresh("sessions"), "needs-me");
        }
    }

    const attempts = requests.map((request, index) => ({
        request, index, at: Date.parse(request.at), status: requestStatus(request, now),
    }));
    const attached = attempts.filter(attempt => attempt.status === "attached");
    for (const { request, index, at, status } of attempts) {
        if (status === "failed") {
            // Only a later attachment resolves a failure; queued requests remain unresolved.
            const superseded = attached.some(success =>
                Number.isFinite(at) && Number.isFinite(success.at) && at !== success.at
                    ? success.at > at : success.index > index,
            );
            const reason = request.error || "A launch request failed.";
            signal("request_failed", superseded ? `${reason} (superseded by a later attached launch).` : reason);
            if (!superseded) offer(20, { kind: "inspect", label: "Inspect failed request" }, "needs-me");
        } else if (status === "queued") {
            signal("request_queued", "A launch request is queued; do not start duplicate work.");
            offer(40, { kind: "inspect", label: "Inspect queued work" }, "running");
        } else if (status === "expired") {
            // No longer running or blocking a new launch, but a session may exist that the receipt never reported.
            signal("request_expired", `Launch outcome unknown: no session receipt after ${REQUEST_TTL_MS / 60_000} minutes. Check the project's sessions before starting again.`);
            offer(20, { kind: "clear_request", label: "Clear stuck request", requestId: request.requestId }, "needs-me");
        } else if (status === "cancelled") {
            signal("request_cancelled", "A launch request was cleared without a session receipt.");
        } else if (status === "attached") {
            signal("request_attached", "A launch request has an attached session.");
            if (!sessions.length) {
                signal("session_unknown", "An attached session is missing from the trace; refresh to verify it.");
                offer(50, refresh("sessions"), "needs-me");
            }
        }
    }

    for (const pr of prs) {
        const reference = { repo: pr.repo, number: pr.number };
        const name = `${pr.repo}#${pr.number}`;
        const uncertain = pr.stale || uncertainSource("github")
            || !["OPEN", "MERGED", "CLOSED"].includes(pr.state)
            || (pr.state === "OPEN" && typeof pr.isDraft !== "boolean");
        const open = label => ({ kind: "open_pr", label, ...reference });
        if (!uncertain && pr.state === "OPEN" && pr.isDraft === false) views.add("prs");
        if (pr.stale) {
            signal("pr_stale", `${name}: PR metadata is stale.`, reference);
            offer(50, refresh("github"), "needs-me");
        }
        if (pr.state === "OPEN") {
            signal(pr.isDraft === true ? "pr_draft" : "pr_open",
                `${name}: ${uncertain ? "last observed " : ""}${pr.isDraft === true ? "draft" : "open"} PR.`, reference);
            if (typeof pr.isDraft !== "boolean") {
                signal("pr_unknown", `${name}: draft status is unknown.`, reference);
                offer(50, refresh("github"), "needs-me");
            } else if (!uncertain) {
                if (pr.isDraft) offer(55, open("Open draft PR"));
                else offer(30, open("Review PR"), "needs-me");
            }
            if (pr.reviewDecision === "CHANGES_REQUESTED") {
                signal("changes_requested", `${name}: review changes requested${uncertain ? " (last observed)" : ""}.`, reference);
                if (!uncertain) offer(20, open("Inspect review"), "needs-me");
            } else if (pr.reviewDecision === "APPROVED") {
                signal("review_approved", `${name}: review approved${uncertain ? " (last observed)" : ""}; this does not establish completion.`, reference);
            }
        } else if (pr.state === "MERGED" || pr.state === "CLOSED") {
            signal(pr.state === "MERGED" ? "pr_merged" : "pr_closed",
                `${name}: ${uncertain ? "last observed " : ""}${pr.state.toLowerCase()} PR; inspect the delivery trace.`, reference);
            if (pr.state === "MERGED" && !isProject && issue.category !== "done")
                signal("jira_mismatch", `${name}: PR was ${uncertain ? "last observed " : ""}merged, but Jira is not done; inspect the mismatch.`, reference);
            if (!uncertain) offer(55, { kind: "inspect", label: "Inspect trace" });
        } else {
            signal("pr_unknown", `${name}: PR state is unknown.`, reference);
            offer(50, refresh("github"), "needs-me");
        }
        const checks = pr.statusCheckRollup || [];
        if (!checks.length) signal("checks_not_reported", `${name} checks: Not reported.`, reference);
        for (const check of checks) {
            const kind = checkKind(check);
            const reported = check.conclusion || check.state || check.status || "Not reported";
            const outcome = kind === "checks_unknown" ? `Unknown outcome (${reported})` : reported;
            signal(kind, `${name} check ${check.name || check.context || "Unnamed check"}: ${outcome}${uncertain ? " (last observed; refresh needed)" : ""}.`, reference);
            if (!uncertain && kind === "checks_failed") offer(20, open("Inspect checks"), "needs-me");
        }
    }

    // No explicit gate, uncertainty, blocker, or existing work was observed.
    if (!primary) {
        const plan = issue.level > 0;
        signal("available", "Available to prepare a review brief (advisory; not implementation readiness).");
        offer(100, {
            kind: "prepare", label: plan ? "Prepare plan" : "Prepare implementation",
            mode: plan ? "plan" : "autopilot",
        }, "available");
    }
    return {
        nodeId: issue.id, views: [...views], signals,
        reasons: [...new Set(signals.map(item => item.reason))], primary, rank,
    };
}

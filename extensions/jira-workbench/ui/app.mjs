import { scopeKey, descendants, progressRollup, freshnessTone, jiraFreshness } from "/model.mjs";
import {
    humanize, sourceFreshness, freshnessSummary, sessionState, sessionsBadge, launchState, launchBlocks, launchLabel, requestOutcome,
    receiptMessage, launchUpdate, primaryReason, executionEvidence, matches, filterTree, descendantSessionCounts, defaultMode,
    signInNeeded, banner,
} from "/view-model.mjs";

const $ = id => document.getElementById(id);
const jiraMark = className => {
    const mark = document.querySelector(".brand-icon").cloneNode(true);
    mark.setAttribute("class", className);
    return mark;
};
const token = location.hash.slice(1);
const filters = [["needs-me", "Needs me"], ["running", "Running"], ["prs", "PRs to review"], ["available", "Available to start"], ["all", "All work"]];
const defaults = () => ({ view: "execution", executionFilter: "all", selected: null, collapsed: [], query: "", category: "all", scrollTop: 0, detailsOpen: false });
let state = { sites: [], projects: [], appProjects: [], issues: [], links: {}, requests: [], executions: [], navigationReceipts: [], tree: { roots: [], warnings: [] }, catalogErrors: [] };
let ui = defaults(), tab = "trace", focusedNode = null, scopeEpoch = 0;
let selecting = false, scopeConfirmed = true, selectionVersion = 0, selectionChain = Promise.resolve(), pollPending = false, snapshotVersion = 0;
let preferenceTimer, preferenceRequest, preferenceRevision = 0;
// Scrolling saves about a second after it stops, and only when the position differs from the last one saved.
const PREFERENCE_SAVE_MS = 350, SCROLL_SAVE_MS = 1000;
let scrollTimer, savedScrollTop = 0;
let preview = null, previewScope = null, previewDirty = false, formRevision = 0, previewVersion = 0;
let reviewing = false, launching = false, inspectorDigest = "", treeDigest = "";
const collapsed = new Set(), actions = new Map(), localPreferences = new Map();
const initialPreferenceEdits = new Set();
const disclosures = new Map(), linkDrafts = new Map(), submittedPreviews = new Set();
const connectionMessages = new Map();
const executionRefreshes = new Map();

function el(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
}
function button(text, action, className = "") {
    const b = el("button", text, className);
    b.type = "button";
    b.addEventListener("click", event => { event.stopPropagation(); action(); });
    return b;
}
function link(text, href, className = "") {
    let url;
    try {
        url = new URL(href);
        if (url.protocol !== "https:") throw new Error("Only HTTPS source links are allowed.");
    } catch (error) {
        const unavailable = el("span", text, className);
        unavailable.append(el("small", ` (source link unavailable: ${error.message})`, "trace-error"));
        return unavailable;
    }
    const a = el("a", text, className);
    a.href = url.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
}
const badge = (text, tone = "") => el("span", text, `badge ${tone}`);
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "not refreshed";
const actionKey = (kind, target, scope = state.scope) => JSON.stringify([scope || "", kind, target]);
const jiraUrl = key => `${state.site.url}/browse/${encodeURIComponent(key)}`;
const itemUrl = item => item.id === "project" ? `${state.site.url}/jira/software/projects/${encodeURIComponent(state.project.key)}/summary` : jiraUrl(item.key);
function nodeLinks(id) {
    const trace = state.site && state.project ? state.links[scopeKey(state.site.id, state.project.id, id)] : null;
    return { sessions: [], prs: [], ...trace };
}
function setSource(element, text, tone, detail) {
    element.textContent = text;
    element.dataset.tone = tone;
    element.dataset.detail = detail;
    element.setAttribute("aria-label", detail ? `${text}. ${detail}` : text);
}
const nodeLaunch = id => launchState({ local: actions.get(actionKey("launch", id)), requests: state.requests, nodeId: id });
const nodePending = id => launchBlocks(nodeLaunch(id));
function getItem(id) {
    if (id !== "project") return state.issues.find(item => item.id === id);
    if (!state.project) return null;
    return {
        id: "project", key: state.project.key, summary: state.project.name, type: "Project", level: 2,
        status: "Project scope", category: "unknown", labels: [], dependencies: [],
        assignee: "Not applicable", priority: "Not applicable",
        description: "Project coordination scope. Child issues keep their own Jira statuses, sessions and pull requests.",
    };
}
async function api(path, input, signal) {
    const response = await fetch(`/api/${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "x-workbench-token": token, "Content-Type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        ...(signal ? { signal } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || `Request failed (${response.status})`);
        error.httpStatus = response.status;
        throw error;
    }
    return result;
}
function refreshExecution(source = "all", epoch = scopeEpoch, afterCurrent = false) {
    const key = `${epoch}:${source}`;
    const existing = executionRefreshes.get(`${epoch}:all`) || executionRefreshes.get(key);
    if (existing && !afterCurrent) return existing;
    const preceding = source === "all" ? ["all", "sessions", "github"].map(name => executionRefreshes.get(`${epoch}:${name}`)).filter(Boolean) : [];
    // Earlier callers report their failures; an explicit refresh still gets its own attempt.
    const pending = Promise.allSettled(preceding).then(() => {
        if (epoch !== scopeEpoch || selecting || !scopeConfirmed) throw new Error("Project selection changed before the live refresh could run.");
        return api("refresh-execution", { source });
    }).finally(() => {
        if (executionRefreshes.get(key) === pending) executionRefreshes.delete(key);
    });
    executionRefreshes.set(key, pending);
    return pending;
}
function connectionMessage(key, message) {
    if ((message && connectionMessages.get(key) === message) || (!message && !connectionMessages.has(key))) return;
    if (message) connectionMessages.set(key, message); else connectionMessages.delete(key);
    $("connection-status").replaceChildren(...[...connectionMessages.values()].map(text => el("p", text)));
    $("connection-status").hidden = !connectionMessages.size;
}
function normalizePreferences(value = {}) {
    return {
        view: value.view === "hierarchy" ? "hierarchy" : "execution",
        executionFilter: filters.some(([id]) => id === value.executionFilter) ? value.executionFilter : "all",
        selected: typeof value.selected === "string" ? value.selected : null,
        collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter(id => typeof id === "string") : [],
        query: typeof value.query === "string" ? value.query : "",
        category: ["all", "new", "indeterminate", "done"].includes(value.category)
            || typeof value.category === "string" && value.category.startsWith("status:") && value.category.length > 7 && value.category.length <= 207 ? value.category : "all",
        scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0,
        detailsOpen: value.detailsOpen === true,
    };
}
function preferences() {
    return { ...ui, collapsed: [...collapsed] };
}
function rememberPreferences() {
    if (state.scope) localPreferences.set(state.scope, preferences());
}
function cancelPreferenceSave() {
    clearTimeout(preferenceTimer);
    clearTimeout(scrollTimer);
    preferenceRequest?.controller.abort();
    preferenceRequest = null;
    preferenceRevision++;
}
function savePreferences(...changedKeys) {
    queuePreferenceSave(changedKeys, PREFERENCE_SAVE_MS);
}
function queuePreferenceSave(changedKeys, delay) {
    if (!state.scope) changedKeys.forEach(key => initialPreferenceEdits.add(key));
    rememberPreferences();
    preferenceRevision++;
    clearTimeout(preferenceTimer);
    if (state.scope && !selecting && scopeConfirmed) preferenceTimer = setTimeout(flushPreferences, delay);
}
function flushPreferences() {
    clearTimeout(preferenceTimer);
    if (!state.scope || selecting || !scopeConfirmed) return Promise.resolve(null);
    if (preferenceRequest) return preferenceRequest.completion;
    const scope = state.scope, epoch = scopeEpoch, revision = preferenceRevision, sent = preferences();
    const controller = new AbortController();
    const request = { controller, completion: null };
    preferenceRequest = request;
    request.completion = (async () => {
        try {
            await api("preferences", { scope, preferences: sent }, controller.signal);
            if (scope === state.scope && epoch === scopeEpoch) {
                savedScrollTop = sent.scrollTop;
                connectionMessage("preferences", "");
            }
            return { scope, epoch, revision, error: null };
        } catch (error) {
            if (error.name !== "AbortError" && scope === state.scope && epoch === scopeEpoch) {
                connectionMessage("preferences", `View preferences could not be saved: ${error.message}. Kept in this panel; the next change will try saving again.`);
            }
            return { scope, epoch, revision, error };
        } finally {
            if (preferenceRequest === request) {
                preferenceRequest = null;
                if (scope === state.scope && epoch === scopeEpoch && revision !== preferenceRevision) preferenceTimer = setTimeout(flushPreferences, PREFERENCE_SAVE_MS);
            }
        }
    })();
    return request.completion;
}
function acceptSnapshot(snapshot, { allowScopeChange = false } = {}) {
    if (!snapshot || !Array.isArray(snapshot.issues)) throw new Error("The workbench returned an invalid snapshot.");
    const changedScope = snapshot.scope !== state.scope;
    const hasInitialEdits = !state.scope && initialPreferenceEdits.size > 0;
    if (changedScope && state.scope && !allowScopeChange) {
        scopeConfirmed = false;
        cancelPreferenceSave();
        closePreview();
        connectionMessage("scope", "The selected project changed elsewhere. Select a project here to continue; this view has not been replaced.");
        render();
        return false;
    }
    if (changedScope) {
        const initialPreferences = state.scope ? null : preferences();
        rememberPreferences();
        cancelPreferenceSave();
        closePreview();
        ui = normalizePreferences(localPreferences.get(snapshot.scope) || snapshot.preferences);
        savedScrollTop = normalizePreferences(snapshot.preferences).scrollTop;
        if (initialPreferences) {
            for (const key of initialPreferenceEdits) ui[key] = initialPreferences[key];
            if (snapshot.scope) initialPreferenceEdits.clear();
        }
        collapsed.clear();
        ui.collapsed.forEach(id => collapsed.add(id));
        focusedNode = ui.selected;
        tab = "trace";
        inspectorDigest = "";
        treeDigest = "";
        disclosures.clear();
        linkDrafts.clear();
        $("search").value = ui.query;
        $("status-filter").value = ui.category;
        connectionMessage("scope", "");
        connectionMessage("preferences", "");
    }
    scopeConfirmed = true;
    connectionMessage("scope", "");
    if (preview && state.mapping?.id !== snapshot.mapping?.id) markPreviewDirty();
    state = { ...snapshot, executions: snapshot.executions || [], navigationReceipts: snapshot.navigationReceipts || [] };
    reconcileReceipts();
    render({ force: changedScope });
    updateLaunchControls();
    if (changedScope && (localPreferences.has(state.scope) || hasInitialEdits)) savePreferences();
    return true;
}
async function sync(epoch = scopeEpoch) {
    const version = ++snapshotVersion;
    const snapshot = await api("state");
    if (epoch === scopeEpoch && version === snapshotVersion && !selecting) acceptSnapshot(snapshot);
}

function configureActionControl(control, kind, target, disabled = false, scope = state.scope) {
    control.dataset.actionKey = actionKey(kind, target, scope);
    if (!control.dataset.baseLabel) control.dataset.baseLabel = control.textContent;
    control.dataset.baseDisabled = String(disabled);
    control.dataset.focusKey = `${kind}:${target}`;
    control.dataset.prepareNode = kind === "prepare" ? target : "";
    control.dataset.projectAction = String(scope !== null);
    updateActionControl(control);
    return control;
}
function updateActionControl(control) {
    const action = actions.get(control.dataset.actionKey);
    const pending = action && ["pending", "queued", "uncertain"].includes(action.status);
    const launchPending = control.dataset.prepareNode && nodePending(control.dataset.prepareNode);
    control.disabled = control.dataset.baseDisabled === "true" || Boolean(pending) || Boolean(launchPending) ||
        (control.dataset.projectAction === "true" && (selecting || !scopeConfirmed));
    control.textContent = pending ? action.status === "pending" ? "Working..." : action.status === "queued" ? "Queued" : "Check receipt" : control.dataset.baseLabel;
    control.setAttribute("aria-busy", String(action?.status === "pending"));
}
function actionButton(text, kind, target, nodeId, work, options = {}) {
    const b = button(text, () => void perform({ kind, target, nodeId, label: text, work, ...options }), options.className);
    return configureActionControl(b, kind, target, options.disabled);
}
async function perform({ kind, target, nodeId, label, work, success, refresh = false, global = false, previewId }) {
    const scope = global ? null : state.scope, epoch = scopeEpoch;
    const key = actionKey(kind, target, scope), previous = actions.get(key);
    if (previous && ["pending", "queued", "uncertain"].includes(previous.status)) return;
    if ((selecting || !scopeConfirmed) && !global) return;
    if (kind === "prepare" && nodePending(nodeId)) return;
    const record = { kind, scope, nodeId, previewId, status: "pending", message: `${label}...`, dismissed: false };
    actions.set(key, record);
    paintFeedback();
    try {
        const result = await work({ scope, epoch, current: () => scope === state.scope && epoch === scopeEpoch && !selecting && scopeConfirmed });
        if (result?.requestId) {
            if (!["queued", "acknowledged", "failed"].includes(result.status)) throw new Error("The host returned an unrecognized receipt status.");
            record.requestId = result.requestId;
            record.status = result.status;
            record.message = receiptMessage(record.kind, result);
        } else {
            record.status = "success";
            record.message = success || `${label}: complete.`;
        }
        if (refresh && epoch === scopeEpoch && !selecting) {
            try {
                await sync(epoch);
            } catch (error) {
                connectionMessage("poll", `Action returned, but the local snapshot could not be read: ${error.message}. Refresh live state to reconcile.`);
            }
        }
    } catch (error) {
        const uncertain = kind === "launch" && (!error.httpStatus || error.httpStatus >= 500);
        record.status = uncertain ? "uncertain" : "failed";
        record.message = uncertain
            ? `Launch outcome unknown: ${error.message}. No retry was sent. Refresh live state and inspect the launch receipt before starting again.`
            : `${label} failed: ${error.message}`;
        if (kind === "launch" && preview?.node.id === nodeId && previewScope === scope) {
            previewDirty = true;
            $("launch-warning-ack").checked = false;
            $("launch-error").textContent = record.message;
            $("launch-error").hidden = false;
        }
    } finally {
        if (kind === "map" && scope === state.scope && epoch === scopeEpoch) {
            selectOptions($("repository"), state.appProjects.map(project => ({ value: project.id, label: project.repo || project.name })), state.mapping?.id, "Choose a Copilot repository", true);
        }
        paintFeedback();
        updateLaunchControls();
    }
}
function reconcileReceipts() {
    for (const record of actions.values()) {
        // An expired launch stays open to a late receipt, which still attaches its session.
        if (record.scope !== state.scope || !["pending", "queued", "uncertain", "expired"].includes(record.status)) continue;
        if (record.kind === "launch") {
            const receipt = state.requests.find(r => (record.requestId && r.requestId === record.requestId) || (record.previewId && r.previewId === record.previewId));
            if (!receipt) continue;
            record.requestId = receipt.requestId;
            const update = launchUpdate(receipt, { linkedSessionIds: nodeLinks(record.nodeId).sessions.map(session => session.id) });
            if (update) Object.assign(record, update);
        } else if (record.requestId) {
            const receipt = state.navigationReceipts.find(r => r.requestId === record.requestId);
            if (receipt && ["queued", "acknowledged", "failed"].includes(receipt.status)) {
                record.status = receipt.status;
                record.message = receiptMessage(record.kind, receipt);
            }
        }
    }
}
function paintFeedback() {
    for (const control of document.querySelectorAll("[data-action-key]")) updateActionControl(control);
    $("repository").disabled = selecting || !scopeConfirmed || !state.project || !state.appProjects.length || actions.get(actionKey("map", "repository"))?.status === "pending";
    const visible = [...actions.values()].filter(a => (a.scope === null || a.scope === state.scope) && !a.dismissed);
    const signature = JSON.stringify(visible.map(a => [a.status, a.message]));
    if ($("notice").dataset.signature !== signature) {
        $("notice").dataset.signature = signature;
        $("notice").replaceChildren(...visible.map(record => {
            const row = el("div", null, `action-notice ${["failed", "uncertain", "expired"].includes(record.status) ? "notice-error" : ""}`);
            row.append(el("span", record.message));
            if (!["pending", "queued", "uncertain"].includes(record.status)) {
                const dismiss = button("Dismiss", () => { record.dismissed = true; paintFeedback(); });
                dismiss.setAttribute("aria-label", `Dismiss: ${record.message}`);
                row.append(dismiss);
            }
            return row;
        }));
    }
    $("notice").hidden = !visible.length;
    for (const feedback of document.querySelectorAll("[data-feedback-node]")) {
        const messages = visible.filter(a => a.nodeId === feedback.dataset.feedbackNode);
        const text = messages.map(a => a.message).join(" ");
        if (feedback.textContent !== text) feedback.textContent = text;
        feedback.hidden = !text;
    }
}
function feedbackFor(nodeId) {
    const feedback = el("div", null, "action-feedback");
    feedback.dataset.feedbackNode = nodeId;
    return feedback;
}
function selectOptions(select, options, value, placeholder, force = false) {
    if (!force && document.activeElement === select) return;
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
        select.replaceChildren(new Option(placeholder, ""), ...options.map(option => new Option(option.label, option.value)));
        select.dataset.options = signature;
    }
    select.value = value || "";
}
const CATEGORY_LABELS = { new: "To do", indeterminate: "In progress", done: "Done", unknown: "Other" };
// Built per project: each status category, then that project's own workflow statuses in it (e.g. "PR Waiting").
function renderStatusFilter() {
    const select = $("status-filter"), statuses = state.statuses || [];
    if (document.activeElement === select) return;
    const missing = ui.category.startsWith("status:") && !statuses.some(status => `status:${status.name}` === ui.category);
    const signature = JSON.stringify([statuses, missing && ui.category]);
    if (select.dataset.options !== signature) {
        select.dataset.options = signature;
        const groups = Object.entries(CATEGORY_LABELS).flatMap(([category, label]) => {
            const own = statuses.filter(status => status.category === category);
            if (category === "unknown" && !own.length) return [];
            const group = document.createElement("optgroup");
            group.label = label;
            if (category !== "unknown") group.append(new Option(`${label} (any)`, category));
            group.append(...own.map(status => new Option(status.name, `status:${status.name}`)));
            return [group];
        });
        select.replaceChildren(new Option("All Jira statuses", "all"), ...groups,
            ...missing ? [new Option(`${ui.category.slice(7)} (not listed)`, ui.category)] : []);
    }
    select.value = ui.category;
}
function captureFocus(container) {
    return container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
}
function restoreFocus(container, key) {
    if (!key) return;
    [...container.querySelectorAll("[data-focus-key]")].find(element => element.dataset.focusKey === key)?.focus({ preventScroll: true });
}
function chooseItem(id) {
    ui.selected = id;
    ui.detailsOpen = true;
    focusedNode = id;
    tab = "trace";
    savePreferences("selected", "detailsOpen");
    render({ force: true });
    if (matchMedia("(max-width: 1000px)").matches) $("back-to-work").focus({ preventScroll: true });
}
function render({ force = false } = {}) {
    if (!selecting) {
        selectOptions($("site"), state.sites.map(s => ({ value: s.id, label: s.name })), state.site?.id, "Select Jira site");
        selectOptions($("project"), state.projects.map(p => ({ value: p.id, label: `${p.key} - ${p.name}` })), state.project?.id, "Select Jira project");
    }
    selectOptions($("repository"), state.appProjects.map(p => ({ value: p.id, label: p.repo || p.name })), state.mapping?.id, "Choose a Copilot repository");
    renderStatusFilter();
    configureActionControl($("project-start"), "prepare", "project", !state.project || !state.mapping || state.cached);
    configureActionControl($("sync-jira"), "launch", "project", selecting || !state.project || !state.mapping || Boolean(state.error) || state.cached || nodePending("project"));
    configureActionControl($("refresh"), "refresh-jira", "jira", selecting || !state.project);
    configureActionControl($("refresh-execution"), "refresh-execution", "all", selecting || !state.project);
    configureActionControl($("connections"), "catalog", "connections", false, null);
    $("project-title").textContent = state.project?.name || "Your work, connected.";
    $("project-title").disabled = !state.project;
    const unavailableExecutions = state.executions.filter(execution => !getItem(execution.nodeId)).map(execution => execution.nodeId);
    const { signIn, errors } = banner(state, { unavailable: unavailableExecutions });
    $("sign-in").hidden = !signIn;
    if (signIn) {
        $("sign-in-server").textContent = signIn.server;
        $("sign-in-button").hidden = $("sign-in-mcp").hidden = signIn.connector;
        $("sign-in-connector").hidden = !signIn.connector;
        // A browser-flow link started for an MCP server does not apply to the app's connector.
        if (signIn.connector) $("sign-in-status").hidden = true;
    }
    else $("sign-in-status").hidden = true;
    const errorSignature = JSON.stringify(errors);
    if ($("errors").dataset.signature !== errorSignature) {
        $("errors").dataset.signature = errorSignature;
        $("errors").replaceChildren(...errors.map(message => el("p", message)));
    }
    $("errors").hidden = !errors.length;
    const work = state.issues.filter(i => i.level <= 0);
    const allLinks = ["project", ...state.issues.map(item => item.id)].map(nodeLinks);
    const metrics = [
        [state.issues.filter(i => i.level > 0).length, "Epics / parents"],
        [work.length, "Work items"],
        [work.filter(i => i.category === "done").length, "Jira done"],
        [new Set(allLinks.flatMap(trace => trace.sessions.map(s => s.id))).size, "Linked sessions"],
        [new Set(allLinks.flatMap(trace => trace.prs.map(p => `${p.repo}#${p.number}`))).size, "Pull requests"],
    ];
    $("metrics").replaceChildren(...metrics.map(([value, label]) => {
        const block = el("div", null, "metric");
        block.append(el("strong", value), el("span", label));
        return block;
    }));
    const jira = jiraFreshness(state, time);
    setSource($("freshness"), `Jira: ${jira.text}`, jira.tone, jira.detail);
    const unverified = { jira: Boolean(state.stale || state.cached) };
    for (const source of ["sessions", "github"]) {
        const freshness = sourceFreshness(allLinks, source, time);
        const label = source === "sessions" ? "Sessions" : "GitHub";
        setSource($(source === "sessions" ? "session-freshness" : "github-freshness"), `${label}: ${freshness.label}`, freshnessTone(freshness), freshness.detail);
        unverified[source] = freshness.needed && freshness.label !== "fresh";
    }
    renderProgress(work, unverified);
    $("workbench").dataset.detailsOpen = String(ui.detailsOpen);
    $("show-details").disabled = !getItem(ui.selected);
    $("view-execution").setAttribute("aria-pressed", String(ui.view === "execution"));
    $("view-hierarchy").setAttribute("aria-pressed", String(ui.view === "hierarchy"));
    $("execution-filters").hidden = ui.view !== "execution";
    $("hierarchy-header").hidden = ui.view !== "hierarchy";
    $("expand").hidden = ui.view !== "hierarchy";
    renderExecutionFilters();
    renderTree(force);
    renderInspector(force);
    paintFeedback();
}
function renderProgress(work, unverified) {
    const tracker = $("progress-tracker");
    tracker.hidden = !state.project;
    if (!state.project) return;
    const { total, current, stages } = progressRollup(work, nodeLinks, { requests: state.requests, unverified });
    const signature = JSON.stringify([total, current, stages]);
    if (tracker.dataset.signature === signature) return;
    tracker.dataset.signature = signature;
    tracker.style.setProperty("--steps", stages.length);
    tracker.style.setProperty("--current", Math.max(current, 0));
    tracker.dataset.empty = String(current < 0);
    tracker.title = "Each stage counts work items with that stage's own evidence; a later stage does not imply earlier ones.";
    tracker.replaceChildren(...stages.map(stage => {
        const step = el("li", null, `progress-step ${stage.state}`);
        if (stage.id === stages[current]?.id) step.setAttribute("aria-current", "step");
        const note = stage.unverified ? "; source needs refresh" : "";
        step.title = `${stage.label}: ${stage.count} of ${total} work items${note}`;
        step.append(el("span", stage.label, "progress-label"), el("span", `${stage.count} of ${total}${stage.unverified ? " (unverified)" : ""}`, "progress-count"));
        return step;
    }));
}
function executionFor(id) {
    return state.executions.find(item => item.nodeId === id) || {
        nodeId: id, views: ["all"], signals: [], reasons: ["Live execution state has not been observed. Refresh live state to check."],
        primary: { kind: "inspect", label: "Inspect work" }, rank: Number.MAX_SAFE_INTEGER,
    };
}
function executionItems() {
    if (!state.project) return [];
    return state.executions.map(execution => ({ item: getItem(execution.nodeId), execution })).filter(entry => entry.item);
}
function evidenceList(evidence) {
    const list = el("ul", null, "more-evidence-list");
    for (const text of evidence) list.append(el("li", text));
    return list;
}
function renderExecutionFilters() {
    const entries = executionItems().filter(({ item }) => matches(item, ui.query, ui.category));
    const signature = JSON.stringify([ui.executionFilter, filters.map(([id]) => entries.filter(({ execution }) => id === "all" || execution.views.includes(id)).length)]);
    if ($("execution-filters").dataset.signature === signature) return;
    const focus = captureFocus($("execution-filters"));
    $("execution-filters").dataset.signature = signature;
    $("execution-filters").replaceChildren(...filters.map(([id, label]) => {
        const count = entries.filter(({ execution }) => id === "all" || execution.views.includes(id)).length;
        const chip = button("", () => {
            ui.executionFilter = id;
            savePreferences("executionFilter");
            renderExecutionFilters();
            renderTree(true);
            paintFeedback();
        }, "filter-chip");
        chip.id = `filter-${id}`;
        chip.dataset.focusKey = `filter:${id}`;
        chip.setAttribute("aria-pressed", String(ui.executionFilter === id));
        chip.setAttribute("aria-label", `${label}: ${count} matching work scopes`);
        chip.append(el("span", label), el("span", count, "filter-count"));
        return chip;
    }));
    restoreFocus($("execution-filters"), focus);
}
function primaryAction(item) {
    const primary = executionFor(item.id).primary || { kind: "inspect", label: "Inspect work" };
    const label = primary.label || "Inspect work";
    if (primary.kind === "prepare") {
        return actionButton(label, "prepare", item.id, item.id, context => preparePreview(item.id, primary.mode, context), {
            className: "row-action primary", disabled: !state.mapping, success: "Session scope ready for review.",
        });
    }
    if (primary.kind === "open_session") return openSessionButton(label, item.id, primary.sessionId);
    if (primary.kind === "open_pr") return openPrButton(label, item.id, primary.repo, primary.number);
    if (primary.kind === "refresh") return refreshSourceButton(label, primary.source || "all", item.id);
    if (primary.kind === "clear_request") return clearRequestButton(label, item.id, primary.requestId);
    const inspect = button(label, () => chooseItem(item.id), "row-action");
    inspect.dataset.focusKey = `inspect:${item.id}`;
    return inspect;
}
// Clearing takes two clicks: the first arms "Confirm clear" for a few seconds, and only the second sends.
const CLEAR_CONFIRM_MS = 8000;
const armedClears = new Map();
function armClear(key, armed) {
    clearTimeout(armedClears.get(key));
    if (armed) armedClears.set(key, setTimeout(() => armClear(key, false), CLEAR_CONFIRM_MS));
    else armedClears.delete(key);
    for (const control of document.querySelectorAll("[data-clear-label]")) {
        if (control.dataset.actionKey !== key) continue;
        control.dataset.baseLabel = armed ? "Confirm clear" : control.dataset.clearLabel;
        control.classList.toggle("confirming", armed);
        updateActionControl(control);
    }
}
function clearRequestButton(label, nodeId, requestId) {
    const key = actionKey("clear-request", requestId), armed = armedClears.has(key);
    const control = button(armed ? "Confirm clear" : label, () => {
        if (!armedClears.has(key)) { armClear(key, true); return; }
        armClear(key, false);
        void clearRequest(nodeId, requestId, label, $("tree").contains(control) ? $("tree") : $("inspector-content"));
    }, `row-action${armed ? " confirming" : ""}`);
    control.dataset.clearLabel = label;
    control.title = "Check the project's sessions first: the launch may have created one without a receipt. Clearing frees Start; a late receipt still attaches its session.";
    return configureActionControl(control, "clear-request", requestId, !requestId);
}
async function clearRequest(nodeId, requestId, label, origin) {
    await perform({
        kind: "clear-request", target: requestId, nodeId, label, refresh: true,
        work: async () => { await api("clear-request", { requestId }); },
        success: "Stuck request cleared. Start is available again; a late receipt still attaches its session.",
    });
    if (actions.get(actionKey("clear-request", requestId))?.status !== "success") return;
    // The cleared item's actions change: re-render now rather than after focus leaves. The pending button lost
    // focus when it was disabled, so put focus back on the row, or on the inspector's Start button.
    render({ force: true });
    if (document.activeElement && document.activeElement !== document.body) return;
    if (origin === $("tree")) focusRow(nodeId);
    else restoreFocus(origin, `prepare:${nodeId}`);
}
function openSessionButton(label, nodeId, sessionId) {
    return actionButton(label, "open", sessionId, nodeId, context => navigateToNode("open", { nodeId, sessionId }, context),
        { className: "row-action", disabled: !sessionId });
}
function openPrButton(label, nodeId, repo, number) {
    return actionButton(label, "open-pr", `${repo}#${number}`, nodeId, context => navigateToNode("open-pr", { nodeId, repo, number }, context),
        { className: "row-action", disabled: !repo || !Number.isInteger(number) || number < 1 });
}
async function navigateToNode(path, target, context) {
    if (!context.current() || !getItem(target.nodeId)) throw new Error("The target project or work item changed; navigation was not sent.");
    chooseItem(target.nodeId);
    let saved;
    do {
        if (!context.current() || ui.selected !== target.nodeId) throw new Error("Selection changed while saving; navigation was not sent.");
        saved = await flushPreferences();
        if (!context.current() || ui.selected !== target.nodeId) throw new Error("Selection changed while saving; navigation was not sent.");
        if (saved?.error) throw new Error(`Selection could not be saved; navigation was not sent: ${saved.error.message}`);
        if (!saved || saved.scope !== context.scope || saved.epoch !== context.epoch) throw new Error("The project preference save was superseded; navigation was not sent.");
        // An older in-flight save must not stand in for the newly selected node's preferences.
    } while (saved.revision !== preferenceRevision);
    const receipt = await api(path, target);
    if (!receipt.requestId) throw new Error("Navigation did not return a request receipt.");
    return receipt;
}
function refreshSourceButton(label, source = "all", nodeId) {
    const jira = source === "jira";
    return actionButton(label, jira ? "refresh-jira" : "refresh-execution", source, nodeId,
        context => jira ? api("refresh", {}) : refreshExecution(source, context.epoch), {
        className: "row-action",
        refresh: true, success: jira ? "Jira refresh returned; live source freshness is independent." :
            `${source === "all" ? "Live sources" : humanize(source)} refresh returned; see each source's freshness.`,
    });
}
function renderTree(force = false) {
    const container = $("tree");
    const signature = JSON.stringify([ui.view, ui.executionFilter, ui.query, ui.category, ui.selected, [...collapsed], state.issues, state.tree, state.executions, state.links, state.requests, state.mapping, selecting, scopeConfirmed]);
    if (!force && (container.contains(document.activeElement) || signature === treeDigest)) return;
    const focus = captureFocus(container);
    treeDigest = signature;
    container.replaceChildren();
    container.setAttribute("role", ui.view === "hierarchy" ? "tree" : "list");
    container.setAttribute("aria-label", ui.view === "hierarchy" ? "Jira work hierarchy" : "Daily execution queue");
    if (!state.project) {
        const empty = el("div", null, "empty");
        empty.append(el("h3", "Choose a Jira project"), el("p", "All epics, issues and subtasks. No active sprint required."));
        container.append(empty);
        $("work-count").textContent = "No project loaded";
        return;
    }
    if (ui.view === "execution") {
        const entries = executionItems().filter(({ item, execution }) => matches(item, ui.query, ui.category) && (ui.executionFilter === "all" || execution.views.includes(ui.executionFilter)));
        entries.sort((a, b) => (a.execution.rank ?? Number.MAX_SAFE_INTEGER) - (b.execution.rank ?? Number.MAX_SAFE_INTEGER) || a.item.key.localeCompare(b.item.key));
        for (const { item, execution } of entries) {
            const row = createRow(item, 0);
            row.classList.add("execution-row");
            const name = itemName(item, null, true);
            const why = el("div", null, "execution-why"), reason = el("p", primaryReason(execution), "execution-reason");
            reason.title = reason.textContent;
            why.append(reason);
            const evidence = executionEvidence(item, execution, nodeLinks(item.id));
            if (evidence.length) {
                const details = disclosure("queue-evidence", "More evidence", item.id);
                details.classList.add("execution-evidence");
                details.querySelector("summary").dataset.focusKey = `evidence:${item.id}`;
                details.addEventListener("click", event => event.stopPropagation());
                details.append(evidenceList(evidence));
                why.append(details);
            }
            name.append(why);
            const observed = el("div", null, "observed-state");
            observed.append(badge(`Jira: ${item.status}`, item.category));
            appendCompactObserved(observed, item.id);
            row.append(name, observed, primaryAction(item), feedbackFor(item.id));
            container.append(row);
        }
    } else {
        const roots = filterTree(state.tree.roots, ui.query, ui.category);
        const childSessions = descendantSessionCounts(state.issues, id => nodeLinks(id).sessions.map(session => session.id));
        const add = (node, depth, parentId = "", index = 0, count = 1) => {
            const item = node.issue, expanded = !collapsed.has(item.id) || Boolean(ui.query);
            const row = createRow(item, depth, parentId, node.children.length > 0);
            row.setAttribute("aria-posinset", String(index + 1));
            row.setAttribute("aria-setsize", String(count));
            if (node.children.length) row.setAttribute("aria-expanded", String(expanded));
            const name = el("div", null, "item-name");
            name.style.paddingInlineStart = `${Math.min(depth, 6) * 18}px`;
            if (node.children.length) {
                const toggle = button(expanded ? "-" : "+", () => {
                    if (collapsed.has(item.id)) collapsed.delete(item.id); else collapsed.add(item.id);
                    focusedNode = item.id;
                    savePreferences("collapsed");
                    renderTree(true);
                    focusRow(item.id);
                    paintFeedback();
                }, "toggle");
                toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${item.key}`);
                toggle.tabIndex = -1;
                name.append(toggle);
            } else name.append(el("span", "", "toggle-placeholder"));
            name.append(itemName(item, node));
            const status = el("div");
            status.append(badge(item.status, item.category));
            const progress = el("div", null, "progress-cell");
            appendObserved(progress, item.id);
            const sessions = childSessions.get(item.id) || 0;
            if (sessions) progress.append(badge(`${sessions} child session${sessions === 1 ? "" : "s"}`, "session"));
            const signals = executionFor(item.id).signals;
            if (signals.length) progress.append(el("span", signals.map(signal => signal.reason || humanize(signal.kind)).join("; "), "muted"));
            const reason = el("p", executionFor(item.id).reasons.join(" "), "hierarchy-reason");
            row.append(name, status, progress, primaryAction(item), reason, feedbackFor(item.id));
            container.append(row);
            if (expanded) node.children.forEach((child, childIndex) => add(child, depth + 1, item.id, childIndex, node.children.length));
        };
        roots.forEach((node, index) => add(node, 0, "", index, roots.length));
    }
    const rows = [...container.querySelectorAll("[data-node-id]")];
    if (!rows.length) container.append(el("div", ui.view === "execution" && !state.executions.length
        ? "No execution entries reported for this project. Refresh live state, or inspect and start project work from the header."
        : state.issues.length ? "No matching work in this view. Choose All work or clear the search and Jira status filter." : "No visible issues in this project.", "empty"));
    if (!rows.some(row => row.dataset.nodeId === focusedNode)) focusedNode = rows.find(row => row.dataset.nodeId === ui.selected)?.dataset.nodeId || rows[0]?.dataset.nodeId;
    rows.forEach(row => { row.tabIndex = row.dataset.nodeId === focusedNode ? 0 : -1; });
    $("work-count").textContent = `${rows.length} visible work scope${rows.length === 1 ? "" : "s"}`;
    $("work-scroll").scrollTop = ui.scrollTop;
    restoreFocus(container, focus);
}
function itemName(item, node, compact = false) {
    const title = el("div", null, "item-title");
    const meta = el("div", null, "item-keyline");
    meta.append(el("span", (item.type || "Work").slice(0, 1), `type-icon ${item.level > 0 ? "epic" : item.level < 0 ? "subtask" : "story"}`), el("span", item.key, "issue-key"));
    if (item.level > 0 || item.id === "project") meta.append(el("small", compact ? item.type : item.id === "project" ? "Project scope" : "Parent scope", "muted"));
    const summary = el("span", item.summary, "summary");
    if (compact) {
        const line = el("div", null, "execution-title");
        summary.title = item.summary;
        line.append(meta, summary);
        title.append(line);
    } else title.append(meta, summary);
    if (item.parentKey && !compact) title.append(el("small", `In ${item.parentKey}`));
    if (node?.total) title.append(el("small", `${node.done}/${node.total} descendant items Jira done`));
    return title;
}
function appendCompactObserved(container, nodeId) {
    const trace = nodeLinks(nodeId), launch = nodeLaunch(nodeId);
    if (launchBlocks(launch)) container.append(badge(launchLabel(launch), "session"));
    else if (trace.sessions.length) container.append(badge(sessionsBadge(trace.sessions), "session"));
    if (trace.prs.length) {
        const pr = trace.prs[0];
        container.append(badge(trace.prs.length > 1 ? `${trace.prs.length} PRs` :
            `#${pr.number} ${pr.stale ? "stale" : pr.isDraft ? "draft" : humanize(pr.state)}`, pr.state === "MERGED" ? "merged" : "pr"));
    }
    if (!trace.sessions.length && !trace.prs.length && !launchBlocks(launch)) container.append(badge("No linked activity"));
}
function appendObserved(container, nodeId) {
    const traces = nodeLinks(nodeId), launch = nodeLaunch(nodeId);
    if (launchBlocks(launch)) container.append(badge(launchLabel(launch), "session"));
    for (const session of traces.sessions) container.append(badge(`Session: ${sessionState(session)}`, "session"));
    for (const pr of traces.prs) container.append(badge(`#${pr.number}: ${pr.stale ? "stale / " : ""}${pr.isDraft ? "draft / " : ""}${humanize(pr.state)}`, pr.state === "MERGED" ? "merged" : "pr"));
    if (!traces.sessions.length && !traces.prs.length && !launchBlocks(launch)) {
        const observed = executionFor(nodeId).signals.map(signal => humanize(signal.kind));
        container.append(el("span", observed.length ? `Observed: ${[...new Set(observed)].join(" / ")}` : "Execution state unknown", "muted"));
    }
}
function createRow(item, depth, parentId = "", hasChildren = false) {
    const row = el("div", null, `tree-row${ui.selected === item.id ? " selected" : ""}`);
    row.dataset.nodeId = item.id;
    row.dataset.parentId = parentId;
    row.dataset.focusKey = `row:${item.id}`;
    row.setAttribute("role", ui.view === "hierarchy" ? "treeitem" : "listitem");
    if (ui.view === "hierarchy") {
        row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", String(ui.selected === item.id));
    } else if (ui.selected === item.id) row.setAttribute("aria-current", "true");
    row.setAttribute("aria-label", `${item.key} ${item.summary}, Jira ${item.status}`);
    row.addEventListener("click", () => chooseItem(item.id));
    row.addEventListener("focus", () => {
        focusedNode = item.id;
        for (const other of $("tree").querySelectorAll("[data-node-id]")) other.tabIndex = other === row ? 0 : -1;
    });
    row.addEventListener("keydown", event => {
        if (event.target !== row) return;
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); chooseItem(item.id); return; }
        const rows = [...$("tree").querySelectorAll("[data-node-id]")], index = rows.indexOf(row);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
            next?.focus();
        }
        if (ui.view !== "hierarchy" || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const expanded = row.getAttribute("aria-expanded") === "true";
        if (event.key === "ArrowRight" && hasChildren && expanded) rows[index + 1]?.focus();
        else if (event.key === "ArrowLeft" && (!hasChildren || !expanded)) focusRow(parentId);
        else if (hasChildren && !ui.query) {
            if (event.key === "ArrowLeft") collapsed.add(item.id); else collapsed.delete(item.id);
            savePreferences("collapsed");
            renderTree(true);
            focusRow(item.id);
            paintFeedback();
        }
    });
    return row;
}
function focusRow(id) {
    const row = [...$("tree").querySelectorAll("[data-node-id]")].find(item => item.dataset.nodeId === id);
    row?.focus({ preventScroll: true });
    return Boolean(row);
}
function disclosure(key, title, nodeId = ui.selected) {
    const details = el("details", null, "trace-disclosure");
    const id = `${state.scope}:${nodeId}:${key}`;
    details.open = disclosures.get(id) === true;
    details.append(el("summary", title));
    details.addEventListener("toggle", () => { disclosures.set(id, details.open); });
    return details;
}
function reviewedContext(receipt, key) {
    const brief = receipt?.brief, hash = receipt?.contextHash || brief?.hash;
    if (!brief && !hash) return null;
    const details = disclosure(key, "Reviewed context");
    details.dataset.contextHash = hash || "";
    details.append(el("p", "Read-only context recorded at launch, not the current Jira description.", "muted"));
    if (hash) details.append(el("code", `Context hash: ${hash}`));
    if (!brief) {
        details.append(el("p", "The reviewed brief is not available in this snapshot.", "muted"));
        return details;
    }
    const intent = receipt.mode || brief.intent;
    if (intent) details.append(el("p", `Mode: ${intent === "autopilot" ? "Implement" : intent === "plan" ? "Plan" : humanize(intent)}`));
    const repository = brief.repository?.repo;
    if (repository) details.append(el("p", `Repository: ${repository}`));
    details.append(el("h3", "Objective"), el("p", brief.objective ?? brief.fields?.objective ?? "Not recorded.", "description"));
    const criteria = brief.acceptanceCriteria ?? brief.fields?.acceptanceCriteria ?? [];
    details.append(el("h3", "Acceptance criteria"));
    if (Array.isArray(criteria) && criteria.length) {
        const list = el("ul");
        for (const criterion of criteria) list.append(el("li", criterion));
        details.append(list);
    } else details.append(el("p", typeof criteria === "string" && criteria ? criteria : "No acceptance criteria recorded.", "description"));
    details.append(el("h3", "Constraints"), el("p", brief.constraints ?? brief.fields?.constraints ?? "Not recorded.", "description"));
    if (brief.warnings?.length) {
        details.append(el("h3", "Warnings at review"));
        const warnings = el("ul");
        for (const warning of brief.warnings) warnings.append(el("li", warning.message));
        details.append(warnings);
    }
    if (brief.sources?.length) {
        details.append(el("h3", "Recorded references"));
        const sources = el("ul");
        for (const source of brief.sources) {
            const entry = el("li");
            const title = source.title || source.key || source.description || humanize(source.kind);
            entry.append(source.url ? link(title, source.url) : el("span", title));
            entry.append(el("small", ` ${humanize(source.role)}${source.revision ? ` / revision ${source.revision}` : ""}`, "muted"));
            sources.append(entry);
        }
        details.append(sources);
    }
    return details;
}
function renderInspector(force = false) {
    const panel = $("inspector-content"), item = getItem(ui.selected);
    const signature = JSON.stringify([ui.selected, tab, item, state.links, state.executions, state.mapping, state.requests, selecting, scopeConfirmed]);
    if (!force && (panel.contains(document.activeElement) || signature === inspectorDigest)) return;
    const focus = captureFocus(panel);
    inspectorDigest = signature;
    panel.replaceChildren();
    if (!item) {
        const empty = el("div", null, "empty");
        empty.append(jiraMark("empty-icon"), el("h3", "Follow the thread"), el("p", "Select an item to see its requirements, dependencies, sessions and pull requests."));
        panel.append(empty);
        return;
    }
    const head = el("div", null, "inspector-head");
    head.append(el("div", item.id === "project" ? `${state.site.name} / ${state.project.key}` : `${state.project.key} / ${item.parentKey || "No parent"} / ${item.key}`, "breadcrumbs"));
    const title = el("div", null, "item-meta");
    title.append(badge(item.type, item.level > 0 ? "epic" : "story"), link(item.key, itemUrl(item), "issue-key"), badge(item.status, item.category));
    const execution = executionFor(item.id), trace = nodeLinks(item.id);
    head.append(title, el("h2", item.summary), el("p", primaryReason(execution), "execution-reason"));
    head.append(el("p", freshnessSummary(state, trace, time), "inspector-freshness"));
    const tools = el("div", null, "inspector-actions");
    const primary = execution.primary;
    if (primary && primary.kind !== "prepare" && primary.kind !== "inspect") tools.append(primaryAction(item));
    tools.append(actionButton(trace.sessions.length ? "Start follow-up" : "Start session", "prepare", item.id, item.id,
        context => preparePreview(item.id, defaultMode(item, execution), context), { className: "primary", disabled: !state.mapping, success: "Session scope ready for review." }),
    link("Open in Jira", itemUrl(item), "button-link"));
    head.append(tools, feedbackFor(item.id));
    const tabs = el("div", null, "tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Work item details");
    for (const [id, label] of [["trace", "Traceability"], ["details", "Details & dependencies"]]) {
        const b = button(label, () => { tab = id; renderInspector(true); paintFeedback(); }, tab === id ? "active" : "");
        b.id = `inspector-tab-${id}`;
        b.dataset.focusKey = `tab:${id}`;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(tab === id));
        b.setAttribute("aria-controls", "inspector-panel");
        b.tabIndex = tab === id ? 0 : -1;
        b.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            tab = event.key === "Home" ? "trace" : event.key === "End" ? "details" : tab === "trace" ? "details" : "trace";
            renderInspector(true);
            $(`inspector-tab-${tab}`).focus();
            paintFeedback();
        });
        tabs.append(b);
    }
    const body = el("div", null, "inspector-body");
    body.id = "inspector-panel";
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", `inspector-tab-${tab}`);
    const evidence = executionEvidence(item, execution);
    if (evidence.length) body.append(el("h3", "More evidence"), evidenceList(evidence));
    if (tab === "details") {
        const facts = el("dl", null, "facts");
        for (const [key, value] of [["Assignee", item.assignee], ["Priority", item.priority], ["Parent", item.parentKey || "None"], ["Labels", (item.labels || []).join(", ") || "None"]]) facts.append(el("dt", key), el("dd", value));
        body.append(facts, el("h3", "Description"), el("div", item.description || "No description provided.", "description"), el("h3", "Linked dependencies"));
        if (!item.dependencies?.length) body.append(el("p", "No dependency links reported by Jira.", "muted"));
        for (const d of item.dependencies || []) {
            const line = el("p", `${d.relationship || "Linked to"} `);
            line.append(link(d.key, jiraUrl(d.key)), el("span", ` - ${d.summary} (${d.status})`));
            body.append(line);
        }
    } else renderTrace(body, item);
    panel.append(head, tabs, body);
    restoreFocus(panel, focus);
}
function traceStep(container, number, title) {
    const step = el("section", null, "trace-step");
    const heading = el("div", null, "trace-heading");
    heading.append(el("span", number, "step-number"), el("h3", title));
    step.append(heading);
    container.append(step);
    return step;
}
function renderTrace(body, item) {
    const traces = nodeLinks(item.id), bar = el("div", null, "trace-toolbar");
    bar.append(el("span", traces.verifiedAt ? `Trace checked ${time(traces.verifiedAt)}` : "Links not refreshed yet", "muted"),
        actionButton("Refresh trace", "trace", item.id, item.id, () => api("trace", { nodeId: item.id }), { refresh: true, success: "Trace refresh returned; see source freshness below." }));
    body.append(bar);
    const freshness = el("div", null, "trace-sources");
    for (const [source, label] of [["sessions", "Sessions"], ["github", "GitHub"]]) {
        const status = traces.sourceStatus?.[source];
        const observed = sourceFreshness([traces], source, time);
        const row = el("div", null, "source-status");
        const text = el("span", `${label}: ${observed.label}${observed.needed ? `; ${time(status?.fetchedAt)}` : ""}`);
        text.title = observed.detail;
        row.append(text, refreshSourceButton(`Refresh ${label}`, source, item.id));
        if (status?.error) row.append(el("p", status.error, "trace-error"));
        freshness.append(row);
    }
    body.append(freshness);
    const jira = traceStep(body, "1", item.id === "project" ? "Jira project" : "Jira work item");
    jira.append(link(`${item.key} - ${item.type}`, itemUrl(item), "trace-link"), badge(item.status, item.category), el("p", "Jira status is independent of session and PR state.", "muted"));
    const sessions = traceStep(body, "2", "Copilot sessions"), launch = nodeLaunch(item.id);
    if (!traces.sessions.length) sessions.append(el("p", launch ? `${launchLabel(launch)}; no attached session receipt yet.` : "No session linked. This is not evidence of an idle or completed session.", "muted"));
    for (const session of traces.sessions) {
        const card = el("div", null, "session-card");
        card.append(el("strong", session.name || "Linked session"), badge(sessionState(session), "session"));
        if (session.awaitingInput) {
            const waiting = disclosure(`question:${session.id}`, "Input needed in Copilot");
            waiting.append(el("p", session.awaitingInput.question || "Open the session to view the question."));
            if (session.awaitingInput.choices?.length) {
                const choices = el("ul");
                for (const choice of session.awaitingInput.choices) choices.append(el("li", choice));
                waiting.append(choices);
            }
            waiting.append(el("p", "Answer only in the native session.", "muted"));
            card.append(waiting);
        }
        if (session.awaitingPlan) card.append(el("p", "A plan is waiting for review. Open the native session to approve or reject it.", "muted"));
        if (session.interrupted) card.append(el("p", "This session was interrupted. Open it to decide what happens next.", "muted"));
        if (session.branch) card.append(el("code", session.branch));
        const identity = disclosure(`identity:${session.id}`, "Session identity");
        identity.append(el("code", session.id, "session-id"), actionButton("Copy session ID", "copy", session.id, item.id, async () => {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Select and copy the ID from Session identity.");
            await navigator.clipboard.writeText(session.id);
        }, { success: "Session ID copied." }));
        card.append(identity, openSessionButton("Open session", item.id, session.id));
        if (session.contextHash) {
            const receipt = state.requests.find(request => request.nodeId === item.id && request.contextHash === session.contextHash &&
                request.sessionId === session.id) ||
                state.requests.find(request => request.nodeId === item.id && request.contextHash === session.contextHash);
            const context = reviewedContext(receipt || { contextHash: session.contextHash }, `reviewed:${session.id}`);
            if (context) card.append(context);
        }
        sessions.append(card);
    }
    for (const receipt of state.requests.filter(request => request.nodeId === item.id &&
        (request.brief || request.contextHash) && !traces.sessions.some(session => session.id === request.sessionId))) {
        const context = reviewedContext(receipt, `receipt:${receipt.requestId}`);
        const card = el("div", null, "session-card");
        card.append(el("strong", "Launch request"), el("p", requestOutcome(receipt), "muted"));
        if (receipt.error) card.append(el("p", receipt.error, "trace-error"));
        if (context) card.append(context);
        sessions.append(card);
    }
    const attach = disclosure("attach", "Link an existing session");
    attach.classList.add("attach-existing");
    const field = el("input"), draftKey = `${state.scope}:${item.id}`;
    field.placeholder = "Copilot app session ID";
    field.setAttribute("aria-label", "Existing Copilot session ID");
    field.dataset.focusKey = `link-field:${item.id}`;
    field.value = linkDrafts.get(draftKey) || "";
    field.addEventListener("input", () => { linkDrafts.set(draftKey, field.value); });
    const attachButton = actionButton("Link session", "link", item.id, item.id, async context => {
        const sessionId = field.value.trim();
        if (!sessionId) throw new Error("Enter an existing session ID.");
        await api("link", { nodeId: item.id, sessionId });
        if (context.current()) {
            linkDrafts.delete(draftKey);
            field.value = "";
            await api("trace", { nodeId: item.id });
        }
    }, { disabled: !state.mapping, refresh: true, success: "Session link recorded and trace refreshed." });
    attach.append(field, attachButton, el("small", "Repository identity is checked before linking. This does not create a session or write to Jira.", "muted"));
    sessions.append(attach);
    const prs = traceStep(body, "3", "Pull requests & checks");
    if (!traces.prs.length) prs.append(el("p", "No PR verified from linked sessions yet.", "muted"));
    for (const pr of traces.prs) {
        const card = el("div", null, "pr-card");
        card.append(el("strong", `${pr.repo}#${pr.number}`), badge(pr.stale ? `stale / ${pr.state || "unknown"}` : pr.isDraft ? "Draft" : pr.state || "unknown", pr.state === "MERGED" ? "merged" : "pr"), el("p", pr.title),
            openPrButton("Open PR", item.id, pr.repo, pr.number));
        const details = disclosure(`pr:${pr.repo}#${pr.number}`, "Checks & source evidence"), checks = pr.statusCheckRollup || [];
        details.append(link("GitHub source", pr.url, "trace-link"), el("small", checks.length ? "Reported checks" : "Checks: not reported (not a pass)", "muted"));
        for (const check of checks) details.append(el("div", `${check.name || check.context || "Check"}: ${check.conclusion || check.state || check.status || "UNKNOWN"}`, "check-row"));
        details.append(el("small", "Evidence: recorded by the linked Copilot session; verified on GitHub.", "muted"));
        card.append(details);
        prs.append(card);
    }
    for (const message of traces.errors || []) body.append(el("p", message, "trace-error"));
    const children = (item.id === "project" ? state.issues : descendants(state.issues, item.id)).filter(child => nodeLinks(child.id).sessions.length || nodeLinks(child.id).prs.length);
    if (children.length) {
        const rollup = el("section", null, "child-traces");
        rollup.append(el("h3", "Linked work in this scope"), el("p", "Child traces stay attached to their original Jira items.", "muted"));
        for (const child of children) {
            const trace = nodeLinks(child.id);
            rollup.append(button(`${child.key} - ${trace.sessions.length} session(s), ${trace.prs.length} PR(s)`, () => chooseItem(child.id)));
        }
        body.append(rollup);
    }
}

function validatePreview(value) {
    if (!value?.id || !value.node?.id || typeof value.brief?.hash !== "string" || !value.brief.hash ||
        !["plan", "autopilot"].includes(value.mode) || !Array.isArray(value.brief.warnings) || !Array.isArray(value.brief.sources) || !value.brief.fields) {
        throw new Error("The server did not return a reviewed launch brief and context hash. Start is unavailable.");
    }
    if (value.brief.warnings.some(warning => typeof warning.id !== "string" || !warning.id)) throw new Error("Launch warnings are missing acknowledgement IDs. Review cannot be confirmed.");
    return value;
}
async function preparePreview(nodeId, mode, context) {
    const version = ++previewVersion;
    const result = validatePreview(await api("prepare", { nodeId, mode }));
    if (!context.current() || version !== previewVersion) return;
    previewScope = context.scope;
    setReviewedPreview(result);
    if (!$("launch-dialog").open) $("launch-dialog").showModal();
}
function setReviewedPreview(value) {
    preview = value;
    previewDirty = false;
    const brief = preview.brief, fields = brief.fields;
    $("launch-mode").value = preview.mode;
    $("launch-objective").value = fields.objective ?? brief.objective ?? "";
    const criteria = fields.acceptanceCriteria ?? brief.acceptanceCriteria ?? [];
    $("launch-criteria").value = Array.isArray(criteria) ? criteria.join("\n") : criteria;
    $("launch-constraints").value = fields.constraints ?? brief.constraints ?? "";
    $("launch-warning-ack").checked = false;
    $("launch-error").hidden = true;
    $("launch-error").textContent = "";
    const children = preview.children || [], existing = preview.existing || [];
    $("launch-preview").replaceChildren(el("h3", `${preview.node.key} - ${preview.node.summary}`), el("p", `Repository: ${preview.mapping?.repo || brief.repository?.repo || "Not reported"}`), el("p", `${children.length} descendant items included as context, not separate launches.`));
    if (existing.length) $("launch-preview").append(el("p", `${existing.length} session(s) already linked. This creates one follow-up, not a replacement.`, "muted"));
    if (children.length) {
        const list = el("ul");
        for (const child of children.slice(0, 12)) list.append(el("li", `${child.key} - ${child.summary}`));
        if (children.length > 12) list.append(el("li", `And ${children.length - 12} more...`));
        $("launch-preview").append(list);
    }
    $("launch-source-list").replaceChildren();
    for (const source of brief.sources) {
        const block = el("div", null, "launch-source");
        const title = source.key || source.description || humanize(source.kind);
        block.append(source.url ? link(title, source.url) : el("strong", title));
        block.append(el("p", `${humanize(source.kind)} / ${humanize(source.role)}${source.key ? ` / ${source.key}` : ""}`, "muted"));
        if (source.description) block.append(el("p", source.description));
        if (source.revision) block.append(el("code", `Revision: ${source.revision}`));
        $("launch-source-list").append(block);
    }
    if (!brief.sources.length) $("launch-source-list").append(el("p", "No source references were returned.", "muted"));
    $("launch-warnings").replaceChildren();
    if (brief.warnings.length) {
        $("launch-warnings").append(el("h3", "Review warnings"));
        const warnings = el("ul");
        for (const warning of brief.warnings) warnings.append(el("li", warning.message));
        $("launch-warnings").append(warnings, el("p", "Plan remains available. Implement requires acknowledgement of every warning.", "muted"));
    }
    $("launch-warnings").hidden = !brief.warnings.length;
    updateLaunchControls();
}
function markPreviewDirty() {
    if (!preview) return;
    formRevision++;
    previewDirty = true;
    $("launch-warning-ack").checked = false;
    $("launch-error").hidden = true;
    updateLaunchControls();
}
function updateLaunchControls() {
    const warnings = preview?.brief.warnings || [], implement = $("launch-mode").value === "autopilot";
    const pending = preview && nodePending(preview.node.id);
    $("launch-ack-label").hidden = !implement || !warnings.length;
    $("launch-warning-ack").disabled = previewDirty || reviewing || launching;
    $("review-changes").disabled = !preview || !previewDirty || reviewing || launching || pending || !scopeConfirmed || selecting;
    $("confirm-launch").textContent = launching ? "Submitting..." : implement ? "Start Implement session" : "Start Plan session";
    $("confirm-launch").disabled = !preview || previewDirty || reviewing || launching || pending || !scopeConfirmed || selecting || previewScope !== state.scope ||
        submittedPreviews.has(preview.id) || (implement && warnings.length > 0 && !$("launch-warning-ack").checked);
    for (const id of ["launch-mode", "launch-objective", "launch-criteria", "launch-constraints"]) $(id).disabled = launching;
    $("cancel-launch").textContent = launching ? "Close" : "Cancel";
    $("launch-status").textContent = reviewing ? "Reviewing the edited context..." : previewDirty ? "Changes are not reviewed. Choose Review changes before starting." :
        preview ? `Reviewed ${implement ? "implementation" : "planning"} context. One session will be queued after confirmation.` : "";
}
async function reviewChanges() {
    if (!preview || reviewing || launching || !previewDirty || previewScope !== state.scope) return;
    const currentPreview = preview, scope = previewScope, revision = formRevision, version = previewVersion;
    const fields = { objective: $("launch-objective").value, acceptanceCriteria: $("launch-criteria").value, constraints: $("launch-constraints").value };
    const mode = $("launch-mode").value;
    reviewing = true;
    $("launch-error").hidden = true;
    updateLaunchControls();
    try {
        const result = validatePreview(await api("prepare", { nodeId: currentPreview.node.id, mode, fields }));
        if (scope !== state.scope || version !== previewVersion || !preview) return;
        if (revision === formRevision) setReviewedPreview(result);
        else {
            $("launch-error").textContent = "The fields changed during review. Review the latest changes before starting.";
            $("launch-error").hidden = false;
        }
    } catch (error) {
        if (scope === state.scope && version === previewVersion) {
            $("launch-error").textContent = `Review failed: ${error.message}`;
            $("launch-error").hidden = false;
        }
    } finally {
        if (version === previewVersion) { reviewing = false; updateLaunchControls(); }
    }
}
function closePreview() {
    previewVersion++;
    preview = null;
    previewScope = null;
    previewDirty = false;
    reviewing = false;
    launching = false;
    for (const id of ["launch-objective", "launch-criteria", "launch-constraints"]) $(id).value = "";
    $("launch-warning-ack").checked = false;
    $("launch-sources").open = false;
    if ($("launch-dialog").open) $("launch-dialog").close();
    updateLaunchControls();
}
async function confirmLaunch() {
    if ($("confirm-launch").disabled || !preview) return;
    const reviewed = preview, scope = previewScope;
    const acknowledgedWarnings = $("launch-mode").value === "autopilot" && $("launch-warning-ack").checked ? reviewed.brief.warnings.map(w => w.id) : [];
    submittedPreviews.add(reviewed.id);
    launching = true;
    updateLaunchControls();
    await perform({
        kind: "launch", target: reviewed.node.id, nodeId: reviewed.node.id, previewId: reviewed.id, label: `Start session for ${reviewed.node.key}`, refresh: true,
        work: async () => {
            const receipt = await api("launch", { previewId: reviewed.id, contextHash: reviewed.brief.hash, acknowledgedWarnings });
            if (!receipt.requestId || receipt.status !== "queued") throw new Error("Launch did not return a queued receipt; inspect live state before trying again.");
            if (preview?.id === reviewed.id && previewScope === scope) closePreview();
            return receipt;
        },
    });
    if (preview?.id === reviewed.id) { launching = false; updateLaunchControls(); }
}

function selectProject(cloudId, jiraProjectId) {
    if (!cloudId) return;
    const version = ++selectionVersion;
    rememberPreferences();
    cancelPreferenceSave();
    closePreview();
    scopeEpoch++;
    selecting = true;
    scopeConfirmed = false;
    connectionMessage("selection", "Loading selected project...");
    render();
    selectionChain = selectionChain.then(async () => {
        if (version !== selectionVersion) return;
        try {
            if (!jiraProjectId) {
                const projects = await api("projects", { cloudId });
                if (version !== selectionVersion) return;
                if (!projects.length) throw new Error("No browseable Jira projects were returned for this site.");
                selectOptions($("project"), projects.map(p => ({ value: p.id, label: `${p.key} - ${p.name}` })), projects[0].id, "Select Jira project", true);
                jiraProjectId = projects[0].id;
            }
            const snapshot = await api("select", { cloudId, jiraProjectId });
            if (version !== selectionVersion) return;
            selecting = false;
            acceptSnapshot(snapshot, { allowScopeChange: true });
            savePreferences();
            connectionMessage("selection", "");
        } catch (error) {
            if (version !== selectionVersion) return;
            connectionMessage("selection", `Project selection failed: ${error.message}`);
            try {
                const snapshot = await api("state");
                if (version !== selectionVersion) return;
                selecting = false;
                acceptSnapshot(snapshot, { allowScopeChange: true });
            } catch (syncError) {
                if (version === selectionVersion) connectionMessage("selection", `Project selection failed: ${error.message}. Could not confirm the current project: ${syncError.message}. Select a project to reconnect.`);
            }
        } finally {
            if (version === selectionVersion) {
                selecting = false;
                $("project").disabled = false;
                if (scopeConfirmed) {
                    selectOptions($("site"), state.sites.map(site => ({ value: site.id, label: site.name })), state.site?.id, "Select Jira site", true);
                    selectOptions($("project"), state.projects.map(project => ({ value: project.id, label: `${project.key} - ${project.name}` })), state.project?.id, "Select Jira project", true);
                }
                render();
            }
        }
    });
}

$("search").addEventListener("input", () => { ui.query = $("search").value; savePreferences("query"); renderExecutionFilters(); renderTree(true); paintFeedback(); });
$("status-filter").addEventListener("change", () => { ui.category = $("status-filter").value; savePreferences("category"); renderExecutionFilters(); renderTree(true); paintFeedback(); });
$("expand").addEventListener("click", () => { collapsed.clear(); savePreferences("collapsed"); renderTree(true); paintFeedback(); });
for (const view of ["execution", "hierarchy"]) $(`view-${view}`).addEventListener("click", () => {
    ui.view = view;
    savePreferences("view");
    render({ force: true });
});
$("work-scroll").addEventListener("scroll", () => {
    if (ui.detailsOpen && matchMedia("(max-width: 1000px)").matches) return;
    if (Math.abs(ui.scrollTop - $("work-scroll").scrollTop) < 1) return;
    ui.scrollTop = $("work-scroll").scrollTop;
    rememberPreferences();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
        if (Math.abs(ui.scrollTop - savedScrollTop) >= 1) queuePreferenceSave(["scrollTop"], 0);
    }, SCROLL_SAVE_MS);
}, { passive: true });
$("show-details").addEventListener("click", () => { ui.detailsOpen = true; savePreferences("detailsOpen"); render(); $("back-to-work").focus({ preventScroll: true }); });
$("back-to-work").addEventListener("click", () => {
    ui.detailsOpen = false;
    savePreferences("detailsOpen");
    render();
    $("work-scroll").scrollTop = ui.scrollTop;
    if (!focusRow(ui.selected) && !focusRow(focusedNode)) $("search").focus({ preventScroll: true });
});
$("project-start").addEventListener("click", () => void perform({
    kind: "prepare", target: "project", nodeId: "project", label: "Prepare project session",
    work: context => preparePreview("project", defaultMode(getItem("project"), executionFor("project")), context), success: "Project scope ready for review.",
}));
$("project-title").addEventListener("click", () => chooseItem("project"));
$("sync-jira").addEventListener("click", () => {
    if ($("sync-jira").disabled || !state.project || !state.mapping) return;
    $("sync-project").textContent = `${state.project.key} - ${state.project.name}`;
    $("sync-repo").textContent = state.mapping.repo || state.mapping.name;
    $("sync-dialog").showModal();
});
$("cancel-sync").addEventListener("click", () => $("sync-dialog").close());
$("confirm-sync").addEventListener("click", () => {
    $("sync-dialog").close();
    void perform({
        kind: "launch", target: "project", nodeId: "project", label: "Update Jira", refresh: true,
        work: () => api("sync-jira", {}),
    });
});
$("refresh").addEventListener("click", () => void perform({
    kind: "refresh-jira", target: "jira", label: "Refresh workbench", refresh: true,
    work: async context => {
        await api("refresh", {});
        await refreshExecution("all", context.epoch, true);
    },
    success: "Jira and live refresh returned; see each source's own freshness.",
}));
$("refresh-execution").addEventListener("click", () => void perform({
    kind: "refresh-execution", target: "all", label: "Refresh live state", work: context => refreshExecution("all", context.epoch), refresh: true,
    success: "Live refresh returned; see source freshness for any retained or unknown data.",
}));
$("connections").addEventListener("click", () => void perform({
    kind: "catalog", target: "connections", label: "Reload connections", global: true, work: () => api("catalog", {}), refresh: true,
    success: "Connection catalog reloaded.",
}));
$("site").addEventListener("change", () => {
    if (!$("site").value) return;
    $("project").disabled = true;
    selectProject($("site").value);
});
$("project").addEventListener("change", () => { if ($("project").value) selectProject($("site").value, $("project").value); });
$("repository").addEventListener("change", () => {
    const copilotProjectId = $("repository").value;
    if (!copilotProjectId) return;
    closePreview();
    void perform({ kind: "map", target: "repository", label: "Map repository", work: () => api("map", { copilotProjectId }), refresh: true, success: "Repository mapping saved." });
});
for (const id of ["launch-objective", "launch-criteria", "launch-constraints"]) $(id).addEventListener("input", markPreviewDirty);
$("launch-mode").addEventListener("change", markPreviewDirty);
$("launch-warning-ack").addEventListener("change", updateLaunchControls);
$("review-changes").addEventListener("click", () => void reviewChanges());
$("cancel-launch").addEventListener("click", closePreview);
$("launch-dialog").addEventListener("cancel", event => { event.preventDefault(); closePreview(); });
$("confirm-launch").addEventListener("click", () => void confirmLaunch());
for (const id of ["tree", "inspector-content"]) $(id).addEventListener("focusout", () => setTimeout(() => {
    if ($(id).contains(document.activeElement)) return;
    if (id === "tree") renderTree(); else renderInspector();
    paintFeedback();
}, 0));
function pollingPaused() {
    return document.hidden || selecting || $("launch-dialog").open || $("sync-dialog").open || reviewing || launching ||
        [...actions.values()].some(action => action.scope === state.scope && action.status === "pending" &&
            ["prepare", "launch", "trace", "refresh-jira", "refresh-execution"].includes(action.kind));
}
let lastSessionPoll = 0;
async function poll() {
    if (pollPending || pollingPaused()) return;
    pollPending = true;
    const epoch = scopeEpoch;
    try {
        if (state.project && scopeConfirmed && !state.warming && !state.refreshing && Date.now() - lastSessionPoll >= 4500) {
            lastSessionPoll = Date.now();
            await refreshExecution("sessions", epoch);
        }
        if (epoch !== scopeEpoch || pollingPaused()) return;
        await sync(epoch);
        warmingMessage();
        if (epoch === scopeEpoch) connectionMessage("poll", "");
    } catch (error) {
        if (epoch === scopeEpoch) connectionMessage("poll", `Automatic session refresh failed: ${error.message}. Last observed state is retained; GitHub freshness has not been refreshed.`);
    } finally {
        pollPending = false;
    }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
function warmingMessage() {
    connectionMessage("warming", state.warming && !signInNeeded(state) ? state.project
        ? state.issues.length ? `Showing ${state.cached ? "the cached" : "the last"} ${state.project.key} snapshot while Jira and Copilot reconnect...`
            : `Loading ${state.project.key} from Jira...`
        : "Connecting to Jira and Copilot..." : "");
}
$("sign-in-button").addEventListener("click", async () => {
    const button = $("sign-in-button"), status = $("sign-in-status");
    button.disabled = true;
    status.hidden = false;
    status.textContent = "Starting Atlassian sign-in...";
    try {
        const result = await api("sign-in", {});
        if (result.signedIn) status.textContent = "Already signed in; reloading Jira...";
        else {
            status.replaceChildren(document.createTextNode(result.opened
                ? "Finish signing in in your browser, then come back here. If no browser window opened, use "
                : "Open this link to finish signing in, then come back here: "));
            const link = el("a", result.opened ? "this link" : "Atlassian sign-in");
            link.href = result.authorizationUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            status.append(link, document.createTextNode("."));
        }
        await sync();
    } catch (error) {
        status.textContent = `Could not start sign-in: ${error.message}`;
    } finally {
        button.disabled = false;
    }
});
render();
// The server re-checks for updates every few minutes; reading its cached answer is cheap.
const ACTION_LABELS = { update: "Update & reload", reload: "Reload" };
let updating = false;
function showBuild(build) {
    if (build.state !== "updating" && build.state !== "reloading") updating = false;
    $("build-version").textContent = `Jira Workbench ${build.label}`;
    const banner = $("update-banner"), button = $("update-action");
    banner.hidden = !build.message;
    $("update-message").textContent = build.message || "";
    button.hidden = !ACTION_LABELS[build.action];
    button.textContent = ACTION_LABELS[build.action] || "";
    button.disabled = updating;
}
const checkBuild = () => api("version").then(showBuild).catch(() => {});
$("update-action").addEventListener("click", async () => {
    updating = true;
    $("update-action").disabled = true;
    try { showBuild(await api("update", {})); }
    catch (error) {
        updating = false;
        await checkBuild();
        if ($("update-banner").hidden) { $("update-banner").hidden = false; $("update-message").textContent = error.message; }
    }
});
void checkBuild();
setInterval(() => void checkBuild(), 60_000);
// The server restores the last project from disk and revalidates it; show that first, then follow it.
try { await sync(); }
catch (error) { connectionMessage("poll", `Could not read the workbench state: ${error.message}`); }
warmingMessage();
for (let attempt = 0; attempt < 160 && (state.warming || state.refreshing); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 750));
    try { await sync(); } catch { break; }
    warmingMessage();
}
warmingMessage();
// Poll every second while reconnecting so a recovery shows at once; relax to 5s when everything is healthy.
// Decided each tick, because a failure can arrive through an action response between polls.
let lastPoll = 0;
setInterval(() => {
    const reconnecting = state.catalogErrors.length || state.error || state.warming || state.retryAt;
    if (!reconnecting && Date.now() - lastPoll < 5000) return;
    lastPoll = Date.now();
    void poll();
}, 1000);

import { scopeKey, descendants, childIndex, progressRollup, freshnessTone, jiraFreshness, buildTree } from "/model.mjs";
import {
    humanize, sourceFreshness, sourceHint, freshnessSummary, sessionState, sessionsBadge, sessionExists, launchState, launchBlocks, launchLabel, requestOutcome,
    receiptMessage, launchUpdate, launchReceipt, launchRejection, primaryReason, executionEvidence, matches, filterTree, descendantSessionCounts, defaultMode,
    signInNeeded, standaloneHost, banner, statusFilterGroups, sprintOptions, appliedSprint, smartCommitOption, workingSetSummary, scopeLabel,
    retryNotice, nextFocusKey, resolveSnapshot, linksDigest, minuteKey, requestStatuses, indexExecutions, executionFor as indexedExecution,
    flattenTree, timeLabel, serverLost, pollDelayMs, SERVER_LOST_MESSAGE, WORK_VIEWS, workView, kanbanBoard, emptyWorkMessage,
} from "/view-model.mjs";

const $ = id => document.getElementById(id);
const jiraMark = className => {
    const mark = document.querySelector(".brand-icon").cloneNode(true);
    mark.setAttribute("class", className);
    return mark;
};
const token = location.hash.slice(1);
const filters = [["needs-me", "Needs me"], ["running", "Running"], ["prs", "PRs to review"], ["available", "Available to start"], ["all", "All work"]];
const defaults = () => ({ view: workView(), executionFilter: "all", selected: null, collapsed: [], query: "", category: "all", sprint: "all", scrollTop: 0, detailsOpen: false });
let state = { sites: [], projects: [], appProjects: [], issues: [], links: {}, requests: [], executions: [], navigationReceipts: [], tree: { roots: [], warnings: [] }, catalogErrors: [] };
// Indexes rebuilt once per snapshot: issues by ID, executions by node, and (on first use) children by parent.
let itemsById = new Map(), itemsSource = null, issueChildren = null, executionsById = new Map();
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
const noticeRows = new Map();
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
// One formatter per label width: toLocaleTimeString with options builds a new one on each call. Minute labels are also
// memoized, because a render formats thousands of stamps that share a minute.
const clock = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const secondClock = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const minuteLabels = new Map();
const time = value => timeLabel(value, date => {
    const minute = Math.floor(date.getTime() / 60_000);
    if (!minuteLabels.has(minute)) {
        if (minuteLabels.size > 2000) minuteLabels.clear();
        minuteLabels.set(minute, clock.format(date));
    }
    return minuteLabels.get(minute);
});
const clockTime = value => timeLabel(value, date => secondClock.format(date));
// A control that becomes unavailable while it has focus keeps the focus: it is marked aria-disabled instead of
// disabled (a disabled element drops focus to the page), and the click guard below ignores it.
function setInert(control, inert) {
    const keep = inert && document.activeElement === control;
    if (control.disabled !== (inert && !keep)) control.disabled = inert && !keep;
    if (keep && control.getAttribute("aria-disabled") !== "true") control.setAttribute("aria-disabled", "true");
    else if (!keep && control.hasAttribute("aria-disabled")) control.removeAttribute("aria-disabled");
}
// Writes only a value that differs: a same-value write still replaces a text node or records an attribute change.
function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
}
function setHidden(element, hidden) {
    if (element.hidden !== hidden) element.hidden = hidden;
}
function setAttr(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
function setData(element, key, value) {
    if (element.dataset[key] !== value) element.dataset[key] = value;
}
const inert = control => control.disabled || control.getAttribute("aria-disabled") === "true";
// For focus moved to a different place (not restored in place after a rebuild): scroll only as far as needed, in
// every scrolling ancestor, so the focus indicator is visible.
function focusInView(element) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
}
const actionKey = (kind, target, scope = state.scope) => JSON.stringify([scope || "", kind, target]);
const jiraUrl = key => `${state.site.url}/browse/${encodeURIComponent(key)}`;
const itemUrl = item => item.id === "project" ? `${state.site.url}/jira/software/projects/${encodeURIComponent(state.project.key)}/summary` : jiraUrl(item.key);
// Memoized per snapshot (the state object is replaced, never changed in place): a render reads every issue's trace
// several times. Callers must not change the result.
let linksState = null, linksCache = new Map();
function nodeLinks(id) {
    if (linksState !== state) { linksState = state; linksCache = new Map(); }
    if (linksCache.has(id)) return linksCache.get(id);
    let result;
    if (foreignContext(getItem(id))) result = { sessions: [], prs: [] };
    else {
        const trace = state.site && state.project ? state.links[scopeKey(state.site.id, state.project.id, id)] : null;
        result = { sessions: [], prs: [], ...trace };
    }
    linksCache.set(id, result);
    return result;
}
// Traces belong to the selected project's own issues; anything else (including unknown project) is foreign context.
const foreignContext = item => Boolean(item && item.id !== "project" && item.projectId !== state.project?.id);
function setSource(element, text, tone, detail) {
    setText(element, text);
    setData(element, "tone", tone);
    setData(element, "detail", detail);
    setAttr(element, "aria-label", detail ? `${text}. ${detail}` : text);
}
// Requests grouped by node once per snapshot: launchState keeps only the node's own requests, so it gets just those.
let requestsState = null, requestsByNode = new Map();
function nodeRequests(id) {
    if (requestsState !== state) {
        requestsState = state;
        requestsByNode = new Map();
        for (const request of state.requests) requestsByNode.set(request.nodeId, [...requestsByNode.get(request.nodeId) || [], request]);
    }
    return requestsByNode.get(id) || [];
}
const nodeLaunch = id => launchState({ local: actions.get(actionKey("launch", id)), requests: nodeRequests(id), nodeId: id });
const nodePending = id => launchBlocks(nodeLaunch(id));
function getItem(id) {
    if (id !== "project") return itemsById.get(id);
    if (!state.project) return null;
    return {
        id: "project", key: state.project.key, summary: state.project.name, type: "Project", level: 2,
        status: "Project scope", category: "unknown", labels: [], dependencies: [],
        assignee: "Not applicable", priority: "Not applicable",
        description: "Project coordination scope. Child issues keep their own Jira statuses, sessions and pull requests.",
    };
}
// The server bounds its prompt send at 30s; this bounds the whole launch or Update Jira call, so a hung request
// cannot keep the panel waiting (and polling paused) forever.
const LAUNCH_TIMEOUT_MS = 45_000;
let serverFailures = 0;
// Counts requests that reached no server at all; an error response still proves the server is there.
function noteServer(reached) {
    const was = serverLost(serverFailures);
    serverFailures = reached ? 0 : serverFailures + 1;
    const lost = serverLost(serverFailures);
    if (lost === was) return;
    connectionMessage("server", lost ? SERVER_LOST_MESSAGE : "");
    // The per-request failures ("Load failed") say nothing more once the cause is named.
    if (lost) connectionMessage("poll", "");
}
async function api(path, input, signal) {
    const response = await fetch(`/api/${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "x-workbench-token": token, "Content-Type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        ...(signal ? { signal } : {}),
    }).catch(error => {
        if (error?.name === "TimeoutError") throw new Error(`Jira Workbench did not answer within ${Math.round(LAUNCH_TIMEOUT_MS / 1000)}s`);
        if (error?.name !== "AbortError") noteServer(false);
        throw error;
    });
    noteServer(true);
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || `Request failed (${response.status})`);
        error.httpStatus = response.status;
        if (typeof result.requestId === "string") error.requestId = result.requestId;
        throw error;
    }
    return result;
}
async function loadMoreAction(context) {
    const version = ++snapshotVersion;
    const snapshot = await api("load-more", {});
    if (!context.current()) return { status: "superseded" };
    // A read started after this one (an action's refresh) owns the panel; read again so the page still shows.
    if (version === snapshotVersion) acceptSnapshot(snapshot);
    else await sync(context.epoch);
    // The server reports what this request did, even if a later refresh has since replaced the working set.
    if (snapshot.pageResult?.status === "superseded") return { status: "superseded" };
    if (snapshot.pageResult?.error) throw new Error(snapshot.pageResult.error);
    return snapshot;
}
// poll: the background session poll. It may share an explicit refresh, but an explicit refresh never shares a poll,
// because a poll skips sessions confirmed missing.
function refreshExecution(source = "all", epoch = scopeEpoch, afterCurrent = false, poll = false) {
    const key = poll ? `${epoch}:poll` : `${epoch}:${source}`;
    const existing = executionRefreshes.get(`${epoch}:all`) || executionRefreshes.get(key) || (poll && executionRefreshes.get(`${epoch}:${source}`));
    if (existing && !afterCurrent) return existing;
    const preceding = source === "all" ? ["all", "sessions", "github", "poll"].map(name => executionRefreshes.get(`${epoch}:${name}`)).filter(Boolean) : [];
    // Earlier callers report their failures; an explicit refresh still gets its own attempt.
    const pending = Promise.allSettled(preceding).then(() => {
        if (epoch !== scopeEpoch || selecting || !scopeConfirmed) throw new Error("Project selection changed before the live refresh could run.");
        return api("refresh-execution", { source, ...(poll ? { poll } : {}), ...(state.issuesRevision ? { since: state.issuesRevision } : {}) });
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
        view: workView(value.view),
        executionFilter: filters.some(([id]) => id === value.executionFilter) ? value.executionFilter : "all",
        selected: typeof value.selected === "string" ? value.selected : null,
        collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter(id => typeof id === "string") : [],
        query: typeof value.query === "string" ? value.query : "",
        category: ["all", "new", "indeterminate", "done"].includes(value.category)
            || typeof value.category === "string" && value.category.startsWith("status:") && value.category.length > 7 && value.category.length <= 207 ? value.category : "all",
        sprint: typeof value.sprint === "string" && /^(?:all|none|sprint:.{1,100})$/s.test(value.sprint) ? value.sprint : "all",
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
    const changedWorkingSet = state.workingSetKey && snapshot.workingSetKey !== state.workingSetKey;
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
    if (changedWorkingSet && !changedScope) {
        closePreview();
        ui.selected = null;
        collapsed.clear();
        treeDigest = inspectorDigest = "";
    }
    if (preview && state.mapping?.id !== snapshot.mapping?.id) markPreviewDirty();
    // The tree is derived from the working set, so it is rebuilt only when the working set is replaced.
    const tree = snapshot.issues === state.issues ? state.tree : buildTree(snapshot.issues);
    state = { ...snapshot, tree, executions: snapshot.executions || [], navigationReceipts: snapshot.navigationReceipts || [] };
    if (snapshot.issues !== itemsSource) { itemsSource = snapshot.issues; itemsById = new Map(state.issues.map(issue => [issue.id, issue])); issueChildren = null; }
    executionsById = indexExecutions(state.executions);
    reconcileReceipts();
    render({ force: changedScope });
    updateLaunchControls();
    if (changedScope && (localPreferences.has(state.scope) || hasInitialEdits)) savePreferences();
    return true;
}
// Applies a snapshot that may leave out the working set (`issues: null` for the revision this panel holds).
// False when this panel does not hold that revision: the caller must read the full snapshot instead.
function applySnapshot(snapshot, options) {
    const resolved = resolveSnapshot(snapshot, state);
    if (!resolved) return false;
    acceptSnapshot(resolved, options);
    return true;
}
async function sync(epoch = scopeEpoch, full = false) {
    const version = ++snapshotVersion;
    const since = full ? null : state.issuesRevision;
    const snapshot = await api(since ? `state?since=${encodeURIComponent(since)}` : "state");
    if (epoch !== scopeEpoch || version !== snapshotVersion || selecting) return;
    if (applySnapshot(snapshot)) return;
    if (full) throw new Error("The workbench returned an invalid snapshot.");
    await sync(epoch, true);
}

function configureActionControl(control, kind, target, disabled = false, scope = state.scope) {
    setData(control, "actionKey", actionKey(kind, target, scope));
    if (!control.dataset.baseLabel) control.dataset.baseLabel = control.textContent;
    setData(control, "baseDisabled", String(disabled));
    setData(control, "focusKey", `${kind}:${target}`);
    setData(control, "prepareNode", kind === "prepare" ? target : "");
    setData(control, "projectAction", String(scope !== null));
    updateActionControl(control);
    return control;
}
function updateActionControl(control) {
    const action = actions.get(control.dataset.actionKey);
    const pending = action && ["pending", "queued", "uncertain"].includes(action.status);
    const launchPending = control.dataset.prepareNode && nodePending(control.dataset.prepareNode);
    const off = control.dataset.baseDisabled === "true" || Boolean(pending) || Boolean(launchPending) ||
        (control.dataset.projectAction === "true" && (selecting || !scopeConfirmed || standaloneHost(state)));
    // A freshness chip keeps its own label and stays focusable, so its details remain readable while it is unavailable.
    if (control.classList.contains("source")) {
        if (off) setAttr(control, "aria-disabled", "true");
        else control.removeAttribute("aria-disabled");
    } else {
        setInert(control, off);
        setText(control, pending ? action.status === "pending" ? "Working..." : action.status === "queued" ? "Queued" : "Check receipt" : control.dataset.baseLabel);
    }
    setAttr(control, "aria-busy", String(action?.status === "pending"));
}
function actionButton(text, kind, target, nodeId, work, options = {}) {
    const b = button(text, () => void perform({ kind, target, nodeId, label: text, work, ...options }), options.className);
    b.dataset.focusKey = `action:${kind}:${target}`;
    return configureActionControl(b, kind, target, options.disabled);
}
async function perform({ kind, target, nodeId, label, work, success, refresh = false, global = false, previewId, clientId }) {
    const scope = global ? null : state.scope, epoch = scopeEpoch;
    const key = actionKey(kind, target, scope), previous = actions.get(key);
    if (previous && ["pending", "queued", "uncertain"].includes(previous.status)) return;
    if ((selecting || !scopeConfirmed || standaloneHost(state)) && !global) return;
    if (kind === "prepare" && nodePending(nodeId)) return;
    // The list row the control sits in, if any: action keys repeat across rows, so focus is put back within that row.
    const originRowId = $("tree").contains(document.activeElement) ? document.activeElement.closest("[data-node-id]")?.dataset.nodeId : undefined;
    const record = { kind, scope, nodeId, previewId, clientId, originRowId, status: "pending", message: `${label}...`, dismissed: false };
    const restoreControlFocus = document.activeElement?.dataset.actionKey === key;
    actions.set(key, record);
    paintFeedback();
    try {
        const result = await work({ scope, epoch, current: () => scope === state.scope && epoch === scopeEpoch && !selecting && scopeConfirmed });
        if (result?.status === "superseded") {
            record.status = "superseded";
            record.message = `${label} was superseded; no page was installed by this action.`;
        } else if (result?.requestId) {
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
                connectionMessage("poll", `Action returned, but the local snapshot could not be read: ${error.message}. Click Refresh to reconcile.`);
            }
        }
    } catch (error) {
        const uncertain = kind === "launch" && (!error.httpStatus || error.httpStatus >= 500);
        if (error.requestId) record.requestId = error.requestId;
        record.status = uncertain ? "uncertain" : "failed";
        record.message = uncertain
            ? `Launch outcome unknown: ${error.message}. No retry was sent. Click Refresh and inspect the launch receipt before starting again.`
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
        // The control normally keeps focus (see setInert); if it was hidden or replaced, focus its row instead.
        if (restoreControlFocus && (global || scope === state.scope) && epoch === scopeEpoch && !selecting
            && (document.activeElement === document.body || document.activeElement?.disabled)) {
            if (kind === "load-more") renderTree();
            const control = actionControl(key, originRowId, element => !element.disabled && !element.hidden);
            if (control) control.focus({ preventScroll: true });
            else if (!focusRow(originRowId ?? nodeId) && !focusRow(focusedNode)) $("search").focus({ preventScroll: true });
        }
    }
}
// The control that runs an action: inside the list row it was started from when there is one (keys repeat across
// rows), otherwise the first one in the page.
function actionControl(key, rowId, usable) {
    const scope = rowId === undefined ? document : visibleRows.get(rowId);
    if (!scope?.isConnected) return null;
    return [...scope.querySelectorAll("[data-action-key]")].find(element => element.dataset.actionKey === key && usable(element)) || null;
}
function reconcileReceipts() {
    for (const record of actions.values()) {
        // An expired launch stays open to a late receipt, which still attaches its session.
        if (record.scope !== state.scope || !["pending", "queued", "uncertain", "expired"].includes(record.status)) continue;
        if (record.kind === "launch") {
            const receipt = launchReceipt(record, state.requests);
            if (!receipt) {
                const rejected = launchRejection(record, state.syncRejections);
                if (rejected) Object.assign(record, rejected);
                continue;
            }
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
    const repositoryDisabled = selecting || !scopeConfirmed || !state.project || !state.appProjects.length || actions.get(actionKey("map", "repository"))?.status === "pending";
    if ($("repository").disabled !== repositoryDisabled) $("repository").disabled = repositoryDisabled;
    const entries = [...actions].filter(([, a]) => (a.scope === null || a.scope === state.scope) && !a.dismissed);
    const visible = entries.map(([, record]) => record);
    paintNotices(entries);
    setHidden($("notice"), !visible.length);
    // Each node's messages, gathered once rather than filtered again for every feedback node.
    const messages = new Map();
    for (const record of visible) messages.set(record.nodeId, [...messages.get(record.nodeId) || [], record.message]);
    for (const feedback of document.querySelectorAll("[data-feedback-node]")) {
        const text = (messages.get(feedback.dataset.feedbackNode) || []).join(" ");
        setText(feedback, text);
        setHidden(feedback, !text);
    }
}
// #notice is a polite live region that announces additions and text changes. Each action keeps its own row, so a new
// action adds one row, a status change rewrites only that row's text, and nothing already heard is announced again.
function paintNotices(entries) {
    const keys = new Set(entries.map(([key]) => key));
    for (const [key, row] of noticeRows) if (!keys.has(key)) { row.remove(); noticeRows.delete(key); }
    for (const [key, record] of entries) {
        let row = noticeRows.get(key);
        if (!row) {
            row = el("div", null, "action-notice");
            row.append(el("span"), button("Dismiss", () => dismissNotice(key)));
            noticeRows.set(key, row);
            $("notice").append(row);
        }
        const [message, dismiss] = row.children;
        row.classList.toggle("notice-error", ["failed", "uncertain", "expired"].includes(record.status));
        if (message.textContent !== record.message) message.textContent = record.message;
        setHidden(dismiss, ["pending", "queued", "uncertain"].includes(record.status));
        setAttr(dismiss, "aria-label", `Dismiss: ${record.message}`);
    }
}
function dismissNotice(key) {
    const record = actions.get(key);
    if (!record) return;
    const hadFocus = noticeRows.get(key)?.contains(document.activeElement);
    const dismissible = [...noticeRows].filter(([, row]) => !row.lastElementChild.hidden).map(([rowKey]) => rowKey);
    const next = nextFocusKey(dismissible, key);
    record.dismissed = true;
    paintFeedback();
    if (!hadFocus) return;
    // Dismiss removes its own button: move focus to the next notice, else to the control that ran the action. Only
    // rendered elements count: the narrow details view hides the list (and search) behind a display: none ancestor.
    const rendered = element => element && element.getClientRects().length > 0;
    const control = actionControl(key, record.originRowId, element => !element.disabled && rendered(element));
    const target = [noticeRows.get(next)?.lastElementChild, control, $("search"), $("back-to-work")].find(rendered);
    if (target) focusInView(target);
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
// Built per project from the view model's groups; this only turns them into <option> and <optgroup> nodes.
function renderStatusFilter() {
    const select = $("status-filter");
    if (document.activeElement === select) return;
    const groups = statusFilterGroups(state.statuses, ui.category);
    const signature = JSON.stringify(groups);
    if (select.dataset.options !== signature) {
        select.dataset.options = signature;
        select.replaceChildren(...groups.flatMap(({ label, options }) => {
            const nodes = options.map(option => new Option(option.label, option.value));
            if (!label) return nodes;
            const group = document.createElement("optgroup");
            group.label = label;
            group.append(...nodes);
            return [group];
        }));
    }
    select.value = ui.category;
}
// The sprints the loaded issues belong to; hidden when the project has no sprint data.
let sprintChoices = [];
const sprintFilter = () => appliedSprint(sprintChoices, ui.sprint);
function renderSprintFilter() {
    const select = $("sprint-filter");
    sprintChoices = sprintOptions(state.issues);
    // Hiding a focused control would drop keyboard focus, so hand it to the search field first.
    if (!sprintChoices.length && document.activeElement === select) $("search").focus({ preventScroll: true });
    select.hidden = !sprintChoices.length;
    selectOptions(select, sprintChoices, sprintFilter() === "all" ? "" : sprintFilter(), "All sprints");
}
function captureFocus(container) {
    return container.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
}
function restoreFocus(container, key) {
    if (!key) return;
    // The container itself counts: a hierarchy row carries its own key.
    const element = [container, ...container.querySelectorAll("[data-focus-key]")].find(candidate => candidate.dataset.focusKey === key);
    if (!element) return;
    // A rebuilt action control that is still pending is created disabled; keep it focusable as aria-disabled.
    if (element.disabled && element.dataset.actionKey) {
        element.disabled = false;
        element.setAttribute("aria-disabled", "true");
    }
    element.focus({ preventScroll: true });
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
    renderSprintFilter();
    // Replace the inputs only when the applied scope or project changes, so an unapplied or rejected edit stays put.
    const scopeSignature = JSON.stringify([state.scope, state.workingScope]);
    if ($("scope-kind").dataset.signature !== scopeSignature) {
        $("scope-kind").dataset.signature = scopeSignature;
        $("scope-kind").value = state.workingScope?.kind || "project";
        $("scope-value").value = state.workingScope?.value || "";
    }
    $("scope-value").disabled = $("scope-kind").value === "project" || selecting || !state.project;
    $("scope-kind").disabled = $("apply-scope").disabled = selecting || !state.project;
    setAttr($("apply-scope"), "aria-busy", String(selecting));
    const scopeSummary = state.project ? workingSetSummary(state) : "Choose a project to load a working set.";
    if ($("scope-summary").textContent !== scopeSummary) $("scope-summary").textContent = scopeSummary;
    setHidden($("load-more"), !state.page?.nextPageToken);
    configureActionControl($("load-more"), "load-more", loadMoreTarget(), selecting || !state.project);
    configureActionControl($("project-start"), "prepare", "project", !state.project || !state.mapping || state.cached);
    configureActionControl($("sync-jira"), "launch", "project", selecting || !state.project || !state.mapping || Boolean(state.error) || state.cached || nodePending("project"));
    configureActionControl($("refresh"), "refresh-jira", "jira", selecting || !state.project);
    configureActionControl($("connections"), "catalog", "connections", false, null);
    setText($("project-title"), state.project?.name || "Your work, connected.");
    $("project-title").disabled = !state.project;
    const unavailableExecutions = state.executions.filter(execution => !getItem(execution.nodeId)).map(execution => execution.nodeId);
    const { signIn, standalone, errors, retryAt } = banner(state, { unavailable: unavailableExecutions });
    setHidden($("sign-in"), !signIn);
    if (signIn) {
        $("sign-in-server").textContent = signIn.server;
        $("sign-in-button").hidden = $("sign-in-mcp").hidden = signIn.connector;
        $("sign-in-connector").hidden = !signIn.connector;
        // A browser-flow link started for an MCP server does not apply to the app's connector.
        if (signIn.connector) $("sign-in-status").hidden = true;
    }
    else $("sign-in-status").hidden = true;
    setHidden($("standalone"), !standalone);
    if (standalone) {
        setHidden($("standalone-saved"), !standalone.saved);
        setText($("standalone-prompt"), standalone.prompt);
    }
    else $("standalone-status").hidden = true;
    const errorSignature = JSON.stringify(errors);
    if ($("errors").dataset.signature !== errorSignature) {
        $("errors").dataset.signature = errorSignature;
        $("errors").replaceChildren(...errors.map(message => el("p", message)));
    }
    setHidden($("errors"), !errors.length);
    // Outside the alert region: the next attempt time is read on demand, never announced.
    const retry = errors.length ? retryNotice(retryAt, { format: clockTime }) : "";
    if ($("retry-time").textContent !== retry) $("retry-time").textContent = retry;
    setHidden($("retry-time"), !retry);
    const work = state.issues.filter(i => !i.contextOnly && i.level <= 0);
    const allLinks = ["project", ...state.issues.map(item => item.id)].map(nodeLinks);
    const metrics = [
        [state.issues.filter(i => !i.contextOnly && i.level > 0).length, "Loaded parents"],
        [work.length, "Loaded work items"],
        [work.filter(i => i.category === "done").length, "Jira done"],
        [new Set(allLinks.flatMap(trace => trace.sessions.map(s => s.id))).size, "Linked sessions"],
        [new Set(allLinks.flatMap(trace => trace.prs.map(p => `${p.repo}#${p.number}`))).size, "Pull requests"],
    ];
    const metricSignature = JSON.stringify(metrics);
    if ($("metrics").dataset.signature !== metricSignature) {
        $("metrics").dataset.signature = metricSignature;
        $("metrics").replaceChildren(...metrics.map(([value, label]) => {
            const block = el("div", null, "metric");
            block.append(el("strong", value), el("span", label));
            return block;
        }));
    }
    const jira = jiraFreshness(state, time);
    const jiraOff = selecting || !state.project || !scopeConfirmed || standaloneHost(state);
    setSource($("freshness"), `Jira: ${jira.text}`, jira.tone, sourceHint(jira.detail, jiraOff, "re-read Jira"));
    configureActionControl($("freshness"), "refresh-jira", "jira", jiraOff);
    const unverified = { jira: Boolean(state.stale || state.cached) };
    for (const source of ["sessions", "github"]) {
        const freshness = sourceFreshness(allLinks, source, time);
        const label = source === "sessions" ? "Sessions" : "GitHub";
        const chip = $(source === "sessions" ? "session-freshness" : "github-freshness"), off = jiraOff || !freshness.needed;
        setSource(chip, `${label}: ${freshness.label}`, freshnessTone(freshness), sourceHint(freshness.detail, off, `re-check linked ${source === "sessions" ? "sessions" : "pull requests"}`));
        configureActionControl(chip, "refresh-execution", source, off);
        unverified[source] = freshness.needed && freshness.label !== "fresh";
    }
    renderProgress(work, unverified);
    setData($("workbench"), "detailsOpen", String(ui.detailsOpen));
    $("show-details").disabled = !getItem(ui.selected);
    for (const view of WORK_VIEWS) setAttr($(`view-${view}`), "aria-pressed", String(ui.view === view));
    setHidden($("execution-filters"), ui.view !== "execution");
    setHidden($("hierarchy-header"), ui.view !== "hierarchy");
    setHidden($("expand"), ui.view !== "hierarchy");
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
const executionFor = id => indexedExecution(executionsById, id);
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
    const sprint = sprintFilter();
    const entries = executionItems().filter(({ item }) => matches(item, ui.query, ui.category, sprint));
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
function primaryAction(item, execution = executionFor(item.id)) {
    if (item.contextOnly) return badge(item.missing ? "Unavailable parent" : "Context-only ancestor");
    const primary = execution.primary || { kind: "inspect", label: "Inspect work" };
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
// armClear relabels only the Clear controls on screen, so a cached row can hold a label from an earlier confirmation
// state; such a row is rebuilt rather than shown again.
const clearRows = new WeakSet();
function clearStateCurrent(row) {
    if (!clearRows.has(row)) return true;
    for (const control of row.querySelectorAll("[data-clear-label]"))
        if (control.classList.contains("confirming") !== armedClears.has(control.dataset.actionKey)) return false;
    return true;
}
function clearRequestButton(label, nodeId, requestId) {
    const key = actionKey("clear-request", requestId), armed = armedClears.has(key);
    const control = button(armed ? "Confirm clear" : label, () => {
        if (!armedClears.has(key)) { armClear(key, true); return; }
        armClear(key, false);
        void clearRequest(nodeId, requestId, label, $("tree").contains(control) ? $("tree") : $("inspector-content"));
    }, `row-action${armed ? " confirming" : ""}`);
    control.dataset.clearLabel = label;
    control.title = "Check the project's sessions first: the launch may have created one, or may still create one, without a receipt. Clearing frees Start; a late receipt still attaches its session.";
    return configureActionControl(control, "clear-request", requestId, !requestId);
}
async function clearRequest(nodeId, requestId, label, origin) {
    await perform({
        kind: "clear-request", target: requestId, nodeId, label, refresh: true,
        work: async () => { await api("clear-request", { requestId }); },
        success: "Stuck request cleared. Start is available again. A session may still appear; its late receipt still attaches.",
    });
    if (actions.get(actionKey("clear-request", requestId))?.status !== "success") return;
    // The cleared item's actions change: re-render now rather than after focus leaves. The re-render replaces the
    // focused Clear button, so put focus back on the row, or on the inspector's Start button.
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
function refreshSourceAction(label, source = "all", nodeId) {
    const jira = source === "jira";
    return {
        kind: jira ? "refresh-jira" : "refresh-execution", target: source, nodeId, label,
        work: context => jira ? api("refresh", {}) : refreshExecution(source, context.epoch),
        refresh: true, success: jira ? "Jira refresh returned; live source freshness is independent." :
            `${source === "all" ? "Live sources" : humanize(source)} refresh returned; see each source's freshness.`,
    };
}
function refreshSourceButton(label, source = "all", nodeId) {
    const { kind, target, work, ...options } = refreshSourceAction(label, source, nodeId);
    return actionButton(label, kind, target, nodeId, work, { className: "row-action", ...options });
}
// Built rows by node ID with the digest of what each shows. A render rebuilds only the rows whose digest changed and
// keeps the others (and the focus inside them) in place, so selecting, expanding, filtering or a poll touches only the
// rows it changes. Rows a filter hides stay cached for the current view until their issue leaves the working set.
let treeRows = [], rowCache = new Map(), visibleRows = new Map(), tabStopRow = null, rowView = null, rowIssues = null;
// The Kanban columns on screen by status name, kept like rows so the cards and the focus inside them stay in place.
let boardColumns = new Map(), boardColumnIds = 0;
const VIEW_ROLES = { hierarchy: ["tree", "Jira work hierarchy"], execution: ["list", "Daily execution queue"], kanban: ["group", "Kanban board by Jira status"] };
const itemDigests = new WeakMap();
const itemDigest = item => {
    if (!itemDigests.has(item)) itemDigests.set(item, JSON.stringify(item));
    return itemDigests.get(item);
};
function renderTree(force = false) {
    const container = $("tree");
    // The revision stands for the working set and its tree; links leave out stamps that rows never show.
    const signature = JSON.stringify([ui.view, ui.executionFilter, ui.query, ui.category, sprintFilter(), ui.selected, [...collapsed], state.issuesRevision ?? state.issues, state.statuses, state.executions, linksDigest(state.links), state.requests, requestStatuses(state.requests), state.mapping, selecting, scopeConfirmed]);
    if (!force && signature === treeDigest) return;
    const focus = captureFocus(container), hadFocus = container.contains(document.activeElement);
    // Control keys repeat across rows (the same refresh action, or one session or PR linked to two issues), so focus is
    // restored inside the row that had it.
    const focusedRowId = hadFocus ? document.activeElement.closest("[data-node-id]")?.dataset.nodeId : undefined;
    // The order the user saw, so a focused row that leaves the list hands focus to its nearest neighbour.
    const shownOrder = focusedRowId === undefined ? [] : treeRows.map(row => row.dataset.nodeId);
    // A cleared digest means the scope or working set was replaced: build every row afresh.
    if (!treeDigest || rowView !== ui.view) { rowCache = new Map(); boardColumns = new Map(); }
    else if (rowIssues !== state.issues) for (const id of rowCache.keys()) if (!itemsById.has(id)) rowCache.delete(id);
    rowView = ui.view;
    rowIssues = state.issues;
    treeDigest = signature;
    container.setAttribute("role", VIEW_ROLES[ui.view][0]);
    container.setAttribute("aria-label", VIEW_ROLES[ui.view][1]);
    setData(container, "view", ui.view);
    if (!state.project) {
        const empty = el("div", null, "empty");
        empty.append(el("h3", "Choose a Jira project"), el("p", "All epics, issues and subtasks. No active sprint required."));
        container.replaceChildren(empty);
        treeRows = [];
        rowCache = new Map();
        boardColumns = new Map();
        visibleRows = new Map();
        tabStopRow = null;
        $("work-count").textContent = "No project loaded";
        return;
    }
    // Every row is described by what it shows; `build` makes it only when that differs from the row on screen.
    const entries = [];
    // What a row's own controls were built from: its launch state, whether a repository is mapped, and an armed Clear.
    const launchSummary = id => {
        const primary = executionFor(id).primary;
        return [nodeLaunch(id), Boolean(state.mapping), primary?.kind === "clear_request" && armedClears.has(actionKey("clear-request", primary.requestId))];
    };
    let board = null;
    if (ui.view === "execution") {
        const sprint = sprintFilter();
        const queue = executionItems().filter(({ item, execution }) => matches(item, ui.query, ui.category, sprint) && (ui.executionFilter === "all" || execution.views.includes(ui.executionFilter)));
        queue.sort((a, b) => (a.execution.rank ?? Number.MAX_SAFE_INTEGER) - (b.execution.rank ?? Number.MAX_SAFE_INTEGER) || a.item.key.localeCompare(b.item.key));
        for (const { item, execution } of queue) {
            const trace = nodeLinks(item.id);
            entries.push({
                item, digest: JSON.stringify(["execution", ui.selected === item.id, execution, launchSummary(item.id)]) + linksDigest(trace),
                build: () => executionRow(item, execution, trace),
            });
        }
    } else if (ui.view === "kanban") {
        board = kanbanBoard(state.issues, state.statuses, { query: ui.query, category: ui.category, sprint: sprintFilter() });
        for (const column of board) for (const item of column.items) entries.push({
            item, column: column.name, digest: JSON.stringify(["kanban", ui.selected === item.id, launchSummary(item.id)]) + linksDigest(nodeLinks(item.id)),
            build: () => kanbanCard(item),
        });
    } else {
        const roots = filterTree(state.tree.roots, ui.query, ui.category, sprintFilter());
        const childSessions = descendantSessionCounts(state.issues, id => nodeLinks(id).sessions.map(session => session.id));
        for (const entry of flattenTree(roots, id => !collapsed.has(id) || Boolean(ui.query))) {
            const { node, depth, parentId, index, count, expanded } = entry, item = node.issue;
            const sessions = childSessions.get(item.id) || 0, execution = executionFor(item.id);
            entries.push({
                item, digest: JSON.stringify(["hierarchy", depth, parentId, index, count, node.children.length, expanded, node.done, node.total,
                    sessions, ui.selected === item.id, execution, launchSummary(item.id)]) + linksDigest(nodeLinks(item.id)),
                build: () => hierarchyRow(entry, sessions, execution),
            });
        }
    }
    const visible = new Map(), rows = [];
    for (const entry of entries) {
        const { item, digest, build } = entry;
        const shown = `${itemDigest(item)}${digest}`, cached = rowCache.get(item.id);
        let row = cached?.shown === shown && !visible.has(item.id) && clearStateCurrent(cached.row) ? cached.row : null;
        if (!row) {
            row = build();
            if (row.querySelector("[data-clear-label]")) clearRows.add(row);
            setRowTabStop(row, false);
            if (!visible.has(item.id)) rowCache.set(item.id, { row, shown });
        }
        if (!visible.has(item.id)) visible.set(item.id, row);
        entry.row = row;
        rows.push(row);
    }
    // The board keeps its workflow columns with no matching cards; the empty notice then sits above them.
    const reused = board ? placeBoard(container, board, entries) : placeChildren(container, rows);
    treeRows = rows;
    visibleRows = visible;
    if (!rows.length) container.prepend(el("div", emptyWorkMessage(ui.view, state), "empty"));
    if (!visibleRows.has(focusedNode)) focusedNode = visibleRows.has(ui.selected) ? ui.selected : rows[0]?.dataset.nodeId;
    setTabStop(focusedNode);
    setText($("work-count"), `${rows.length} visible loaded item${rows.length === 1 ? "" : "s"}`);
    // Kept rows hold their scroll position; a list built afresh is put back where the user left it.
    if (!reused) $("work-scroll").scrollTop = ui.scrollTop;
    if (hadFocus && !container.contains(document.activeElement)) {
        const row = focusedRowId === undefined ? container : visibleRows.get(focusedRowId);
        if (row) restoreFocus(row, focus);
        // The focused control went with its row's old content: keep focus on the row. If the row itself is gone, move to
        // the next row the user saw, else the previous one, else out of the empty list, never to the page.
        if (!container.contains(document.activeElement) && document.activeElement === document.body) {
            const at = shownOrder.indexOf(focusedRowId);
            const near = row ? focusedRowId : at < 0 ? focusedNode
                : [...shownOrder.slice(at + 1), ...shownOrder.slice(0, at).reverse()].find(id => visibleRows.has(id));
            if (!focusRow(near)) {
                const rendered = element => element && element.getClientRects().length > 0;
                const target = [$("search"), $(`view-${ui.view}`), $("back-to-work")].find(rendered);
                if (target) focusInView(target);
            }
        }
        // A rebuilt row can also have moved (its rank changed): keep the restored focus in view, scrolling no further than
        // needed, so it is not left on an offscreen control.
        const restored = container.contains(document.activeElement) ? document.activeElement.closest("[data-node-id]") || document.activeElement : null;
        restored?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
}
// Puts `children` into `parent` in order. Those already there stay put, so the focus inside them survives: what goes is
// removed first, so the ones that stay are never moved past each other, then the new ones are inserted. Returns whether
// any child was already there.
function placeChildren(parent, children) {
    const kept = new Set(children), reused = children.some(child => child.parentNode === parent);
    if (!reused) {
        const fragment = document.createDocumentFragment();
        for (const child of children) fragment.append(child);
        parent.replaceChildren(fragment);
        return false;
    }
    for (const child of [...parent.children]) if (!kept.has(child)) child.remove();
    let cursor = parent.firstElementChild;
    for (const child of children) {
        if (child === cursor) cursor = cursor.nextElementSibling;
        else parent.insertBefore(child, cursor);
    }
    return true;
}
// Puts each card in its status column and the columns on the board, keeping the columns and cards already on screen.
function placeBoard(container, board, entries) {
    const cards = new Map(board.map(status => [status.name, []]));
    for (const entry of entries) cards.get(entry.column).push(entry.row);
    const columns = board.map(status => {
        let column = boardColumns.get(status.name);
        if (column?.category !== status.category) boardColumns.set(status.name, column = boardColumn(status));
        const own = cards.get(status.name);
        setText(column.count, String(own.length));
        placeChildren(column.list, own);
        return column.element;
    });
    for (const name of boardColumns.keys()) if (!cards.has(name)) boardColumns.delete(name);
    // An explicit column count, so an empty-board notice can span the board in a row of its own.
    const count = String(Math.max(columns.length, 1));
    if (container.style.getPropertyValue("--columns") !== count) container.style.setProperty("--columns", count);
    return placeChildren(container, columns);
}
function boardColumn({ name, category }) {
    const element = el("div", null, "kanban-column"), heading = el("h3", null, "kanban-heading");
    element.dataset.category = category;
    heading.id = `kanban-column-${++boardColumnIds}`;
    const count = el("span", "0", "kanban-count");
    const label = el("span", name, "kanban-name");
    label.title = name;
    heading.append(label, count);
    const list = el("div", null, "kanban-list");
    list.setAttribute("role", "list");
    list.setAttribute("aria-labelledby", heading.id);
    element.append(heading, list);
    return { element, list, count, category };
}
// The card at the same position in the nearest column that has cards, to the left (-1) or right (1).
function boardNeighbour(card, step) {
    const lists = [...$("tree").querySelectorAll(".kanban-list")], at = [...card.parentElement.children].indexOf(card);
    for (let index = lists.indexOf(card.parentElement) + step; index >= 0 && index < lists.length; index += step) {
        const cards = lists[index].children;
        if (cards.length) return cards[Math.min(at, cards.length - 1)];
    }
    return null;
}
function kanbanCard(item) {
    const card = createRow(item, 0);
    card.classList.add("kanban-card");
    const details = el("div", null, "kanban-details");
    details.append(el("span", item.assignee || "Unassigned"));
    if (item.parentKey) details.append(el("span", `In ${item.parentKey}`));
    const observed = el("div", null, "observed-state");
    appendCompactObserved(observed, item.id, { quiet: true });
    card.append(itemName(item, null, true), details);
    if (observed.childElementCount) card.append(observed);
    card.append(feedbackFor(item.id));
    return card;
}
function executionRow(item, execution, trace) {
    const row = createRow(item, 0);
    row.classList.add("execution-row");
    const name = itemName(item, null, true);
    const why = el("div", null, "execution-why"), reason = el("p", primaryReason(execution), "execution-reason");
    reason.title = reason.textContent;
    why.append(reason);
    const evidence = executionEvidence(item, execution, trace);
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
    return row;
}
function hierarchyRow({ node, depth, parentId, index, count, expanded }, sessions, execution) {
    const item = node.issue;
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
    appendObserved(progress, item.id, execution);
    if (sessions) progress.append(badge(`${sessions} child session${sessions === 1 ? "" : "s"}`, "session"));
    if (execution.signals.length) progress.append(el("span", execution.signals.map(signal => signal.reason || humanize(signal.kind)).join("; "), "muted"));
    const reason = el("p", execution.reasons.join(" "), "hierarchy-reason");
    row.append(name, status, progress, primaryAction(item, execution), reason, feedbackFor(item.id));
    return row;
}
function itemName(item, node, compact = false) {
    const title = el("div", null, "item-title");
    const meta = el(compact ? "span" : "div", null, "item-keyline");
    meta.append(el("span", (item.type || "Work").slice(0, 1), `type-icon ${item.level > 0 ? "epic" : item.level < 0 ? "subtask" : "story"}`), el("span", item.key, "issue-key"));
    if (item.level > 0 || item.id === "project") meta.append(el("small", item.id === "project" ? "Project scope" : item.type, "muted"));
    if (scopeLabel(item)) meta.append(badge(scopeLabel(item)));
    const summary = el("span", item.summary, "summary");
    if (compact) {
        // The queue row's own control: a real button that selects the item (the row is a plain list item).
        const line = button("", () => chooseItem(item.id), "execution-title row-select");
        line.dataset.focusKey = `row:${item.id}`;
        line.setAttribute("aria-label", rowLabel(item));
        if (ui.selected === item.id) line.setAttribute("aria-current", "true");
        summary.title = item.summary;
        line.append(meta, summary);
        title.append(line);
    } else title.append(meta, summary);
    if (item.parentKey && !compact) title.append(el("small", `In ${item.parentKey}`));
    if (node?.total) title.append(el("small", `${node.done}/${node.total} loaded descendant items Jira done`));
    return title;
}
function appendCompactObserved(container, nodeId, { quiet = false } = {}) {
    const trace = nodeLinks(nodeId), launch = nodeLaunch(nodeId);
    if (launchBlocks(launch)) container.append(badge(launchLabel(launch), "session"));
    else if (trace.sessions.length) container.append(badge(sessionsBadge(trace.sessions), "session"));
    if (trace.prs.length) {
        const pr = trace.prs[0];
        container.append(badge(trace.prs.length > 1 ? `${trace.prs.length} PRs` :
            `#${pr.number} ${pr.stale ? "stale" : pr.isDraft ? "draft" : humanize(pr.state)}`, pr.state === "MERGED" ? "merged" : "pr"));
    }
    if (!quiet && !trace.sessions.length && !trace.prs.length && !launchBlocks(launch)) container.append(badge("No linked activity"));
}
function appendObserved(container, nodeId, execution = executionFor(nodeId)) {
    const traces = nodeLinks(nodeId), launch = nodeLaunch(nodeId);
    if (launchBlocks(launch)) container.append(badge(launchLabel(launch), "session"));
    for (const session of traces.sessions) container.append(badge(`Session: ${sessionState(session)}`, "session"));
    for (const pr of traces.prs) container.append(badge(`#${pr.number}: ${pr.stale ? "stale / " : ""}${pr.isDraft ? "draft / " : ""}${humanize(pr.state)}`, pr.state === "MERGED" ? "merged" : "pr"));
    if (!traces.sessions.length && !traces.prs.length && !launchBlocks(launch)) {
        const observed = execution.signals.map(signal => humanize(signal.kind));
        container.append(el("span", observed.length ? `Observed: ${[...new Set(observed)].join(" / ")}` : "Execution state unknown", "muted"));
    }
}
const rowLabel = item => `${item.key} ${item.summary}, Jira ${item.status}${scopeLabel(item) ? `, ${scopeLabel(item)}` : ""}`;
// What takes focus for a row: the tree item itself, or the select button of a queue row.
const rowTarget = row => row.querySelector(".row-select") || row;
// One tab stop for the whole list: the focused row and its own controls. Arrow keys move between rows. Only the row
// that held the tab stop and the row that takes it are written.
// Compared as the attribute: a div without one already reports tabIndex -1 yet cannot take focus.
function setRowTabStop(row, current) {
    const target = rowTarget(row), value = current ? "0" : "-1";
    if (target.getAttribute("tabindex") !== value) target.setAttribute("tabindex", value);
    for (const control of row.querySelectorAll("button, summary")) {
        if (control !== target && !control.classList.contains("toggle") && control.getAttribute("tabindex") !== value) control.setAttribute("tabindex", value);
    }
}
function setTabStop(id) {
    const row = visibleRows.get(id) || null;
    if (tabStopRow && tabStopRow !== row) setRowTabStop(tabStopRow, false);
    if (row) setRowTabStop(row, true);
    tabStopRow = row;
}
function createRow(item, depth, parentId = "", hasChildren = false) {
    const row = el("div", null, `tree-row${ui.selected === item.id ? " selected" : ""}`);
    row.dataset.nodeId = item.id;
    row.dataset.parentId = parentId;
    if (ui.view === "hierarchy") {
        row.dataset.focusKey = `row:${item.id}`;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", String(ui.selected === item.id));
        row.setAttribute("aria-label", rowLabel(item));
    } else row.setAttribute("role", "listitem");
    row.addEventListener("click", () => chooseItem(item.id));
    row.addEventListener("focusin", () => {
        if (focusedNode === item.id && tabStopRow === row) return;
        focusedNode = item.id;
        setTabStop(item.id);
    });
    row.addEventListener("keydown", event => {
        if (event.target !== rowTarget(row)) return;
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); chooseItem(item.id); return; }
        // Rows are siblings in #tree, so the neighbours are found without collecting every row.
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? treeRows[0] : event.key === "End" ? treeRows.at(-1)
                : event.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
            if (next?.dataset.nodeId) rowTarget(next).focus();
        }
        if (ui.view === "kanban" && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const next = boardNeighbour(row, event.key === "ArrowRight" ? 1 : -1);
            if (next) rowTarget(next).focus();
            return;
        }
        if (ui.view !== "hierarchy" || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const expanded = row.getAttribute("aria-expanded") === "true";
        if (event.key === "ArrowRight" && hasChildren && expanded) {
            if (row.nextElementSibling?.dataset.nodeId) rowTarget(row.nextElementSibling).focus();
        }
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
// Focuses without the browser's jump, then scrolls only as far as needed to keep the row in view.
function focusRow(id, { scroll = true } = {}) {
    const row = visibleRows.get(id);
    if (!row?.isConnected) return false;
    rowTarget(row).focus({ preventScroll: true });
    if (scroll) row.scrollIntoView({ block: "nearest" });
    return true;
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
    const signature = JSON.stringify([ui.selected, tab, item, linksDigest(state.links, minuteKey), state.executions, state.mapping, state.requests, requestStatuses(state.requests), selecting, scopeConfirmed]);
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
        context => preparePreview(item.id, defaultMode(item, execution), context), { className: "primary", disabled: !state.mapping || item.contextOnly, success: "Session scope ready for review." }),
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
    if (foreignContext(item)) {
        body.append(el("p", "Select this item's own Jira project to view, link or refresh its Copilot trace. Cross-project context does not use this project's repository mapping.", "muted"));
        return;
    }
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
        card.append(identity);
        if (sessionExists(session)) card.append(openSessionButton("Open session", item.id, session.id));
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
    const children = (item.id === "project" ? state.issues : descendants(state.issues, item.id, issueChildren ||= childIndex(state.issues))).filter(child => nodeLinks(child.id).sessions.length || nodeLinks(child.id).prs.length);
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
    const smartComment = smartCommitOption(preview.node);
    $("launch-smart-comment-row").hidden = !smartComment;
    $("launch-smart-comment-text").textContent = smartComment?.label || "";
    $("launch-smart-comment-hint").textContent = smartComment?.hint || "";
    $("launch-smart-comment").checked = Boolean(smartComment && preview.smartCommitComment);
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
    setInert($("review-changes"), !preview || !previewDirty || reviewing || launching || pending || !scopeConfirmed || selecting);
    $("confirm-launch").textContent = launching ? "Submitting..." : implement ? "Start Implement session" : "Start Plan session";
    setInert($("confirm-launch"), !preview || previewDirty || reviewing || launching || pending || !scopeConfirmed || selecting || previewScope !== state.scope ||
        submittedPreviews.has(preview.id) || (implement && warnings.length > 0 && !$("launch-warning-ack").checked));
    for (const id of ["launch-mode", "launch-objective", "launch-criteria", "launch-constraints", "launch-smart-comment"]) $(id).disabled = launching;
    $("cancel-launch").textContent = launching ? "Close" : "Cancel";
    $("launch-status").textContent = reviewing ? "Reviewing the edited context..." : previewDirty ? "Changes are not reviewed. Choose Review changes before starting." :
        preview ? `Reviewed ${implement ? "implementation" : "planning"} context. One session will be queued after confirmation.` : "";
}
async function reviewChanges() {
    if (!preview || reviewing || launching || !previewDirty || previewScope !== state.scope) return;
    const currentPreview = preview, scope = previewScope, revision = formRevision, version = previewVersion;
    const fields = { objective: $("launch-objective").value, acceptanceCriteria: $("launch-criteria").value, constraints: $("launch-constraints").value };
    const mode = $("launch-mode").value, smartCommitComment = !$("launch-smart-comment-row").hidden && $("launch-smart-comment").checked;
    reviewing = true;
    $("launch-error").hidden = true;
    updateLaunchControls();
    try {
        const result = validatePreview(await api("prepare", { nodeId: currentPreview.node.id, mode, fields, smartCommitComment }));
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
    $("launch-smart-comment").checked = false;
    $("launch-warning-ack").checked = false;
    $("launch-sources").open = false;
    const wasOpen = $("launch-dialog").open;
    if (wasOpen) $("launch-dialog").close();
    updateLaunchControls();
    // Closing returns focus to the Start button that opened the dialog. After a confirmed launch that button is
    // disabled while the launch is pending, so focus goes to the notice that reports the launch instead.
    const active = document.activeElement;
    if (wasOpen && (!active || active === document.body || active.disabled || $("launch-dialog").contains(active)))
        focusInView($("notice").hidden ? $("search") : $("notice"));
}
async function confirmLaunch() {
    if (inert($("confirm-launch")) || !preview) return;
    const reviewed = preview, scope = previewScope;
    const acknowledgedWarnings = $("launch-mode").value === "autopilot" && $("launch-warning-ack").checked ? reviewed.brief.warnings.map(w => w.id) : [];
    submittedPreviews.add(reviewed.id);
    launching = true;
    updateLaunchControls();
    await perform({
        kind: "launch", target: reviewed.node.id, nodeId: reviewed.node.id, previewId: reviewed.id, label: `Start session for ${reviewed.node.key}`, refresh: true,
        work: async () => {
            const receipt = await api("launch", { previewId: reviewed.id, contextHash: reviewed.brief.hash, acknowledgedWarnings }, AbortSignal.timeout(LAUNCH_TIMEOUT_MS));
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
    connectionMessage("apply-scope", "");
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

$("scope-kind").addEventListener("change", () => { $("scope-value").disabled = $("scope-kind").value === "project"; });
$("apply-scope").addEventListener("click", async () => {
    if (selecting || !state.project) return;
    const restoreFocus = document.activeElement === $("apply-scope");
    const definition = { kind: $("scope-kind").value, value: $("scope-value").value };
    closePreview();
    selecting = true;
    const epoch = ++scopeEpoch;
    snapshotVersion++;
    connectionMessage("apply-scope", "Applying scope; reading the first Jira page.");
    render();
    try {
        const snapshot = await api("scope", definition);
        if (epoch === scopeEpoch) {
            acceptSnapshot(snapshot);
            connectionMessage("apply-scope", snapshot.scopeError || (snapshot.applyResult?.status === "superseded"
                ? "Scope application was superseded." : "Scope applied."));
        }
    } catch (error) {
        if (epoch === scopeEpoch) connectionMessage("apply-scope", `Scope was not applied: ${error.message}`);
    } finally {
        if (epoch === scopeEpoch) {
            selecting = false;
            // A view change made just before Apply could not be saved while it ran.
            savePreferences();
            render({ force: true });
            if (restoreFocus && document.activeElement === document.body) $("apply-scope").focus({ preventScroll: true });
        }
    }
});
// Keyed by working-set generation: a Load more still pending for a replaced scope must not disable the new one.
function loadMoreTarget() { return `working-set:${state.workingSetGeneration ?? 0}`; }
$("load-more").addEventListener("click", () => void perform({
    // The Load more response is the full snapshot, so no second read follows it.
    kind: "load-more", target: loadMoreTarget(), label: "Load more", work: loadMoreAction,
    success: "Working-set page loaded.",
}));
// Typing renders once per pause rather than once per key; the query itself is current at once for any other render.
const SEARCH_RENDER_MS = 180;
let searchTimer;
$("search").addEventListener("input", () => {
    ui.query = $("search").value;
    savePreferences("query");
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { renderExecutionFilters(); renderTree(); paintFeedback(); }, SEARCH_RENDER_MS);
});
$("status-filter").addEventListener("change", () => { ui.category = $("status-filter").value; savePreferences("category"); renderExecutionFilters(); renderTree(true); paintFeedback(); });
$("sprint-filter").addEventListener("change", () => { ui.sprint = $("sprint-filter").value || "all"; savePreferences("sprint"); renderExecutionFilters(); renderTree(true); paintFeedback(); });
$("expand").addEventListener("click", () => { collapsed.clear(); savePreferences("collapsed"); renderTree(true); paintFeedback(); });
for (const view of WORK_VIEWS) $(`view-${view}`).addEventListener("click", () => {
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
// Skips the list's rows and controls. In a narrow panel the details open from Show details.
$("skip-to-details").addEventListener("click", () => {
    if ($("inspector").getClientRects().length) $("inspector").focus();
    else if (!$("show-details").disabled) $("show-details").focus();
});
// Runs before every other click handler: a focused control kept as aria-disabled must not act.
document.addEventListener("click", event => {
    if (event.target.closest?.('button[aria-disabled="true"]')) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
// Freshness details show on hover and focus; Escape hides them until the pointer and focus have both left.
document.addEventListener("keydown", event => {
    if (event.key === "Escape") for (const source of document.querySelectorAll(".source:is(:hover, :focus)")) source.classList.add("tip-dismissed");
});
for (const source of document.querySelectorAll(".source")) {
    source.addEventListener("mouseleave", () => { if (!source.matches(":focus")) source.classList.remove("tip-dismissed"); });
    source.addEventListener("blur", () => { if (!source.matches(":hover")) source.classList.remove("tip-dismissed"); });
}
$("sync-jira").addEventListener("click", () => {
    if (inert($("sync-jira")) || !state.project || !state.mapping) return;
    $("sync-project").textContent = `${state.project.key} - ${state.project.name}`;
    $("sync-repo").textContent = state.mapping.repo || state.mapping.name;
    $("sync-dialog").showModal();
});
$("cancel-sync").addEventListener("click", () => $("sync-dialog").close());
$("confirm-sync").addEventListener("click", () => {
    $("sync-dialog").close();
    // Known before the call, so a timeout or an error response can still be matched to the stored request.
    const clientId = crypto.randomUUID();
    void perform({
        kind: "launch", target: "project", nodeId: "project", label: "Sync Jira statuses", refresh: true, clientId,
        work: () => api("sync-jira", { clientId }, AbortSignal.timeout(LAUNCH_TIMEOUT_MS)),
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
$("freshness").addEventListener("click", () => void perform(refreshSourceAction("Refresh Jira", "jira")));
$("session-freshness").addEventListener("click", () => void perform(refreshSourceAction("Refresh sessions", "sessions")));
$("github-freshness").addEventListener("click", () => void perform(refreshSourceAction("Refresh GitHub", "github")));
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
$("launch-smart-comment").addEventListener("change", markPreviewDirty);
$("launch-warning-ack").addEventListener("change", updateLaunchControls);
$("review-changes").addEventListener("click", () => void reviewChanges());
$("cancel-launch").addEventListener("click", closePreview);
$("launch-dialog").addEventListener("cancel", event => { event.preventDefault(); closePreview(); });
$("confirm-launch").addEventListener("click", () => void confirmLaunch());
// The tree updates in place while it has focus; the inspector still waits until focus leaves it.
$("inspector-content").addEventListener("focusout", () => setTimeout(() => {
    if ($("inspector-content").contains(document.activeElement)) return;
    renderInspector();
    paintFeedback();
}, 0));
function pollingPaused() {
    return document.hidden || selecting || $("launch-dialog").open || $("sync-dialog").open || reviewing || launching ||
        [...actions.values()].some(action => action.scope === state.scope && action.status === "pending" &&
            ["prepare", "launch", "trace", "refresh-jira", "refresh-execution", "load-more"].includes(action.kind));
}
let lastSessionPoll = 0;
async function poll() {
    if (pollPending || pollingPaused()) return;
    pollPending = true;
    const epoch = scopeEpoch;
    try {
        let applied = false, full = false;
        if (state.project && scopeConfirmed && !state.warming && !state.refreshing && !standaloneHost(state) && Date.now() - lastSessionPoll >= 4500) {
            lastSessionPoll = Date.now();
            const version = snapshotVersion;
            const snapshot = await refreshExecution("sessions", epoch, false, true);
            if (epoch !== scopeEpoch || pollingPaused()) return;
            // The refresh returns the snapshot read after it, so no second read is needed. If another read started
            // meanwhile, fall back to a fresh read as before; otherwise apply it and retire any older read in flight.
            if (version === snapshotVersion && !selecting) {
                snapshotVersion++;
                applied = applySnapshot(snapshot);
                // Compared against a revision this panel does not hold: read the whole snapshot, not a stale delta.
                full = !applied;
            }
        }
        if (epoch !== scopeEpoch || pollingPaused()) return;
        if (!applied) await sync(epoch, full);
        warmingMessage();
        if (epoch === scopeEpoch) connectionMessage("poll", "");
    } catch (error) {
        if (epoch === scopeEpoch && !serverLost(serverFailures)) connectionMessage("poll", `Automatic session refresh failed: ${error.message}. Last observed state is retained; GitHub freshness has not been refreshed.`);
    } finally {
        pollPending = false;
    }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
function warmingMessage() {
    connectionMessage("warming", state.warming && !signInNeeded(state) && !standaloneHost(state) ? state.project
        ? state.issues.length ? `Showing ${state.cached ? "the cached" : "the last"} ${state.project.key} snapshot while Jira and Copilot reconnect...`
            : `Loading ${state.project.key} from Jira...`
        : "Connecting to Jira and Copilot..." : "");
}
$("sign-in-button").addEventListener("click", async () => {
    const button = $("sign-in-button"), status = $("sign-in-status");
    setInert(button, true);
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
        setInert(button, false);
    }
});
$("standalone-copy").addEventListener("click", async () => {
    const status = $("standalone-status"), prompt = $("standalone-prompt");
    status.hidden = false;
    try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(prompt.textContent);
        status.textContent = "Prompt copied. Paste it into any Copilot session.";
    } catch {
        getSelection().selectAllChildren(prompt);
        status.textContent = "Copying is not available here. The prompt is selected; copy it with your keyboard.";
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
let lastBuildCheck = 0;
const checkBuild = () => { lastBuildCheck = Date.now(); return api("version").then(showBuild).catch(() => {}); };
// No version reads while the panel is hidden; on return it checks at once if a check was skipped.
const BUILD_CHECK_MS = 60_000;
function checkBuildWhenVisible() {
    if (!document.hidden && Date.now() - lastBuildCheck >= BUILD_CHECK_MS - 5000) void checkBuild();
}
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
checkBuildWhenVisible();
setInterval(checkBuildWhenVisible, BUILD_CHECK_MS);
document.addEventListener("visibilitychange", checkBuildWhenVisible);
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
// The cadence is pollDelayMs: 1s while reconnecting, 5s when healthy, 30s once this panel's server is gone.
// Decided each tick, because a failure can arrive through an action response between polls.
let lastPoll = 0;
setInterval(() => {
    const reconnecting = Boolean(!standaloneHost(state) && (state.catalogErrors.length || state.error || state.warming || state.retryAt));
    if (Date.now() - lastPoll < pollDelayMs({ reconnecting, lost: serverLost(serverFailures) }) - 50) return;
    lastPoll = Date.now();
    void poll();
}, 1000);

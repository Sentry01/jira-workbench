import { buildTree, projectStatuses, requestStatus, scopeKey } from "./model.mjs";
import { deriveExecution } from "./execution.mjs";
import { Launches } from "./launches.mjs";
import { objects, settle, standaloneError } from "./runtime.mjs";
import { Trace } from "./trace.mjs";
import { DEFAULT_SCOPE, mergeIssues, validateScope, workingSetKey, scopeJql } from "./scope.mjs";

// Issues the execution queue must never lose: unresolved launch requests and durable session or PR links.
function trackedIds(data, prefix) {
    const ids = new Set();
    for (const request of Object.values(data.requests))
        if (request.scope?.startsWith(prefix) && /^\d+$/.test(request.nodeId) && ["queued", "expired", "failed"].includes(requestStatus(request)))
            ids.add(request.nodeId);
    for (const [key, link] of Object.entries(data.links)) {
        const id = key.startsWith(prefix) ? key.slice(prefix.length) : "";
        if (/^\d+$/.test(id) && (link.sessions?.length || link.prs?.length)) ids.add(id);
    }
    return ids;
}

export class Workbench {
    constructor(options) {
        Object.assign(this, options);
        this.sites = [];
        this.appProjects = [];
        this.projectLists = new Map();
        this.previews = new Map();
        this.issues = [];
        this.workingScope = { ...DEFAULT_SCOPE };
        this.page = { nextPageToken: null, total: null, loaded: 0 };
        this.pageLoads = new Map();
        this.ancestorWarnings = [];
        this.linkedWarnings = [];
        this.pageErrors = {};
        this.attemptedParents = [];
        this.refreshGeneration = 0;
        // Store writes that can make an issue tracked (launch requests, session links), so installing a working
        // set can wait for them instead of dropping an issue whose request landed while Jira was being read.
        this.commits = 0;
        this.committing = new Set();
        // The selected project's workflow statuses as Jira listed them; empty when it could not.
        this.statuses = [];
        this.error = null;
        this.catalogErrors = [];
        this.executionRefreshes = new Map();
        this.cached = false;
        this.warming = false;
        this.backgroundError = null;
        this.pending = new Set();
        this.selections = 0;
        this.catalogGeneration = 0;
        // Startup, pick and catalog passes in progress, and whether one more recovery pass waits for them.
        this.passes = 0;
        this.queued = false;
        // What this process has confirmed live; anything else came from cache.json.
        this.verified = { sites: false, apps: false, lists: new Set() };
        this.launches = new Launches(this);
        this.trace = new Trace(this);
    }
    currentScope() { return this.site && this.project ? this.selectedScope() : null; }
    async afterScopeCommit(change) {
        while (this.scopeCommit) await this.scopeCommit;
        return change();
    }
    loadKey() { return workingSetKey(this.selectedScope(), this.workingScope); }
    resetWorkingSet() {
        this.refreshGeneration++;
        this.jiraRefreshing = null;
        this.issues = [];
        this.page = { nextPageToken: null, total: null, loaded: 0 };
        this.ancestorWarnings = [];
        this.linkedWarnings = [];
        this.pageErrors = {};
        this.attemptedParents = [];
        this.previews.clear();
        this.fetchedAt = null;
        this.error = null;
        this.cached = false;
    }
    async restoreScope() {
        const scope = this.selectedScope(), generation = this.refreshGeneration, data = await this.store.read();
        if (scope !== this.currentScope() || generation !== this.refreshGeneration) return;
        this.workingScope = validateScope(data.preferences?.[scope]?.workingScope || DEFAULT_SCOPE);
    }
    commit(change) {
        this.commits++;
        const write = this.store.update(change);
        this.committing.add(write);
        const done = () => this.committing.delete(write);
        write.then(done, done);
        return write;
    }
    // The store once no tracked write is pending or started during the read; callers install synchronously after.
    async committedState() {
        for (;;) {
            const count = this.commits;
            await Promise.allSettled([...this.committing]);
            const data = await this.store.read();
            if (count === this.commits && !this.committing.size) return data;
        }
    }
    remember(change) {
        return this.cache ? this.cache.update(change).catch(() => {}) : Promise.resolve();
    }
    // Starts the task now (so a pass it begins is counted at once) and records how it ended.
    background(task) {
        const run = new Promise(resolve => resolve(task())).then(() => { this.backgroundError = null; }, error => { this.backgroundError = error.message; });
        this.pending.add(run);
        void run.finally(() => this.pending.delete(run));
        return run;
    }
    // Jira reads go through the connection supervisor when the panel has one: it fails them fast while sign-in is
    // required and learns from their failures. Without one (unit tests, fixtures) they go straight to the gateway.
    jira(run, fresh = false) {
        return this.connection ? this.connection.read(run, { fresh }) : run({ fresh });
    }
    // A startup or pick that threw (e.g. the project list failed after sites loaded) leaves no catalog or Jira
    // error behind, so it is tracked separately; otherwise the panel could sit empty and never retry.
    needsRecovery() { return Boolean(this.catalogErrors.length || this.error || this.unfinished); }
    // The connection calls this on attach, on every state change and after MCP events: each is a reason to redo a
    // startup or pick that did not complete (and to show why, if it still cannot).
    connectionChanged() { this.recover(); }
    // Redo the last startup or pick, restoring the project the user picked last. At most one pass runs and one
    // waits: a pass already running may have started before the change that prompted this, so run again after it.
    recover() {
        if (this.closed || !this.needsRecovery()) return null;
        if (this.passes) { this.queued = true; return null; }
        return this.background(() => this.warm(this.requested));
    }
    pass(task) {
        this.passes++;
        return new Promise(resolve => resolve(task())).finally(() => {
            if (--this.passes || !this.queued) return;
            this.queued = false;
            this.recover();
        });
    }
    signIn() {
        if (!this.connection) throw new Error("Sign-in is not available in this panel.");
        return this.connection.signIn();
    }
    // No Copilot session behind the panel: session work cannot start or be observed. Refusing it also keeps this
    // panel's failed observations out of the store that panels in real sessions share.
    standalone() { return this.connection?.current?.state === "standalone"; }
    inSession(run) { return this.standalone() ? Promise.reject(standaloneError()) : run(); }
    close() {
        this.closed = true;
        this.queued = false;
    }
    async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
    // Show the last project from disk immediately; nothing restored here can start work until revalidated.
    async hydrate(requested = null) {
        if (!this.cache) return false;
        const data = await this.cache.read();
        if (Array.isArray(data.catalog?.sites)) this.sites = data.catalog.sites;
        if (Array.isArray(data.catalog?.appProjects)) this.appProjects = data.catalog.appProjects;
        for (const [id, entry] of Object.entries(data.projectLists || {}))
            if (Array.isArray(entry?.projects)) this.projectLists.set(id, entry.projects);
        const last = requested || data.lastScope;
        const site = this.sites.find(s => s.id === last?.cloudId);
        const project = site && this.projectLists.get(site.id)?.find(p => p.id === last?.jiraProjectId);
        if (!project) return false;
        this.site = site;
        this.project = project;
        await this.restoreScope();
        const legacy = this.workingScope.kind === "project" ? data.issues?.[this.selectedScope()] : null;
        const cached = data.issues?.[this.loadKey()] || (legacy ? { ...legacy, issues: legacy.issues?.slice(0, 100), page: { nextPageToken: null, total: null, loaded: Math.min(legacy.issues?.length || 0, 100) } } : null);
        this.issues = Array.isArray(cached?.issues) ? cached.issues : [];
        this.page = cached?.page || { nextPageToken: null, total: null, loaded: 0 };
        this.ancestorWarnings = cached?.ancestorWarnings || [];
        this.linkedWarnings = cached?.linkedWarnings || [];
        this.statuses = Array.isArray(cached?.statuses) ? cached.statuses : [];
        this.fetchedAt = cached?.fetchedAt || null;
        this.cached = true;
        return true;
    }
    warm(requested = null) {
        return this.pass(async () => {
            this.requested = requested;
            this.unfinished = true;
            const selection = this.selections;
            // A pick made while this runs owns the outcome (and the unfinished flag); never override it.
            if (!requested || (this.site?.id === requested.cloudId && this.project?.id === requested.jiraProjectId)) {
                await this.revalidate();
                if (selection === this.selections) this.unfinished = false;
                return;
            }
            this.warming = true;
            try {
                await this.catalog();
                // The panel is usable while the catalog loads; never override a project picked meanwhile.
                if (selection === this.selections) await this.select(requested);
            } finally { this.warming = false; }
        });
    }
    async revalidate() {
        this.warming = true;
        try {
            const scope = this.currentScope();
            await this.catalog();
            if (!scope || scope !== this.currentScope()) return;
            const jiraReachable = !this.catalogErrors.some(e => e.startsWith("Jira:"));
            if (jiraReachable && !this.sites.some(s => s.id === this.site.id)) { await this.clearSelection(); return; }
            const [projects] = await Promise.all([
                jiraReachable ? settle(this.projects(this.site.id)) : Promise.resolve({}),
                this.refresh(),
            ]);
            if (scope !== this.currentScope()) return;
            const project = projects.value?.find(p => p.id === this.project.id);
            if (projects.value && !project) { await this.clearSelection(); return; }
            // Briefs read site URL and project key from these objects, so replace the cached copies.
            if (project) this.project = project;
            if (jiraReachable) this.site = this.sites.find(s => s.id === this.site.id);
            if (!project && !this.error) this.error = `Could not confirm project access: ${projects.error?.message || "Jira site discovery failed."}`;
        } finally { this.warming = false; }
        if (this.currentScope() && !this.error) await this.refreshExecution();
    }
    async clearSelection() {
        return this.afterScopeCommit(() => {
            this.resetWorkingSet();
            this.site = null;
            this.project = null;
            return this.remember(data => { data.lastScope = null; });
        });
    }
    // fresh: an explicit user action, which must reach the sources rather than a result shared moments ago.
    catalog({ fresh = false } = {}) {
        return this.pass(async () => {
            const generation = ++this.catalogGeneration;
            const [sites, apps] = await Promise.allSettled([
                this.jira(options => this.gateway.sites(options), fresh),
                this.gateway.call("list_repositories", {}, { fresh }),
            ]);
            // A slower, older discovery must not overwrite what a newer one already found.
            if (generation !== this.catalogGeneration) return { sites: this.sites, appProjects: this.appProjects, errors: this.catalogErrors };
            this.catalogErrors = [];
            if (sites.status === "fulfilled") { this.sites = sites.value; this.verified.sites = true; }
            else this.catalogErrors.push(`Jira: ${sites.reason.message}`);
            if (apps.status === "fulfilled") {
                this.appProjects = objects(apps.value).filter(p => p.id && typeof p.github_repo === "string")
                    .map(p => ({ id: p.id, name: p.name, repo: p.github_repo }));
                this.verified.apps = true;
            } else this.catalogErrors.push(`Copilot projects: ${apps.reason.message}`);
            if (sites.status === "fulfilled" || apps.status === "fulfilled")
                await this.remember(data => { data.catalog = { sites: this.sites, appProjects: this.appProjects, at: new Date().toISOString() }; });
            return { sites: this.sites, appProjects: this.appProjects, errors: this.catalogErrors };
        });
    }
    async projects(cloudId) {
        if (!this.sites.some(s => s.id === cloudId)) throw new Error("Select an accessible Jira site first.");
        const list = await this.jira(options => this.gateway.projects(cloudId, options));
        this.projectLists.set(cloudId, list);
        this.verified.lists.add(cloudId);
        await this.remember(data => { data.projectLists[cloudId] = { projects: list, at: new Date().toISOString() }; });
        return list;
    }
    select(input) {
        return this.pass(async () => {
            try {
                const snapshot = await this.pick(input);
                this.unfinished = false;
                return snapshot;
            } catch (error) {
                this.unfinished = true;
                throw error;
            }
        });
    }
    async pick({ cloudId, jiraProjectId }) {
        const selection = ++this.selections;
        // The latest pick is what a reconnect must restore, even if this attempt fails.
        this.requested = { cloudId, jiraProjectId };
        if (!this.verified.sites) {
            await this.catalog();
            if (!this.verified.sites) throw new Error(`Jira site discovery failed: ${this.catalogErrors.join("; ")}`);
        }
        const site = this.sites.find(s => s.id === cloudId);
        if (!site) throw new Error("The selected Jira site is not in the accessible catalog.");
        const projects = this.verified.lists.has(cloudId) ? this.projectLists.get(cloudId) : await this.projects(cloudId);
        const project = projects.find(p => p.id === jiraProjectId);
        if (!project) throw new Error("The selected Jira project is not in the accessible catalog.");
        if (selection !== this.selections) return this.snapshot();
        const picked = await this.afterScopeCommit(() => {
            if (selection !== this.selections) return false;
            this.site = site;
            this.project = project;
            this.workingScope = { ...DEFAULT_SCOPE };
            this.resetWorkingSet();
            return true;
        });
        if (!picked) return this.snapshot();
        await this.restoreScope();
        if (selection !== this.selections) return this.snapshot();
        this.statuses = [];
        this.fetchedAt = null;
        this.cached = false;
        this.previews.clear();
        await this.remember(data => { data.lastScope = { cloudId, jiraProjectId }; });
        if (selection !== this.selections) return this.snapshot();
        await this.refresh();
        // Jira is the hierarchy; session and GitHub evidence fills in behind it via polling.
        if (!this.error) void this.background(() => this.refreshExecution());
        return this.snapshot();
    }
    selectedScope(nodeId = "project") {
        if (!this.site || !this.project) throw new Error("Select a Jira project first.");
        return scopeKey(this.site.id, this.project.id, nodeId);
    }
    node(nodeId) {
        this.selectedScope();
        if (nodeId === "project") return { id: "project", key: this.project.key, summary: this.project.name, type: "Project", level: 2, description: "", dependencies: [], labels: [] };
        const node = this.issues.find(i => i.id === nodeId);
        if (!node) throw new Error("That issue is not in the loaded project. Refresh before acting.");
        return node;
    }
    traceNode(nodeId) {
        const node = this.node(nodeId);
        if (nodeId !== "project" && node.projectId !== this.project.id)
            throw new Error("Select this context item's own Jira project to link or refresh its trace.");
        return node;
    }
    async map({ copilotProjectId }) {
        const key = this.selectedScope();
        const mapping = this.appProjects.find(p => p.id === copilotProjectId);
        if (!mapping) throw new Error("Choose a Copilot repository project from the picker, not a Jira project ID.");
        await this.store.update(data => { data.mappings[key] = mapping; });
        this.previews.clear();
        return mapping;
    }
    // Pure: the panel polls this, so it only reads state; retries are the connection's job.
    async snapshot() {
        const data = await this.store.read();
        const prefix = this.site && this.project ? `${[this.site.id, this.project.id].map(encodeURIComponent).join("/")}/` : null;
        const links = prefix ? Object.fromEntries(Object.entries(data.links).filter(([key]) => key.startsWith(prefix))) : {};
        const requests = prefix ? Object.values(data.requests).filter(r => r.scope.startsWith(prefix)) : [];
        const mapping = this.site && this.project ? data.mappings[this.selectedScope()] || null : null;
        const executionNodes = this.issues.filter(issue => !issue.contextOnly);
        if (this.site && this.project && (links[this.selectedScope()]?.sessions.length || requests.some(r => r.nodeId === "project")))
            executionNodes.push(this.node("project"));
        const executions = executionNodes.map(issue => deriveExecution({
            issue, trace: links[this.selectedScope(issue.id)] || {}, mapping,
            requests: requests.filter(r => r.nodeId === issue.id), jiraStale: Boolean(this.error || issue.unverified),
        })).sort((a, b) => a.rank - b.rank || a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
        const connection = this.connection?.status();
        return {
            scope: this.site && this.project ? this.selectedScope() : null,
            site: this.site || null, project: this.project || null,
            sites: this.sites, appProjects: this.appProjects, catalogErrors: this.catalogErrors,
            retryAt: connection && !["ready", "standalone"].includes(connection.state) ? connection.nextCheckAt : null,
            connection: connection ? { state: connection.state, reason: connection.reason, server: connection.server, connector: connection.connector, nextCheckAt: connection.nextCheckAt } : null,
            signIn: connection?.state === "signin" ? { server: connection.server, connector: connection.connector } : null,
            projects: this.site ? this.projectLists.get(this.site.id) || [] : [],
            issues: this.issues, tree: buildTree(this.issues),
            workingScope: this.workingScope, workingSetKey: this.site && this.project ? this.loadKey() : null,
            page: this.page, pageError: Object.values(this.pageErrors).join("\n") || null,
            scopeError: this.pageErrors.scope || null,
            jiraRefreshing: Boolean(this.jiraRefreshing),
            workingSetGeneration: this.refreshGeneration,
            ancestorWarnings: [...this.linkedWarnings, ...this.ancestorWarnings],
            statuses: this.site && this.project ? projectStatuses(this.statuses, this.issues.filter(issue => issue.projectId === this.project.id)) : [],
            mapping, links, requests, executions,
            preferences: this.site && this.project ? data.preferences?.[this.selectedScope()] || {} : {},
            navigationReceipts: this.hostActions?.snapshot?.() || [],
            fetchedAt: this.fetchedAt || null, stale: Boolean(this.error), error: this.error,
            cached: this.cached, warming: this.warming, backgroundError: this.backgroundError,
            refreshing: this.pending.size > 0 || this.executionRefreshes.size > 0,
        };
    }
    async applyScope(input) {
        const definition = validateScope(input), scope = this.selectedScope();
        scopeJql(this.project.id, definition);
        const cloudId = this.site.id, projectId = this.project.id;
        const generation = await this.afterScopeCommit(() => {
            if (scope !== this.currentScope()) return null;
            return this.jiraRefreshing = ++this.refreshGeneration;
        });
        if (generation === null) return { ...await this.snapshot(), applyResult: { status: "superseded" } };
        const current = () => generation === this.refreshGeneration && scope === this.currentScope();
        try {
            const result = await this.readWorkingSet(cloudId, projectId, definition, true);
            if (!current()) return { ...await this.snapshot(), applyResult: { status: "superseded" } };
            // Once persistence begins, later scope mutations wait until disk and memory agree.
            let release;
            this.scopeCommit = new Promise(resolve => { release = resolve; });
            try {
                await this.store.update(data => {
                    if (!current()) return;
                    data.preferences ||= {};
                    data.preferences[scope] = { ...data.preferences[scope], workingScope: definition };
                });
                // The scope is already on disk: an unreadable store must not leave memory on the old scope.
                const data = await this.committedState().catch(() => null);
                this.workingScope = definition;
                this.installWorkingSet(this.keepTracked(result, data));
            } finally {
                this.scopeCommit = null;
                release();
            }
            await this.saveWorkingSet();
        } catch (error) {
            if (current()) this.pageErrors.scope = `Scope was not applied: ${error.message}. Previous scope and loaded data retained.`;
        } finally {
            if (this.jiraRefreshing === generation) this.jiraRefreshing = null;
        }
        return { ...await this.snapshot(), applyResult: { status: !current() ? "superseded" : this.pageErrors.scope ? "failed" : "applied" } };
    }
    async saveWorkingSet() {
        const key = this.loadKey(), cloudId = this.site.id, jiraProjectId = this.project.id;
        const entry = {
            issues: this.issues, statuses: this.statuses, fetchedAt: this.fetchedAt,
            page: this.page, ancestorWarnings: this.ancestorWarnings, linkedWarnings: this.linkedWarnings,
        };
        await this.remember(data => {
            data.issues[key] = entry;
            data.lastScope = { cloudId, jiraProjectId };
        });
    }
    async withAncestors(cloudId, seeds, existing, options, attemptedParents = []) {
        if (!this.gateway.ancestors) return { issues: seeds, warnings: [], attemptedParents };
        const parents = await this.gateway.ancestors(cloudId, seeds, {
            ...options, existing, attemptedParents, read: operation => this.jira(operation, options.fresh),
        });
        return { issues: mergeIssues(seeds, parents.issues), warnings: parents.warnings,
            attemptedParents: parents.attemptedParents || attemptedParents, connectionError: parents.connectionError };
    }
    async readWorkingSet(cloudId, projectId, definition, fresh) {
        const read = await this.jira(options => this.gateway.issues(cloudId, projectId, { ...options, scope: definition }), fresh);
        const tracked = await this.trackedWork(cloudId, projectId, read.issues, fresh);
        const seeds = mergeIssues(tracked.issues, read.issues);
        // After a connection failure, skip further reads: one succeeding would clear the failure it should report.
        const context = tracked.connectionError ? { issues: seeds, warnings: [], attemptedParents: [], connectionError: tracked.connectionError }
            : await this.withAncestors(cloudId, seeds, [], { fresh });
        const statuses = !context.connectionError && this.gateway.statuses
            ? await this.jira(options => this.gateway.statuses(cloudId, projectId, options), fresh).catch(() => null) : null;
        return { ...read, ...context, linkedWarnings: tracked.warnings, checked: tracked.checked, loaded: read.issues.length, statuses };
    }
    // Issues with linked sessions or PRs, or an unresolved launch request, stay in the execution queue whatever
    // scope or page is loaded: a pending request must never vanish because its issue is off the current page.
    async trackedWork(cloudId, projectId, loaded, fresh) {
        const none = { issues: [], warnings: [], checked: new Set() };
        if (!this.gateway.lookupIssues) return none;
        const have = new Set(loaded.map(issue => issue.id));
        const missing = [...trackedIds(await this.store.read(), `${[cloudId, projectId].map(encodeURIComponent).join("/")}/`)]
            .filter(id => !have.has(id));
        const wanted = missing.slice(0, 300);
        if (!wanted.length) return none;
        const warnings = missing.length > wanted.length ? [`${missing.length - wanted.length} linked items exceed the 300-item limit and are not loaded.`] : [];
        try {
            const issues = await this.jira(options => this.gateway.lookupIssues(cloudId, projectId, wanted, options), fresh);
            const found = new Set(issues.map(issue => issue.id)), unavailable = wanted.filter(id => !found.has(id)).length;
            if (unavailable) warnings.push(`${unavailable} linked items are missing, restricted or moved and are not shown.`);
            return { issues: issues.map(issue => ({ ...issue, tracked: true })), warnings, checked: new Set(wanted) };
        } catch (error) {
            return { ...none, warnings: [...warnings, `Linked work lookup failed: ${error.message}. Previously loaded linked items are kept.`],
                connectionError: error.kind && error.kind !== "permanent" ? error.message : undefined };
        }
    }
    // Keep linked items the new read could not confirm (a failed lookup, or a request or link committed while Jira
    // was being read) from the current working set, rather than drop them until the next refresh.
    keepTracked(result, data) {
        if (!data) return result;
        const ids = trackedIds(data, `${[this.site.id, this.project.id].map(encodeURIComponent).join("/")}/`);
        const own = issue => issue.projectId === this.project.id && ids.has(issue.id);
        // A same-project parent read as context during this read becomes linked work once it is linked.
        let issues = result.issues.map(issue => {
            if (!issue.contextOnly || !own(issue)) return issue;
            const { contextOnly, ...work } = issue;
            return { ...work, tracked: true };
        });
        const have = new Set(issues.map(issue => issue.id));
        const kept = this.issues.filter(issue => !issue.contextOnly && own(issue) && !have.has(issue.id) && !result.checked?.has(issue.id));
        // Not re-read by this Jira read: still shown, but stale and unable to start work until a later read confirms them.
        if (kept.length) issues = mergeIssues(issues, kept.map(issue => ({ ...issue, tracked: true, unverified: true })));
        return { ...result, issues };
    }
    installWorkingSet(result) {
        this.issues = result.issues;
        this.page = { nextPageToken: result.nextPageToken || null, total: result.total ?? null, loaded: result.loaded, cursors: [] };
        this.ancestorWarnings = result.warnings;
        this.linkedWarnings = result.linkedWarnings || [];
        this.attemptedParents = result.attemptedParents;
        this.pageErrors = {};
        this.previews.clear();
        this.statuses = result.statuses || [];
        this.fetchedAt = result.fetchedAt;
        this.error = result.connectionError || null;
        this.cached = false;
    }
    async savePreferences({ scope, preferences }) {
        if (scope !== this.selectedScope()) throw new Error("The project scope changed; preferences were not saved.");
        if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("Preferences must be an object.");
        const allowed = {
            view: v => ["execution", "hierarchy"].includes(v),
            executionFilter: v => ["all", "needs-me", "running", "prs", "available"].includes(v),
            selected: v => v === null || typeof v === "string" && v.length <= 100,
            collapsed: v => Array.isArray(v) && v.length <= 10000 && v.every(id => typeof id === "string" && id.length <= 100),
            query: v => typeof v === "string" && v.length <= 500,
            category: v => ["all", "new", "indeterminate", "done"].includes(v) || typeof v === "string" && v.startsWith("status:") && v.length > 7 && v.length <= 207,
            sprint: v => typeof v === "string" && /^(?:all|none|sprint:.{1,100})$/s.test(v),
            scrollTop: v => Number.isFinite(v) && v >= 0 && v <= 10000000,
            detailsOpen: v => typeof v === "boolean",
        };
        for (const [key, value] of Object.entries(preferences)) if (!Object.hasOwn(allowed, key) || !allowed[key](value))
            throw new Error(`Invalid preference: ${key}`);
        await this.store.update(data => {
            data.preferences ||= {};
            data.preferences[scope] = { ...data.preferences[scope], ...preferences };
        });
        return { status: "saved", scope };
    }
    async refresh({ fresh = false } = {}) {
        if (!this.site || !this.project) return this.snapshot();
        const scope = this.loadKey();
        const generation = await this.afterScopeCommit(() => {
            if (!this.currentScope() || scope !== this.loadKey()) return null;
            return this.jiraRefreshing = ++this.refreshGeneration;
        });
        if (generation === null) return this.snapshot();
        const definition = this.workingScope;
        const current = () => generation === this.refreshGeneration && this.currentScope() && scope === this.loadKey();
        try {
            const { id: cloudId } = this.site, { id: projectId } = this.project;
            const result = await this.readWorkingSet(cloudId, projectId, definition, fresh);
            if (!current()) return this.snapshot();
            const data = await this.committedState();
            if (!current()) return this.snapshot();
            this.installWorkingSet(this.keepTracked(result, data));
            await this.saveWorkingSet();
        } catch (error) {
            if (current()) this.error = error.message;
        } finally {
            if (this.jiraRefreshing === generation) this.jiraRefreshing = null;
        }
        return this.snapshot();
    }
    async loadMore() {
        if (!this.page.nextPageToken) return this.snapshot();
        if (this.jiraRefreshing) throw new Error("Wait for the first scope page to finish refreshing before loading more.");
        const key = this.loadKey(), generation = this.refreshGeneration, target = "working-set";
        if (this.pageLoads.has(generation)) return this.pageLoads.get(generation);
        const { id: cloudId } = this.site, { id: projectId } = this.project;
        const definition = this.workingScope, before = this.page, existing = this.issues, attemptedParents = this.attemptedParents;
        const cursor = before.nextPageToken;
        const current = () => generation === this.refreshGeneration && this.currentScope() && key === this.loadKey();
        const pending = (async () => {
            let outcome = { target, status: "superseded", error: null };
            try {
                const read = await this.jira(options => this.gateway.issues(cloudId, projectId, { ...options, scope: definition, cursor }), true);
                // Every loaded item is a seed, so parents whose lookup failed on an earlier page are retried; resolved
                // and confirmed-missing parents are skipped.
                const context = await this.withAncestors(cloudId, mergeIssues(existing, read.issues), existing, { fresh: true }, attemptedParents);
                if (!current()) return { ...await this.snapshot(), pageResult: outcome };
                if (read.nextPageToken && [cursor, ...(before.cursors || [])].includes(read.nextPageToken))
                    throw new Error("Jira pagination repeated a cursor; loaded data was preserved.");
                this.issues = mergeIssues(this.issues, context.issues);
                this.page = { nextPageToken: read.nextPageToken || null, total: read.total ?? before.total ?? null,
                    loaded: this.issues.filter(issue => !issue.contextOnly && !issue.tracked).length,
                    cursors: [...(before.cursors || []), cursor] };
                // Every unresolved parent was just re-attempted, so these warnings replace the earlier ones.
                this.ancestorWarnings = context.warnings;
                if (context.connectionError) this.error = context.connectionError;
                delete this.pageErrors[target];
                this.attemptedParents = [...new Set([...this.attemptedParents, ...context.attemptedParents])];
                this.previews.clear();
                // Installed: a refresh that starts while this saves does not make the page any less loaded.
                outcome = { target, status: "loaded", error: null };
                await this.saveWorkingSet();
            } catch (error) {
                if (current()) {
                    const message = `Load more: ${error.message}`;
                    this.pageErrors[target] = message;
                    outcome = { target, status: "failed", error: message };
                }
            }
            return { ...await this.snapshot(), pageResult: outcome };
        })();
        this.pageLoads.set(generation, pending);
        try { return await pending; }
        finally { this.pageLoads.delete(generation); }
    }
    // Delegates: F-owned; C must not edit; L may append clearRequest
    prepare(input) { return this.inSession(() => this.launches.prepare(input)); }
    launch(input) { return this.inSession(() => this.launches.launch(input)); }
    syncJira() { return this.inSession(() => this.launches.syncJira()); }
    recordSession(input) { return this.launches.recordSession(input); }
    failRequest(input) { return this.launches.failRequest(input); }
    refreshExecution(options) { return this.inSession(() => this.trace.refreshExecution(options)); }
    refreshTrace(nodeId) { return this.inSession(() => this.trace.refreshTrace(nodeId)); }
    attach(scope, sessionId, projectId, requestId) { return this.trace.attach(scope, sessionId, projectId, requestId); }
    linkSession(input) { return this.inSession(() => this.trace.linkSession(input)); }
    openSession(input) { return this.inSession(() => this.trace.openSession(input)); }
    openPr(input) { return this.inSession(() => this.trace.openPr(input)); }
    clearRequest(input) { return this.launches.clearRequest(input); }
}

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCOPE, scopeJql, validateScope, workingSetKey, mergeIssues } from "../lib/scope.mjs";
import { workingSetSummary, scopeLabel } from "../lib/view-model.mjs";
import { buildTree, normalizeIssue, descendants } from "../lib/model.mjs";
import { descendantSessionCounts } from "../lib/view-model.mjs";
import { Workbench } from "../lib/workbench.mjs";
import { Gateway } from "../lib/gateway.mjs";
import { Connection } from "../lib/connection.mjs";

const row = (id, extra = {}) => ({ id, key: `DEMO-${id}`, projectId: "42", summary: `Work ${id}`, level: 0, status: "To Do", category: "new", dependencies: [], labels: [], ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
    let data = { mappings: {}, links: {}, requests: {}, preferences: {} };
    const store = { read: async () => structuredClone(data), update: async change => { const next = structuredClone(data); change(next); data = next; } };
    const gateway = {
        issues: async () => ({ issues: [row("1")], nextPageToken: "second", fetchedAt: "2026-01-01T00:00:00Z" }),
        ancestors: async () => ({ issues: [row("10", { key: "PARENT-10", projectId: "43", level: 1, type: "Feature", contextOnly: true })], warnings: [] }),
    };
    const wb = new Workbench({ store, gateway });
    wb.site = { id: "demo-site", name: "Example", url: "https://example.atlassian.net" };
    wb.project = { id: "42", key: "DEMO", name: "Example project" };
    return { wb, gateway, store };
}

test("scope builds project-constrained server JQL without corrupting quoted ORDER BY", () => {
    assert.equal(scopeJql("42"), "project = 42 ORDER BY updated DESC, key DESC");
    assert.equal(scopeJql("42", { kind: "filter", value: "123" }), "project = 42 AND (filter = 123) ORDER BY updated DESC, key DESC");
    assert.equal(scopeJql("42", { kind: "jql", value: 'text ~ "ORDER BY" ORDER BY updated DESC, key ASC' }), 'project = 42 AND (text ~ "ORDER BY") ORDER BY updated DESC, key ASC');
    assert.equal(scopeJql("42", { kind: "jql", value: "status = Open OR status = Closed" }), "project = 42 AND (status = Open OR status = Closed) ORDER BY updated DESC, key DESC");
    assert.equal(scopeJql("42", { kind: "jql", value: "status = Open ORDER BY key ASC" }), "project = 42 AND (status = Open) ORDER BY key ASC", "an explicit sort is kept");
    assert.throws(() => scopeJql("42 OR project = 43"), /numeric/);
    assert.throws(() => scopeJql("42", { kind: "jql", value: "status = Open) OR project = 43 OR (status = Closed" }), /unmatched/);
    assert.throws(() => scopeJql("42", { kind: "jql", value: 'summary ~ "unclosed' }), /unclosed/);
    assert.throws(() => validateScope({ kind: "filter", value: "123 OR 1=1" }), /numeric/);
    assert.throws(() => validateScope({ kind: "jql", value: "" }), /expression/);
    assert.throws(() => validateScope({ kind: "jql", value: "x".repeat(4001) }), /4,000/);
    assert.notEqual(workingSetKey("site/42/project", DEFAULT_SCOPE), workingSetKey("site/42/project", { kind: "filter", value: "123" }));
});

test("scope is explicitly applied, durable and separate from project trace/mapping identities", async () => {
    const { wb, store } = fixture();
    const projectScope = wb.selectedScope();
    await assert.rejects(wb.applyScope({ kind: "filter", value: "12 OR 1=1" }), /numeric/);
    assert.deepEqual(wb.workingScope, DEFAULT_SCOPE);
    assert.equal(wb.issues.length, 0);
    await wb.applyScope({ kind: "filter", value: "123" });
    assert.equal(wb.workingScope.value, "123");
    assert.equal(wb.selectedScope(), projectScope);
    assert.equal((await store.read()).preferences[projectScope].workingScope.value, "123");
    const reopened = new Workbench({ store, gateway: wb.gateway });
    reopened.site = wb.site; reopened.project = wb.project;
    await reopened.restoreScope();
    assert.deepEqual(reopened.workingScope, wb.workingScope);
});

test("a failed scope save keeps the prior working set and reports the persistence failure", async () => {
    const { wb, store } = fixture();
    await wb.refresh();
    store.update = async () => { throw new Error("Disk is full"); };
    assert.match((await wb.applyScope({ kind: "filter", value: "123" })).pageError, /Disk is full/);
    assert.deepEqual(wb.workingScope, DEFAULT_SCOPE);
    assert.equal(wb.issues[0].id, "1");
    assert.equal(wb.jiraRefreshing, null);
});

test("scope-aware warm caches never mix pages and scope changes preserve durable artifacts", async () => {
    const { wb, store } = fixture();
    let cached = { issues: {} };
    wb.cache = {
        read: async () => structuredClone(cached),
        update: async change => { change(cached); },
    };
    await store.update(data => {
        data.mappings[wb.selectedScope()] = { id: "repo", repo: "example/demo" };
        data.links[wb.selectedScope("1")] = { sessions: [{ id: "session" }], prs: [] };
        data.requests.queued = { scope: wb.selectedScope("1"), nodeId: "1", status: "queued" };
    });
    const durable = await store.read();
    await wb.refresh();
    const projectKey = wb.loadKey();
    await wb.applyScope({ kind: "filter", value: "123" });
    assert.notEqual(wb.loadKey(), projectKey);
    assert.equal(Object.keys(cached.issues).length, 2);
    const saved = await store.read();
    assert.deepEqual(saved.mappings, durable.mappings);
    assert.deepEqual(saved.links, durable.links);
    assert.deepEqual(saved.requests, durable.requests);
    cached.catalog = { sites: [wb.site], appProjects: [] };
    cached.projectLists = { [wb.site.id]: { projects: [wb.project] } };
    const reopened = new Workbench({ store, cache: wb.cache });
    assert.equal(await reopened.hydrate(), true);
    assert.equal(reopened.workingScope.value, "123");
    assert.equal(reopened.page.nextPageToken, "second");
    assert.equal(reopened.cached, true);
});

test("late scope, refresh and page responses cannot mix working sets, including A-B-A switches", async () => {
    const { wb, gateway } = fixture();
    const old = deferred(), entered = deferred();
    gateway.issues = async (site, project, options) => {
        if (options.scope.value === "old") { entered.resolve(); return old.promise; }
        return { issues: [row("2")], fetchedAt: "new" };
    };
    const pending = wb.applyScope({ kind: "jql", value: "old" });
    await entered.promise;
    await wb.applyScope({ kind: "jql", value: "new" });
    old.resolve({ issues: [row("1")], nextPageToken: "old-cursor", fetchedAt: "old" });
    await pending;
    assert.deepEqual(wb.issues.filter(issue => !issue.contextOnly).map(issue => issue.id), ["2"]);
    assert.equal(wb.page.nextPageToken, null);
    const more = deferred();
    gateway.issues = async (site, project, options) => options.cursor ? more.promise : { issues: [row("2")], nextPageToken: "next", fetchedAt: "new" };
    await wb.applyScope({ kind: "jql", value: "new" });
    const page = wb.loadMore();
    await wb.applyScope({ kind: "jql", value: "different" });
    await wb.applyScope({ kind: "jql", value: "new" });
    more.resolve({ issues: [row("99")], nextPageToken: null });
    assert.equal((await page).pageResult.status, "superseded");
    assert.ok(!wb.issues.some(issue => issue.id === "99"));
    assert.equal(wb.page.nextPageToken, "next");
});

test("pages are explicit, share duplicate clicks and preserve useful data and cursor on failure", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    assert.equal(wb.page.loaded, 1);
    assert.equal(wb.issues.length, 2);
    let reads = 0;
    const page = deferred();
    gateway.issues = async (site, project, options) => {
        reads++;
        assert.equal(options.cursor, "second");
        return page.promise;
    };
    const first = wb.loadMore(), duplicate = wb.loadMore();
    page.resolve({ issues: [row("2")], nextPageToken: null });
    await Promise.all([first, duplicate]);
    assert.equal(reads, 1);
    assert.equal(wb.page.loaded, 2);
    assert.equal(wb.page.nextPageToken, null);
    await wb.loadMore();
    assert.equal(reads, 1);
    wb.page.nextPageToken = "failed";
    gateway.issues = async () => { throw new Error("503 unavailable"); };
    const failed = await wb.loadMore();
    assert.equal(failed.issues.length, 3);
    assert.match(failed.pageError, /503/);
    assert.equal(failed.page.nextPageToken, "failed");
    assert.equal(failed.stale, false, "a failed append does not invalidate already loaded Jira items");
});

test("referenced ancestors are context only until a scope page returns them", async () => {
    const { wb } = fixture();
    await wb.refresh();
    assert.equal(wb.issues.find(issue => issue.id === "10").contextOnly, true);
    assert.equal(wb.page.loaded, 1, "context does not inflate scope totals");
    await assert.rejects(wb.prepare({ nodeId: "10" }), /context only/);
    const promoted = mergeIssues(wb.issues, [row("10")]);
    assert.equal(promoted.find(issue => issue.id === "10").contextOnly, undefined, "a later matching scope page promotes context to work");
    assert.ok(mergeIssues(promoted, [row("10", { contextOnly: true })]).find(issue => issue.id === "10").contextOnly !== true);
});

for (const failing of [["PARENT-10", "PORT-20"], ["PORT-20"]]) {
    test(`Load more retries parent lookups an earlier page could not complete (${failing.join(", ")})`, async () => {
        const { wb } = fixture();
        const gateway = new Gateway({});
        gateway.issues = async (site, project, options) => options.cursor
            ? { issues: [row("2")], nextPageToken: null, fetchedAt: "two" }
            : { issues: [row("1", { parentKey: "PARENT-10" })], nextPageToken: "second", fetchedAt: "one" };
        const parents = {
            "PARENT-10": row("10", { key: "PARENT-10", projectId: "43", level: 1, parentKey: "PORT-20" }),
            "PORT-20": row("20", { key: "PORT-20", projectId: "44", level: 2 }),
        };
        let outage = true;
        gateway.issuePage = async (cloudId, jql) => {
            const keys = [...jql.matchAll(/"([A-Z]+-\d+)"/g)].map(match => match[1]);
            if (outage && keys.some(key => failing.includes(key))) throw new Error("Parent lookup outage");
            return { issues: keys.map(key => parents[key]).filter(Boolean), nextPageToken: null };
        };
        wb.gateway = gateway;
        await wb.refresh();
        assert.ok(!wb.issues.some(issue => issue.key === "PORT-20"));
        assert.ok(wb.ancestorWarnings.some(warning => /Parent lookup outage/.test(warning)));
        outage = false;
        await wb.loadMore();
        assert.deepEqual(wb.issues.filter(issue => issue.contextOnly).map(issue => issue.key).sort(), ["PARENT-10", "PORT-20"],
            "the unrelated second page still resolves the earlier failed chain");
        assert.deepEqual(wb.ancestorWarnings, [], "a resolved retry clears the earlier failure");
    });
}

test("repeated continuation cycles and overlapping refreshes cannot append stale pages", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    gateway.issues = async () => ({ issues: [row("2")], nextPageToken: "third" });
    await wb.loadMore();
    gateway.issues = async () => ({ issues: [row("3")], nextPageToken: "second" });
    const repeated = await wb.loadMore();
    assert.match(repeated.pageError, /repeated a cursor/);
    assert.ok(!repeated.issues.some(issue => issue.id === "3"));
    const page = deferred();
    gateway.issues = () => page.promise;
    const refresh = wb.refresh();
    await assert.rejects(wb.loadMore(), /first scope page/);
    page.resolve({ issues: [row("4")], fetchedAt: "new" });
    await refresh;
    assert.equal(wb.page.nextPageToken, null);
    assert.ok(wb.issues.some(issue => issue.id === "4"));
    assert.ok(!wb.issues.some(issue => issue.id === "2"));
});

test("missing and id-only parents use explicit placeholders; hierarchy names come from metadata", () => {
    const child = normalizeIssue({ id: "2", key: "DEMO-2", fields: {
        issuetype: { name: "Task", hierarchyLevel: 0 }, parent: { id: "10", fields: { issuetype: { name: "Feature", hierarchyLevel: 1 } } },
    } });
    const missing = buildTree([child]);
    assert.equal(missing.roots[0].issue.missing, true);
    assert.equal(missing.roots[0].issue.type, "Feature");
    assert.equal(missing.roots[0].children[0].issue.id, "2");
    const resolved = buildTree([child, row("10", { key: "PARENT-10", type: "Feature", level: 1 })]);
    assert.equal(resolved.roots.length, 1);
    assert.equal(resolved.roots[0].issue.key, "PARENT-10");
    assert.equal(resolved.roots[0].children[0].issue.id, "2");
});

test("loaded counts and row labels do not imply complete project totals", async () => {
    const { wb } = fixture();
    await wb.refresh();
    const state = await wb.snapshot();
    assert.match(workingSetSummary(state), /1 scope items loaded; 1 context items.*More scope results remain/);
    assert.match(workingSetSummary(state), /not complete child totals/);
    assert.equal(state.executions.length, 1, "ancestors do not become execution work");
    assert.equal(scopeLabel(row("1")), "");
    assert.equal(scopeLabel(row("1", { contextOnly: true })), "Context only");
    assert.equal(scopeLabel(row("1", { contextOnly: true, missing: true })), "Missing / restricted");
    assert.equal(scopeLabel(row("1", { tracked: true })), "Linked, outside scope");
});

test("linked and pending work stays in the execution queue when it is outside the loaded scope page", async () => {
    const { wb, gateway, store } = fixture();
    const asked = [];
    gateway.lookupIssues = async (cloudId, projectId, ids) => {
        asked.push({ cloudId, projectId, ids });
        return ids.filter(id => id !== "9").map(id => row(id));
    };
    await store.update(data => {
        data.requests.queued = { requestId: "queued", scope: wb.selectedScope("8"), nodeId: "8", status: "queued", at: new Date().toISOString() };
        data.requests.cleared = { requestId: "cleared", scope: wb.selectedScope("6"), nodeId: "6", status: "cancelled", at: new Date().toISOString() };
        data.links[wb.selectedScope("7")] = { sessions: [{ id: "session-7" }], prs: [] };
        data.links[wb.selectedScope("1")] = { sessions: [{ id: "session-1" }], prs: [] };
        data.links[wb.selectedScope("5")] = { sessions: [], prs: [] };
        data.links["demo-site/43/4"] = { sessions: [{ id: "other-project" }], prs: [] };
        data.links[wb.selectedScope("9")] = { sessions: [], prs: [{ repo: "example/demo", number: 1 }] };
    });
    const state = await wb.refresh();
    assert.deepEqual(asked, [{ cloudId: "demo-site", projectId: "42", ids: ["8", "7", "9"] }], "pending requests first; loaded, empty, cleared and other-project entries are not read");
    assert.deepEqual(state.executions.map(execution => execution.nodeId).sort(), ["1", "7", "8"]);
    assert.equal(state.issues.find(issue => issue.id === "7").tracked, true);
    assert.match(workingSetSummary(state), /1 scope items loaded; 1 context items; 2 linked items outside the loaded pages\./);
    assert.ok(state.ancestorWarnings.some(warning => /1 linked items are missing, restricted or moved/.test(warning)));

    gateway.issues = async () => ({ issues: [row("7")], nextPageToken: null, fetchedAt: "2026-01-01T00:01:00Z" });
    const more = await wb.loadMore();
    assert.equal(more.issues.find(issue => issue.id === "7").tracked, undefined, "a scope page promotes linked work to a scope item");
    assert.equal(more.page.loaded, 2);
    assert.match(workingSetSummary(more), /2 scope items loaded; 1 context items; 1 linked items outside the loaded pages\./);
});

test("a failed linked-work lookup keeps loaded linked items, and a connection failure stays visible", async () => {
    const { wb, gateway, store } = fixture();
    await store.update(data => { data.links[wb.selectedScope("7")] = { sessions: [{ id: "session-7" }], prs: [] }; });
    gateway.lookupIssues = async (cloudId, projectId, ids) => ids.map(id => row(id));
    await wb.refresh();
    assert.ok(wb.issues.some(issue => issue.id === "7" && issue.tracked));
    gateway.lookupIssues = async () => { throw new Error("lookup outage"); };
    let state = await wb.refresh();
    const kept = state.issues.find(issue => issue.id === "7");
    assert.ok(kept?.tracked && kept.unverified, "kept from the previous working set, but not re-read");
    assert.equal(scopeLabel(kept), "Linked, not re-read from Jira");
    assert.ok(state.executions.find(execution => execution.nodeId === "7").signals.some(signal => signal.kind === "jira_stale"));
    await assert.rejects(wb.prepare({ nodeId: "7" }), /did not re-read/);
    assert.equal(state.error, null);
    assert.ok(state.ancestorWarnings.some(warning => /Linked work lookup failed: lookup outage/.test(warning)));
    gateway.lookupIssues = async () => { throw Object.assign(new Error("Jira connection lost"), { kind: "transient" }); };
    let laterReads = 0;
    gateway.ancestors = async () => { laterReads++; return { issues: [], warnings: [] }; };
    gateway.statuses = async () => { laterReads++; return []; };
    state = await wb.refresh();
    assert.equal(state.error, "Jira connection lost");
    assert.equal(laterReads, 0, "no later read can clear the connection failure");
    assert.ok(state.issues.some(issue => issue.id === "7"));
});

test("a same-project parent linked while Jira is read becomes linked work, not context", async () => {
    const { wb, gateway } = fixture();
    gateway.issues = async () => ({ issues: [row("1", { parentKey: "DEMO-10" })], fetchedAt: "now" });
    gateway.ancestors = async () => {
        // The link lands after the linked-work lookup has read the store.
        await wb.commit(data => { data.links[wb.selectedScope("10")] = { sessions: [{ id: "session-10" }], prs: [] }; });
        return { issues: [row("10", { key: "DEMO-10", level: 1, contextOnly: true })], warnings: [] };
    };
    const state = await wb.refresh();
    const parent = state.issues.find(issue => issue.id === "10");
    assert.equal(parent.contextOnly, undefined);
    assert.equal(parent.tracked, true);
    assert.ok(state.executions.some(execution => execution.nodeId === "10"));
});

test("an issue linked while Apply reads Jira stays in the new working set", async () => {
    const { wb, gateway, store } = fixture();
    gateway.lookupIssues = async (cloudId, projectId, ids) => ids.map(id => row(id));
    gateway.issues = async () => ({ issues: [row("1"), row("5")], fetchedAt: "one" });
    await wb.refresh();
    const reading = deferred(), releaseRead = deferred(), releaseWrite = deferred();
    gateway.issues = async () => { reading.resolve(); await releaseRead.promise; return { issues: [row("1")], fetchedAt: "two" }; };
    const apply = wb.applyScope({ kind: "jql", value: "key = DEMO-1" });
    await reading.promise;
    const original = store.update;
    const link = data => { data.requests.r = { requestId: "r", scope: wb.selectedScope("5"), nodeId: "5", status: "queued", at: new Date().toISOString() }; };
    store.update = async change => { if (change === link) await releaseWrite.promise; return original(change); };
    const write = wb.commit(link);
    releaseRead.resolve();
    while (!wb.scopeCommit) await new Promise(resolve => setImmediate(resolve));
    releaseWrite.resolve();
    await Promise.all([apply, write]);
    assert.equal(wb.workingScope.value, "key = DEMO-1");
    assert.ok(wb.issues.some(issue => issue.id === "5" && issue.tracked), "the request committed during staging keeps its issue");
    assert.ok((await wb.snapshot()).executions.some(execution => execution.nodeId === "5"));
});

test("linked work lookup failures and its 300-item limit are reported without hiding the scope page", async () => {
    const { wb, gateway, store } = fixture();
    let asked;
    gateway.lookupIssues = async (cloudId, projectId, ids) => { asked = ids; throw new Error("lookup outage"); };
    await store.update(data => {
        for (let id = 100; id < 405; id++) data.links[wb.selectedScope(String(id))] = { sessions: [{ id: `session-${id}` }], prs: [] };
    });
    const state = await wb.refresh();
    assert.equal(asked.length, 300);
    assert.ok(state.issues.some(issue => issue.id === "1"));
    assert.equal(state.error, null);
    assert.ok(state.ancestorWarnings.some(warning => /5 linked items exceed the 300-item limit/.test(warning)));
    assert.ok(state.ancestorWarnings.some(warning => /Linked work lookup failed: lookup outage/.test(warning)));
});

test("execution evidence reads every linked trace of the project's own issues, never context from elsewhere", async () => {
    const { wb, store } = fixture();
    wb.issues = [row("1"), row("2", { tracked: true }), row("9", { projectId: "43", contextOnly: true }), row("8", { projectId: "", contextOnly: true })];
    await store.update(data => {
        for (const id of ["project", "1", "2", "8", "9"]) data.links[wb.selectedScope(id)] = { sessions: [], prs: [] };
    });
    const read = [];
    wb.trace.collectTrace = async ({ scope }) => { read.push(scope); return {}; };
    store.update = async () => { throw new Error("collection complete"); };
    await assert.rejects(wb.refreshExecution(), /collection complete/);
    assert.deepEqual(read.sort(), ["project", "1", "2"].map(id => wb.selectedScope(id)).sort());
});

test("failed scope reads preserve the applied definition, pages and persisted preferences", async () => {
    const { wb, gateway, store } = fixture();
    await wb.applyScope({ kind: "filter", value: "123" });
    const previous = await wb.snapshot();
    let reads = 0;
    gateway.issues = async () => { reads++; throw new Error("Invalid Jira field"); };
    await assert.rejects(wb.applyScope({ kind: "jql", value: 'text ~ "unterminated' }), /unclosed/);
    assert.equal(reads, 0);
    const failed = await wb.applyScope({ kind: "jql", value: "badField = yes" });
    assert.match(failed.pageError, /Scope was not applied.*Invalid Jira field/);
    assert.deepEqual(failed.issues, previous.issues);
    assert.deepEqual(failed.page, previous.page);
    assert.deepEqual(failed.workingScope, previous.workingScope);
    assert.deepEqual((await store.read()).preferences[wb.selectedScope()].workingScope, previous.workingScope);
});

test("scope commit completion is a disk/memory boundary before a failing successor starts", async () => {
    const { wb, store, gateway } = fixture();
    const original = store.update;
    const entered = deferred(), release = deferred();
    store.update = async change => {
        const result = await original(change);
        entered.resolve();
        await release.promise;
        return result;
    };
    const old = wb.applyScope({ kind: "filter", value: "111" });
    await entered.promise;
    gateway.issues = async () => { throw new Error("successor read failed"); };
    const newer = wb.applyScope({ kind: "filter", value: "222" });
    assert.deepEqual(wb.workingScope, DEFAULT_SCOPE);
    release.resolve();
    const [committed, failed] = await Promise.all([old, newer]);
    assert.notEqual(committed.applyResult.status, "failed");
    assert.equal(failed.applyResult.status, "failed");
    assert.equal(wb.workingScope.value, "111");
    assert.equal((await store.read()).preferences[wb.selectedScope()].workingScope.value, "111");
});

test("a page installed before a later refresh still reports that it loaded", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    const saving = deferred(), release = deferred();
    wb.cache = { update: async () => { saving.resolve(); await release.promise; } };
    gateway.issues = async (site, project, options) => options.cursor
        ? { issues: [row("2")], nextPageToken: null, fetchedAt: "two" }
        : (() => { throw new Error("Refresh outage"); })();
    const more = wb.loadMore();
    await saving.promise;
    const refresh = wb.refresh();
    release.resolve();
    const [page] = await Promise.all([more, refresh]);
    assert.equal(page.pageResult.status, "loaded");
    assert.ok(page.issues.some(issue => issue.id === "2"), "the failed refresh kept the appended page");
});

test("a failed Apply keeps its error after a later page loads", async () => {
    const { wb, gateway } = fixture();
    await wb.refresh();
    const read = gateway.issues;
    gateway.issues = async () => { throw new Error("Invalid Jira field"); };
    await wb.applyScope({ kind: "jql", value: "badField = yes" });
    gateway.issues = async (...args) => args[2].cursor ? { issues: [row("2")], nextPageToken: null } : read(...args);
    const page = await wb.loadMore();
    assert.equal(page.pageResult.status, "loaded");
    assert.match(page.pageError, /Scope was not applied.*Invalid Jira field/);
});

test("id-only ancestry is consistent in descendant enumeration, counts and brief parent sources", async () => {
    const { wb } = fixture();
    const parent = row("10", { level: 1, type: "Feature" });
    const child = row("2", { parentKey: "id:10", parentId: "10" });
    wb.issues = [parent, child, row("3", { parentKey: "id:2", parentId: "2" })];
    assert.deepEqual(descendants(wb.issues, "10").map(issue => issue.id), ["2", "3"]);
    assert.equal(descendantSessionCounts(wb.issues, id => id === "3" ? ["session"] : []).get("10"), 1);
    const brief = wb.launches.makeBrief(child, "plan", {}, { id: "repo", repo: "example/demo" });
    assert.ok(brief.sources.some(source => source.key === parent.key));
});

test("foreign context cannot read, write or navigate traces under the selected project", async () => {
    const { wb } = fixture();
    await wb.refresh();
    wb.issues.push(row("11", { projectId: "", contextOnly: true }));
    for (const nodeId of ["10", "11"]) {
        await assert.rejects(wb.linkSession({ nodeId, sessionId: "session" }), /own Jira project/);
        await assert.rejects(wb.refreshTrace(nodeId), /own Jira project/);
        await assert.rejects(wb.openSession({ nodeId, sessionId: "session" }), /own Jira project/);
        await assert.rejects(wb.openPr({ nodeId, repo: "example/demo", number: 1 }), /own Jira project/);
    }
});

test("an older pick delayed in cache cannot refresh a new project before its scope is restored", async () => {
    const { wb, store, gateway } = fixture();
    wb.sites = [wb.site];
    wb.projectLists.set(wb.site.id, [wb.project, { id: "43", key: "ALT" }]);
    wb.verified.sites = true;
    wb.verified.lists.add(wb.site.id);
    await store.update(data => { data.preferences = {
        [wb.selectedScope()]: { workingScope: { kind: "filter", value: "111" } },
        "demo-site/43/project": { workingScope: { kind: "filter", value: "222" } },
    }; });
    const cached = deferred(), releaseCache = deferred(), reading = deferred(), releaseRead = deferred();
    let cacheWrites = 0;
    wb.cache = { update: async () => { if (!cacheWrites++) { cached.resolve(); await releaseCache.promise; } } };
    const originalRead = store.read;
    store.read = async () => {
        const data = await originalRead();
        if (wb.project.id === "43" && wb.workingScope.kind === "project") { reading.resolve(); await releaseRead.promise; }
        return data;
    };
    const scopes = [];
    gateway.issues = async (site, project, options) => { scopes.push([project, options.scope.value]); return { issues: [], fetchedAt: "now" }; };
    const first = wb.pick({ cloudId: "demo-site", jiraProjectId: "42" });
    await cached.promise;
    const second = wb.pick({ cloudId: "demo-site", jiraProjectId: "43" });
    await reading.promise;
    releaseCache.resolve();
    assert.deepEqual(scopes, [], "superseded pick does not refresh the pending selection");
    releaseRead.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(scopes, [["43", "222"]]);
});

for (const kind of ["auth", "transient"]) {
    test(`a classified ${kind} ancestor failure reaches the supervisor without discarding working items`, async () => {
        const { wb } = fixture();
        const gateway = new Gateway({});
        gateway.issues = async () => ({ issues: [row("1", { parentKey: "PARENT-10" })], fetchedAt: "now" });
        gateway.issuePage = async () => { throw Object.assign(new Error("Parent connection failed"), { kind, needsSignIn: kind === "auth", server: "atlassian" }); };
        gateway.statuses = async () => { assert.fail("a later status read must not erase the parent connection failure"); };
        const connection = new Connection({}, { gateway });
        connection.current.state = "ready";
        wb.gateway = gateway;
        wb.connection = connection;
        const snapshot = await wb.refresh({ fresh: true });
        assert.equal(snapshot.issues[0].id, "1");
        assert.equal(snapshot.stale, true);
        assert.equal(snapshot.connection.state, kind === "auth" ? "signin" : "down");
        assert.match(snapshot.ancestorWarnings[0], /Parent connection failed/);
        connection.stop();
    });
}

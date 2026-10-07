import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, resolveToolResult } from "../lib/gateway.mjs";
import { isConnector, preferred, signInError } from "../lib/runtime.mjs";
import { CONNECTOR, fakeRuntime, PROJECTS } from "./fake-runtime.mjs";

const issue = (id, key, parent, type = "Story", category = "new") => ({
    id, key, fields: {
        summary: `Summary ${key}`, project: { id: "42", key: "DEMO" },
        issuetype: { name: type, hierarchyLevel: type === "Epic" ? 1 : type === "Subtask" ? -1 : 0 },
        status: { name: category === "done" ? "Accepted" : "To Do", statusCategory: { key: category } },
        parent: parent ? { key: parent } : undefined,
        labels: ["demo"], description: "Acceptance: keep existing behavior.",
    },
});

test("reads a runtime-spilled result only from a bounded owned temporary output file", async t => {
    const file = join(tmpdir(), `${Date.now()}-copilot-tool-output-${randomUUID().replaceAll("-", "")}.txt`);
    await writeFile(file, '{"sessions":[{"id":"one"}]}', { mode: 0o600 });
    t.after(() => unlink(file));
    const result = { resultType: "success", textResultForLlm: `Output too large to read at once (30 KB). Saved to: ${file}\nConsider using tools.` };
    assert.deepEqual(await resolveToolResult(result), { sessions: [{ id: "one" }] });
    await assert.rejects(resolveToolResult({ ...result, textResultForLlm: "Output too large to read at once. Saved to: /etc/passwd\n" }), /temporary|output file/i);
});


function runtime(respond) {
    return { rpc: { tools: {
        getCurrentMetadata: async () => ({ tools: [
            ...["getAccessibleAtlassianResources", "getVisibleJiraProjects", "searchJiraIssuesUsingJql", "getJiraIssue"]
                .map(name => ({ name: `atlassian-${name}`, mcpToolName: name })),
            ...["list_projects", "list_sessions_and_chats", "get_sessions_status", "get_session"].map(name => ({ name })),
        ] }),
        execute: async ({ name, arguments: args }) => ({
            resultType: "success", textResultForLlm: JSON.stringify(await respond(name, args)),
        }),
    } } };
}


test("loads every issue page with an explicit project filter, including epics outside sprints", async () => {
    const calls = [];
    const gateway = new Gateway(runtime((name, args) => {
        calls.push({ name, args });
        return args.nextPageToken ? { issues: [issue("2", "DEMO-2", "DEMO-1")], isLast: true } :
            { issues: [issue("1", "DEMO-1", null, "Epic")], nextPageToken: "next", isLast: false };
    }));
    const result = await gateway.issues("site-a", "42");
    assert.equal(result.issues.length, 2);
    assert.match(calls[0].args.jql, /^project = 42 /);
    assert.doesNotMatch(calls[0].args.jql, /sprint/i);
    assert.equal(calls[1].args.nextPageToken, "next");
    assert.ok(calls[0].args.fields.includes("parent"));
});


test("Jira gateway refuses writes and rejects a project identifier that could inject JQL", async () => {
    const gateway = new Gateway(runtime(() => { throw new Error("must not execute"); }));
    await assert.rejects(gateway.call("editJiraIssue", {}), /read-only/i);
    await assert.rejects(gateway.issues("site-a", '42 OR project = "OTHER"'), /project/i);
});


test("pagination failures are visible instead of pretending the hierarchy is complete", async () => {
    const gateway = new Gateway(runtime(() => ({ issues: [issue("1", "DEMO-1")], nextPageToken: "same" })));
    await assert.rejects(gateway.issues("site-a", "42"), /pagination/i);
});


test("project picker paginates independently from issue pagination", async () => {
    const gateway = new Gateway(runtime((name, args) => ({
        values: [{ id: args.startAt ? "2" : "1", name: "Demo", key: "DEMO" }],
        startAt: args.startAt || 0, maxResults: 1, total: 2, isLast: Boolean(args.startAt),
    })));
    assert.equal((await gateway.projects("site-a")).length, 2);
});


// Finding L6: a missing host tool is Copilot's to explain, even while the Atlassian server waits for sign-in.
test("a missing host tool is named as Copilot's, never blamed on the Jira server", async () => {
    let lists = 0;
    const gateway = new Gateway({ rpc: {
        tools: {
            initializeAndValidate: async () => {},
            getCurrentMetadata: async () => ({ tools: [{ name: "get_session" }] }),
            execute: async () => ({ resultType: "failure", error: "Session 0000 not found" }),
        },
        mcp: { list: async () => { lists++; return { servers: [{ name: "atlassian", status: "needs-auth" }] }; } },
    } }, { rebuildMinMs: 0 });
    const error = await gateway.call("list_projects", {}).then(() => null, e => e);
    assert.match(error.message, /^Copilot did not offer list_projects; update or restart Copilot\.$/);
    assert.doesNotMatch(error.message, /atlassian|sign-in|MCP server/i);
    assert.equal(error.needsSignIn, undefined);
    assert.equal(error.kind, "unavailable");
    assert.equal(lists, 0, "the Jira servers' state is not consulted for a host tool");
    const own = await gateway.call("get_session", { project_session_id: "0000" }).then(() => null, e => e);
    assert.match(own.message, /Session 0000 not found/, "a host tool's own answer is kept as it is");
    assert.equal(own.kind, "permanent");
    const jira = await gateway.call("getAccessibleAtlassianResources", {}).then(() => null, e => e);
    assert.equal(jira.needsSignIn, true, "a Jira tool is still explained by the Jira server");
});


test("every gateway failure is classified for the connection supervisor", async () => {
    let failure, servers = [{ name: "atlassian", status: "connected" }];
    const session = { rpc: {
        tools: {
            getCurrentMetadata: async () => ({ tools: [{ name: "atlassian-getAccessibleAtlassianResources", mcpToolName: "getAccessibleAtlassianResources", mcpServerName: "atlassian" }] }),
            execute: async () => ({ resultType: "failure", error: failure }),
        },
        mcp: { list: async () => ({ servers }) },
    } };
    const gateway = new Gateway(session, { transientDelayMs: 1, shareMs: 0 });
    const kind = async message => {
        failure = message;
        const error = await gateway.call("getAccessibleAtlassianResources", {}).then(() => null, e => e);
        return [error.kind, error.server, error.retryable];
    };
    assert.deepEqual(await kind("Re-authentication required for MCP server \"atlassian\""), ["auth", "atlassian", false]);
    assert.deepEqual(await kind("read ECONNRESET"), ["transient", "atlassian", true]);
    assert.deepEqual(await kind("Tool 'atlassian-getAccessibleAtlassianResources' does not exist."), ["gone", "atlassian", false]);
    assert.deepEqual(await kind("JQL syntax error"), ["permanent", "atlassian", false]);
    servers = [{ name: "atlassian", status: "failed" }];
    const [unavailable] = await kind("Tool 'atlassian-getAccessibleAtlassianResources' does not exist.");
    assert.equal(unavailable, "unavailable", "a vanished tool whose server dropped is explained by that server");
    await assert.rejects(gateway.call("getJiraIssue", { issueIdOrKey: "DEMO-1" }), /read-only; getJiraIssue is not allowed/);
    await assert.rejects(gateway.call("list_sessions_and_chats", {}), /read-only; list_sessions_and_chats is not allowed/);
});

test("among several Jira servers the most usable serves, and the app's connector wins a tie", () => {
    const rovo = { name: "cc-_rovo", status: "connected" };
    assert.equal(preferred([{ name: "atlassian", status: "connected" }, rovo]), rovo);
    assert.equal(preferred([{ name: "atlassian", status: "connected" }, { ...rovo, status: "needs-auth" }]).name, "atlassian");
    assert.equal(preferred([{ name: "atlassian", status: "pending" }, { ...rovo, status: "failed" }]).name, "atlassian");
    assert.equal(preferred([]), null);
    assert.ok(isConnector({ name: "other", source: "managed" }), "a host-managed server is an app connector too");
    assert.ok(!isConnector({ name: "atlassian" }));
    assert.ok(!isConnector({ name: "cc-atlassian" }), "a user's own server named cc-... keeps its OAuth sign-in");
    assert.match(signInError(rovo.name).message, /Reconnect the Atlassian connector in the Copilot app/);
    assert.doesNotMatch(signInError(rovo.name).message, /mcp auth|cc-_/);
    assert.match(signInError("atlassian").message, /\/mcp auth atlassian/);
    const managed = { name: "opaque-managed", source: "managed", displayName: "Atlassian Rovo" };
    assert.match(signInError(managed).message, /Your Atlassian Rovo sign-in has expired\. Reconnect the Atlassian connector in the Copilot app/,
        "a connector known only by its managed source gets the app-reconnect action");
    assert.doesNotMatch(signInError(managed).message, /mcp auth/);
    assert.equal(signInError(managed).server, "opaque-managed");
});

test("a managed connector waiting for sign-in is diagnosed with the app-reconnect action, not /mcp auth", async () => {
    const managed = { name: "opaque-managed", source: "managed", status: "needs-auth" };
    const gateway = new Gateway({ rpc: { tools: {}, mcp: { list: async () => ({ servers: [managed, { name: "github", status: "connected" }] }) } } });
    gateway.jiraKnown.add(managed.name);
    const error = await gateway.diagnose("getAccessibleAtlassianResources");
    assert.equal(error.kind, "auth");
    assert.equal(error.server, "opaque-managed");
    assert.match(error.message, /Reconnect the Atlassian connector in the Copilot app/);
    assert.doesNotMatch(error.message, /mcp auth/);
});

test("a project read fails over across Atlassian versions when the v2 connector drops mid-read", async () => {
    // The connector speaks v2 (projects through executeRead); this atlassian server speaks v1 (getVisibleJiraProjects).
    const runtime = fakeRuntime({ connector: "connected" });
    const gateway = new Gateway(runtime.session, { transientDelayMs: 1, rebuildMinMs: 20, shareMs: 0 });
    assert.equal((await gateway.sites()).length, 1);
    assert.equal(gateway.answered, CONNECTOR);
    runtime.servers.set(CONNECTOR, "stopped");
    runtime.calls.length = 0;
    assert.deepEqual((await gateway.projects("cloud-demo")).map(p => p.key), PROJECTS.map(p => p.key));
    assert.deepEqual(runtime.calls.map(call => [call.server, call.name]), [["atlassian", "getVisibleJiraProjects"]]);
    assert.equal(gateway.answered, "atlassian");
});

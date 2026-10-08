import test from "node:test";
import assert from "node:assert/strict";
import { startServer, loadAssets } from "../lib/server.mjs";
import { Updater } from "../lib/updater.mjs";
import { createBrief } from "../lib/brief.mjs";
import { Workbench } from "../lib/workbench.mjs";

async function panel(t, workbench) {
    const server = await startServer(workbench);
    t.after(() => server.close());
    const url = new URL(server.url);
    const headers = { "x-workbench-token": url.hash.slice(1), "Content-Type": "application/json" };
    return (path, body) => fetch(`${url.origin}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

// A JSON object whose UTF-8 encoding is exactly `bytes` long.
const padded = bytes => `{"pad":"${"x".repeat(bytes - '{"pad":""}'.length)}"}`;

test("loopback server protects all data and action routes with a per-panel token", async t => {
    let launches = 0;
    const server = await startServer({
        snapshot: async () => ({ project: null, issues: [] }),
        launch: async () => { launches++; return { status: "queued" }; },
    });
    t.after(() => server.close());
    const url = new URL(server.url), token = url.hash.slice(1);
    url.hash = "";
    const root = url.href.replace(/\/$/, "");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal((await fetch(`${root}/api/state`)).status, 403);
    const headers = { "x-workbench-token": token, "Content-Type": "application/json" };
    assert.deepEqual(await (await fetch(`${root}/api/state`, { headers })).json(), { project: null, issues: [] });
    assert.equal((await fetch(`${root}/api/launch`, { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: "{}" })).status, 403);
    assert.equal(launches, 0);
    assert.equal((await fetch(`${root}/api/launch`, { method: "POST", headers, body: "{}" })).status, 200);
    assert.equal(launches, 1);
    assert.equal((await fetch(`${root}/api/delete`, { method: "POST", headers, body: "{}" })).status, 404);
    const oversized = await fetch(`${root}/api/launch`, { method: "POST", headers, body: JSON.stringify({ text: "x".repeat(200_000) }) });
    assert.equal(oversized.status, 413);
    assert.equal(launches, 1);
    assert.equal((await fetch(`${root}/api/version`)).status, 403);
    assert.equal(typeof (await (await fetch(`${root}/api/version`, { headers })).json()).label, "string");
    assert.equal((await fetch(`${root}/api/update`, { method: "POST", headers, body: "{}" })).status, 400, "no updater: update is refused");
});

test("the panel UI is the one loaded with the server code, not whatever is on disk later", async t => {
    let disk = "v1";
    const assets = await loadAssets(async file => `${disk}:${file}`);
    disk = "v2";
    const server = await startServer({ snapshot: async () => ({}) }, { assets });
    t.after(() => server.close());
    const root = new URL(server.url).origin;
    assert.equal(await (await fetch(`${root}/app.mjs`)).text(), "v1:../ui/app.mjs");
    assert.match((await fetch(`${root}/`)).headers.get("content-type"), /text\/html/);
    assert.equal((await fetch(`${root}/missing.js`)).status, 403);
    const real = await loadAssets();
    assert.ok(String(real.get("/app.mjs")[0]).includes("checkBuild"));
});

test("the panel can load every module that the served model imports", async t => {
    const server = await startServer({ snapshot: async () => ({}) });
    t.after(() => server.close());
    const root = new URL(server.url).origin;
    const model = await (await fetch(`${root}/model.mjs`)).text();
    const imports = [...model.matchAll(/^import [^;]+ from "\.\/([\w-]+\.mjs)";/gm)].map(match => `/${match[1]}`);
    assert.ok(imports.includes("/validate.mjs"));
    const viewModel = await (await fetch(`${root}/view-model.mjs`)).text();
    assert.ok(viewModel.includes('from "./model.mjs"'), "the panel's view-model is served and imports the served model");
    for (const path of ["/view-model.mjs", ...imports]) {
        const response = await fetch(`${root}${path}`);
        assert.equal(response.status, 200, `${path} is served`);
        assert.match(response.headers.get("content-type"), /text\/javascript/);
        assert.doesNotMatch(await response.text(), /from "node:/, `${path} stays browser-safe`);
    }
});

test("build status flags a process running an older commit than the installed checkout", async t => {
    let head = "a".repeat(40);
    const run = async (exe, args) => ({ stdout: args.includes("rev-parse") ? `${head}\n` : "" });
    const identity = { kind: "git", head, commit: head.slice(0, 7), date: "2026-09-30", dirty: false, tree: null, version: null, repo: "example/demo" };
    const updater = new Updater({ install: { kind: "git", root: "/repo/extensions/jira-workbench", repoRoot: "/repo" }, identity, run });
    const server = await startServer({ snapshot: async () => ({}) }, { updater });
    t.after(() => server.close());
    const url = new URL(server.url), headers = { "x-workbench-token": url.hash.slice(1) };
    const read = async () => (await fetch(`${url.origin}/api/version`, { headers })).json();
    assert.deepEqual([(await read()).state, (await read()).action], ["unknown", null], "same commit on disk: nothing to do");
    head = "b".repeat(40);
    const stale = await read();
    assert.deepEqual([stale.state, stale.action, stale.label], ["installed", "reload", "aaaaaaa · 2026-09-30"]);
    assert.match(stale.message, /bbbbbbb/);
});

test("update routes are token-protected and delegate to the updater", async t => {
    let applied = 0;
    const updater = {
        status: () => ({ label: "abc1234 · 2026-09-30", state: "available", action: "update", message: "Update available." }),
        local() { return Promise.resolve(this.status()); },
        apply: async () => { applied++; return { label: "abc1234 · 2026-09-30", state: "reloading", action: null, message: "Restarting the Workbench…" }; },
    };
    const server = await startServer({ snapshot: async () => ({}) }, { updater });
    t.after(() => server.close());
    const url = new URL(server.url), token = url.hash.slice(1);
    url.hash = "";
    const root = url.href.replace(/\/$/, "");
    const headers = { "x-workbench-token": token, "Content-Type": "application/json" };
    assert.equal((await fetch(`${root}/api/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(applied, 0);
    assert.equal((await (await fetch(`${root}/api/version`, { headers })).json()).action, "update");
    assert.equal((await (await fetch(`${root}/api/update`, { method: "POST", headers, body: "{}" })).json()).state, "reloading");
    assert.equal(applied, 1);
});

test("the largest brief the validator accepts fits the body cap, in non-ASCII and in escaped control characters", async t => {
    const prepared = [];
    const post = await panel(t, { snapshot: async () => ({}), prepare: async input => { prepared.push(input); return { status: "prepared" }; } });
    const node = { id: "1", key: "DEMO-1", summary: "Summary", description: "", dependencies: [] };
    for (const char of ["界", "\u0001"]) {
        const fields = { objective: char.repeat(2_000), acceptanceCriteria: char.repeat(10_000), constraints: char.repeat(4_000) };
        assert.ok(createBrief({ node, mapping: { id: "p", repo: "example/demo" }, siteUrl: "https://demo.atlassian.net", mode: "plan", fields }).hash,
            "the brief validator accepts these fields");
        const body = JSON.stringify({ nodeId: "1", mode: "plan", fields });
        assert.ok(Buffer.byteLength(body) > 16_384 * 2, "well over the old 16 KB cap");
        const response = await post("/api/prepare", body);
        assert.equal(response.status, 200, `a ${Buffer.byteLength(body)}-byte brief is accepted`);
        assert.deepEqual(prepared.at(-1).fields, fields);
    }
});

test("the largest preferences the validator accepts fit their own, larger body cap", async t => {
    const data = { version: 1, mappings: {}, links: {}, requests: {} };
    const workbench = new Workbench({ store: { read: async () => data, update: async change => change(data) } });
    workbench.site = { id: "cloud-demo", name: "Demo", url: "https://demo.atlassian.net" };
    workbench.project = { id: "42", key: "DEMO", name: "Demo project" };
    const post = await panel(t, workbench);
    const scope = workbench.selectedScope(), id = "\u0001".repeat(100);
    const preferences = {
        view: "execution", executionFilter: "needs-me", selected: id, collapsed: Array(10_000).fill(id),
        query: "\u0001".repeat(500), category: "done", sprint: `sprint:${"\u0001".repeat(100)}`,
        scrollTop: 10_000_000, detailsOpen: true,
    };
    const body = JSON.stringify({ scope, preferences });
    assert.ok(Buffer.byteLength(body) > 6_000_000);
    const response = await post("/api/preferences", body);
    assert.equal(response.status, 200, (await response.clone().json()).error);
    assert.deepEqual(await response.json(), { status: "saved", scope });
    assert.equal(data.preferences[scope].collapsed.length, 10_000);
    const tooMany = await post("/api/preferences", { scope, preferences: { collapsed: Array(10_001).fill("1") } });
    assert.equal(tooMany.status, 400, "the validator, not the body cap, refuses invalid preferences");
});

test("bodies over each route's cap get 413 before reaching the Workbench", async t => {
    const calls = [];
    const post = await panel(t, {
        snapshot: async () => ({}),
        prepare: async () => { calls.push("prepare"); return {}; },
        savePreferences: async () => { calls.push("preferences"); return {}; },
    });
    assert.equal((await post("/api/prepare", padded(100_096))).status, 200);
    assert.equal((await post("/api/prepare", padded(100_097))).status, 413);
    assert.equal((await post("/api/preferences", padded(100_097))).status, 200, "preferences have a larger cap");
    assert.equal((await post("/api/preferences", padded(6_037_696))).status, 200);
    const refused = await post("/api/preferences", padded(6_037_697));
    assert.equal(refused.status, 413);
    assert.deepEqual(await refused.json(), { error: "Request is too large." });
    assert.deepEqual(calls, ["prepare", "preferences", "preferences"]);
});

test("Clear stuck request is a token-protected route to the Workbench", async t => {
    const cleared = [];
    const server = await startServer({
        snapshot: async () => ({}),
        clearRequest: async input => { cleared.push(input); return { status: "cancelled", requestId: input.requestId }; },
    });
    t.after(() => server.close());
    const url = new URL(server.url), json = { "Content-Type": "application/json" };
    const post = headers => fetch(`${url.origin}/api/clear-request`, { method: "POST", headers, body: JSON.stringify({ requestId: "request-1" }) });
    assert.equal((await post(json)).status, 403);
    assert.deepEqual(cleared, []);
    const response = await post({ ...json, "x-workbench-token": url.hash.slice(1) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "cancelled", requestId: "request-1" });
    assert.deepEqual(cleared, [{ requestId: "request-1" }]);
});

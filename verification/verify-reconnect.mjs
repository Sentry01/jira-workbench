// Proves, in the real canvas UI, that MCP connection problems are explained and recover without a click.
// External services are the behavioural fake in test/fake-runtime.mjs; nothing real is contacted.
import { launchBrowser, screenshotPath } from "./browser.mjs";
import { resolveRoot } from "./fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolveRoot();
const load = file => import(pathToFileURL(join(root, file)));
const [{ Workbench }, { Store }, { Cache }, { Connection }, { startServer }, { fakeRuntime, SITE, CONNECTOR }] = await Promise.all([
    load("lib/workbench.mjs"), load("lib/store.mjs"), load("lib/cache.mjs"), load("lib/connection.mjs"),
    load("lib/server.mjs"), load("test/fake-runtime.mjs"),
]);

const directory = await mkdtemp(join(tmpdir(), "jira-workbench-reconnect-"));
const runtime = fakeRuntime({ status: "stopped", issueCount: 12 });
const opened = [];
// Production polling (1s while things change); sign-in reads start at 500ms instead of 5s to keep the run short.
const connection = new Connection(runtime.session, { restartDelaysMs: [], keepaliveMs: 0, signInReadMs: [500, 5_000], openUrl: async url => { opened.push(url); } }).start();
const workbench = new Workbench({
    gateway: connection.gateway, store: new Store(directory), cache: new Cache(directory),
    github: async () => null, send: async () => {}, instanceId: "reconnect",
});
connection.attach(workbench);
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const banner = () => page.evaluate(() => document.querySelector("#errors").hidden ? "" : document.querySelector("#errors").innerText);
const rows = () => page.evaluate(() => new Set(document.querySelector("#tree").innerText.match(/DEMO-\d+/g) || []).size);
const within = async (what, predicate, ms = 15_000) => {
    const started = Date.now();
    while (!(await predicate())) {
        if (Date.now() - started > ms) throw new Error(`Timed out after ${ms}ms: ${what}. Banner: ${await banner()}`);
        await page.waitForTimeout(200);
    }
    return Date.now() - started;
};

try {
    // 1. First open while the Atlassian server is stopped: say which server and that recovery is automatic.
    void workbench.background(() => workbench.warm({ cloudId: SITE.id, jiraProjectId: "42" }));
    await page.goto(server.url);
    await within("stopped-server explanation", async () => /MCP server atlassian is stopped/.test(await banner()));
    await within("automatic-retry hint", async () => /Reconnecting (automatically in about \d+s|now)/.test(await banner()));
    assert.doesNotMatch(await banner(), /unrelated-sso/, "an unrelated server needing sign-in is not blamed");
    await page.screenshot({ path: screenshotPath("reconnect-1-stopped.png") });

    // 2. The server comes up: the project loads with no click.
    runtime.set("atlassian", "connected");
    const healMs = await within("project to load without a click", async () => (await rows()) === 12 && !(await banner()));
    await page.screenshot({ path: screenshotPath("reconnect-2-healed.png") });

    // 3. A silent token expiry during a manual refresh never reaches the user.
    runtime.tokenExpired = true;
    await page.click("#refresh");
    await page.waitForTimeout(1500);
    assert.equal(await banner(), "", "token refresh was invisible");
    assert.equal(runtime.tokenExpired, false);

    // 4. The server drops while the project is open: last good data stays, the cause is named, and it heals.
    runtime.servers.set("atlassian", "failed");
    await page.click("#refresh");
    await within("failed-server explanation", async () => /atlassian failed to connect/.test(await banner()));
    assert.equal(await rows(), 12, "last good hierarchy stays on screen");
    await page.screenshot({ path: screenshotPath("reconnect-3-dropped.png") });
    runtime.set("atlassian", "connected");
    const recoverMs = await within("recovery after the drop", async () => !(await banner()) && (await rows()) === 12);

    // 5. The sign-in expires (mcp.list still says connected): one clear call to action, no retry storm, and the
    //    Sign in button starts the browser flow; finishing it reloads Jira with no further click.
    runtime.signInExpired = true;
    await page.click("#refresh");
    await within("sign-in panel", () => page.isVisible("#sign-in"));
    await page.waitForTimeout(1500);
    assert.equal(await banner(), "", "the sign-in panel is the only message: no retry promise, raw runtime error or duplicate");
    assert.equal(await rows(), 12, "last good hierarchy stays on screen");
    const requests = runtime.counters.oauthRequests;
    await page.waitForTimeout(3000);
    assert.equal(runtime.counters.oauthRequests, requests, "no OAuth request storm while waiting for sign-in");
    await page.screenshot({ path: screenshotPath("reconnect-4-sign-in.png") });
    await page.click("#sign-in-button");
    await within("sign-in link", async () => /Finish signing in in your browser/.test(await page.innerText("#sign-in-status")));
    assert.deepEqual(opened, ["https://auth.atlassian.com/authorize?client_id=fake"]);
    runtime.completeSignIn({ event: false });
    const signInMs = await within("reload after sign-in", async () => !(await page.isVisible("#sign-in")) && !(await banner()) && (await rows()) === 12);

    // 6. The server drops to needs-auth under the open panel (observed live: its tools vanish and a stale one
    //    answers "Tool '…' does not exist"): the same Sign in action, not a raw error, and it reloads on connect.
    runtime.servers.set("atlassian", "needs-auth");
    await page.click("#refresh");
    await within("sign-in panel for needs-auth", () => page.isVisible("#sign-in"));
    assert.equal(await banner(), "", "no raw 'does not exist' or 'needs sign-in' text beside the Sign in action");
    assert.equal(await rows(), 12, "last good hierarchy stays on screen");
    await page.screenshot({ path: screenshotPath("reconnect-5-needs-auth.png") });
    runtime.set("atlassian", "connected");
    const needsAuthMs = await within("reload after the server connected", async () => !(await page.isVisible("#sign-in")) && !(await banner()) && (await rows()) === 12);

    // 7. The Copilot app's Atlassian Rovo connector joins (observed live: listed as cc-_<id>, offering every Jira tool
    //    the atlassian server offers): no "ambiguous" error, and the connector serves.
    runtime.set(CONNECTOR, "connected");
    await runtime.session.rpc.tools.initializeAndValidate();
    // Until the MCP event is processed the cached tool list predates the connector and the atlassian server serves.
    const served = () => [...new Set(runtime.calls.map(call => call.server))];
    await within("refresh through the connector", async () => {
        assert.doesNotMatch(await banner(), /ambiguous/);
        if (served().includes(CONNECTOR) && (await rows()) === 12) return true;
        runtime.calls.length = 0;
        await page.click("#refresh");
        return false;
    });
    assert.deepEqual(served(), [CONNECTOR]);

    // 8. Sign-in moves straight from the atlassian server, with its browser-flow link on screen, to the connector.
    //    The app signs the connector in, so the panel points there instead of offering Sign in, /mcp auth or the
    //    stale link, and reloads once the app reconnects it.
    runtime.set("atlassian", "needs-auth");
    runtime.set(CONNECTOR, "stopped");
    await page.click("#refresh");
    await within("sign-in panel for the atlassian server", () => page.isVisible("#sign-in-button"));
    await page.click("#sign-in-button");
    await within("sign-in link for the atlassian server", async () => /Finish signing in in your browser/.test(await page.innerText("#sign-in-status")));
    runtime.servers.delete("atlassian");
    runtime.set(CONNECTOR, "needs-auth");
    await within("connector sign-in panel", () => page.isVisible("#sign-in-connector"));
    assert.ok(!(await page.isVisible("#sign-in-status")), "the atlassian server's sign-in link is not left beside the connector's instruction");
    assert.ok(!(await page.isVisible("#sign-in-button")) && !(await page.isVisible("#sign-in-mcp")),
        "no Sign in button or /mcp auth hint for the app's connector");
    assert.match(await page.innerText("#sign-in"), /Reconnect the Atlassian connector in the Copilot app/);
    assert.doesNotMatch(await page.innerText("body"), /cc-_/, "the opaque connector name is never shown");
    assert.equal(await banner(), "");
    assert.equal(await rows(), 12, "last good hierarchy stays on screen");
    await page.screenshot({ path: screenshotPath("reconnect-6-connector-sign-in.png") });
    const logins = runtime.counters.logins;
    runtime.set(CONNECTOR, "connected");
    const connectorMs = await within("reload after the app reconnected the connector", async () => !(await page.isVisible("#sign-in")) && !(await banner()) && (await rows()) === 12);
    assert.equal(runtime.counters.logins, logins, "no OAuth login was started for the connector");

    assert.ok(healMs < 4000 && recoverMs < 4000, `recovery must show within seconds (${healMs}ms, ${recoverMs}ms)`);
    assert.deepEqual(errors, []);
    console.log(`PASS: stopped server named with an automatic-retry hint, project loaded ${healMs}ms after connect with no click, silent token refresh invisible, drop kept data and healed ${recoverMs}ms after reconnect, expired sign-in showed one Sign in action with no request storm and reloaded ${signInMs}ms after sign-in, needs-auth showed Sign in and reloaded ${needsAuthMs}ms after the server connected, the Atlassian Rovo connector served reads beside the atlassian server, and its sign-in pointed to the Copilot app and reloaded ${connectorMs}ms after it reconnected. External services were fake.`);
} finally {
    await browser.close();
    await server.close();
    connection.stop();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

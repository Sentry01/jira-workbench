import { launchBrowser, screenshotPath } from "./browser.mjs";
import { createFixture, seedProject } from "./fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "jira-workbench-v2-browser-"));
const { workbench, store, sent, navigations, navigationSelections, navigation, startServer } = await createFixture({ directory });
await seedProject(workbench);
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));

async function byName(name) {
    const locator = page.getByRole("button", { name, exact: true });
    await locator.waitFor();
    await locator.click();
}
async function bodyHas(text) {
    await page.waitForFunction(value => document.body.innerText.includes(value), text);
}

try {
    await page.goto(server.url);
    await bodyHas("Needs your answer");
    assert.match(await page.locator("body").innerText(), /Answer question/);
    assert.match(await page.locator("body").innerText(), /Review PR/);
    assert.match(await page.locator("body").innerText(), /Interrupted/);
    const queue = (await workbench.snapshot()).executions;
    assert.equal(queue.find(item => item.nodeId === "4").views.includes("prs"), false);
    assert.equal(queue.find(item => item.nodeId === "6").primary.mode, "autopilot");

    const tones = () => page.$$eval(".source", nodes => nodes.map(node => [node.textContent.split(":")[0], node.dataset.tone]));
    await page.waitForFunction(() => document.getElementById("github-freshness").dataset.tone === "fresh");
    assert.deepEqual(await tones(), [["Jira", "fresh"], ["Sessions", "fresh"], ["GitHub", "fresh"]]);
    await page.locator("#freshness").focus();
    assert.match(await page.evaluate(() => getComputedStyle(document.activeElement, "::after").content), /Read from Jira at/);
    assert.match(await page.locator("#freshness").getAttribute("aria-label"), /^Jira: fresh .+\. Read from Jira at/);
    const realGithub = workbench.github;
    workbench.github = async () => { throw new Error("GitHub unreachable"); };
    await byName("Refresh live state");
    await page.waitForFunction(() => document.getElementById("github-freshness").dataset.tone === "error");
    assert.match(await page.locator("#github-freshness").innerText(), /GitHub: stale/);
    assert.match(await page.locator("#github-freshness").getAttribute("aria-label"), /GitHub unreachable/);
    workbench.github = realGithub;
    await byName("Refresh live state");
    await page.waitForFunction(() => document.getElementById("github-freshness").dataset.tone === "fresh");

    navigation.hold();
    const entered = navigation.entered();
    const answer = page.getByRole("button", { name: "Answer question", exact: true }).first();
    await answer.click();
    await entered;
    assert.equal(await page.locator("#search").isEnabled(), true);
    assert.equal(navigations.length, 1);
    navigation.release();
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes("acknowledged"));
    assert.equal(navigations[0].name, "navigate_to");
    assert.equal(navigationSelections[0], "2", "The acted-on item is persisted before native navigation");
    assert.equal(sent.length, 0, "Navigation must not launch work");

    await page.locator("#search").fill("Ready example");
    await page.getByRole("button", { name: "Prepare implementation", exact: true }).click();
    await page.locator("#launch-dialog[open]").waitFor();
    assert.equal(await page.locator("#launch-mode").inputValue(), "autopilot", "A story with subtasks keeps the implementation default");
    assert.equal(await page.getByRole("textbox", { name: "Acceptance criteria", exact: true }).inputValue(), "Display the result");
    await page.locator("#cancel-launch").click();
    await page.locator("#search").fill("");

    await page.locator("#project-start").click();
    await page.locator("#launch-dialog[open]").waitFor();
    assert.equal(await page.locator("#launch-mode").inputValue(), "plan");
    assert.equal(await page.locator("#confirm-launch").isEnabled(), true, "Planning must allow missing criteria");
    await page.locator("#launch-mode").selectOption("autopilot");
    assert.equal(await page.locator("#confirm-launch").isDisabled(), true);
    let reviewed = page.waitForResponse(response => response.url().endsWith("/api/prepare") && response.ok());
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await (await reviewed).finished();
    const warning = page.locator("#launch-dialog").getByRole("checkbox");
    await warning.waitFor();
    assert.equal(await page.locator("#confirm-launch").isDisabled(), true);
    await warning.check();
    assert.equal(await page.locator("#confirm-launch").isEnabled(), true);
    await page.getByRole("textbox", { name: "Objective", exact: true }).fill("Reviewed engineering objective");
    assert.equal(await page.locator("#confirm-launch").isDisabled(), true, "Editing invalidates acknowledgement");
    reviewed = page.waitForResponse(response => response.url().endsWith("/api/prepare") && response.ok());
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    await (await reviewed).finished();
    assert.equal(await warning.isChecked(), false);
    await warning.check();
    await page.route("**/api/launch", async route => {
        await route.fetch();
        await route.abort("failed");
    });
    await page.locator("#confirm-launch").click();
    await bodyHas("Launch outcome unknown");
    await page.locator("#cancel-launch").click();
    const request = Object.values((await store.read()).requests)[0];
    assert.equal(request.status, "queued");
    assert.equal(request.brief.objective, "Reviewed engineering objective");
    assert.equal(request.contextHash, request.brief.hash);
    assert.ok(request.previewId);
    assert.ok(request.acknowledgedWarnings.includes("missing-criteria"));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].prompt.includes(request.contextHash));
    assert.equal((await store.read()).links["demo-site/42/project"], undefined, "Queued does not mean a session exists");
    await page.getByRole("button", { name: "Refresh live state", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Launch queued;") && !document.body.innerText.includes("Launch outcome unknown"));
    assert.equal(sent.length, 1, "Response-loss reconciliation must not retry creation");

    assert.equal(await page.locator("#sync-jira").isDisabled(), true, "Update Jira waits for the queued project launch");
    await workbench.failRequest({ requestId: request.requestId, message: "Fake launch abandoned before the Update Jira check" });
    await page.getByRole("button", { name: "Refresh live state", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("sync-jira").disabled);
    await page.locator("#sync-jira").click();
    await page.locator("#sync-dialog[open]").waitFor();
    assert.match(await page.locator("#sync-dialog").innerText(), /Daily execution demo/);
    await page.locator("#cancel-sync").click();
    assert.equal(sent.length, 1, "Cancelling Update Jira sends nothing");
    await page.locator("#sync-jira").click();
    await page.locator("#confirm-sync").click();
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sent.length, 2, "Confirming Update Jira queues exactly one session");
    assert.match(sent[1].prompt, /Jira status sync/);
    const syncRequest = Object.values((await store.read()).requests).find(r => r.kind === "jira-sync");
    assert.equal(syncRequest.status, "queued");
    await page.waitForFunction(() => document.getElementById("sync-jira").disabled);

    // A launch request with no receipt after 15 minutes is expired: it never blocks Start, and clearing it takes
    // a second, confirming click.
    await store.update(data => {
        data.requests.stuck = {
            requestId: "stuck", previewId: "stuck-preview", scope: "demo-site/42/6", nodeId: "6", issueKey: "DEMO-6",
            cloudId: "demo-site", jiraProjectId: "42", copilotProjectId: "app-project", mode: "autopilot", status: "queued",
            at: new Date(Date.now() - 16 * 60_000).toISOString(), contextHash: "stuck-hash", acknowledgedWarnings: [],
            brief: { hash: "stuck-hash", intent: "implement", objective: "Ready example", acceptanceCriteria: [], constraints: "",
                repository: { projectId: "app-project", repo: "example/demo" }, sources: [], warnings: [], children: [] },
        };
    });
    await page.locator("#search").fill("Ready example");
    await byName("Refresh live state");
    const stuckRow = page.locator('#tree [data-node-id="6"]');
    await stuckRow.getByRole("button", { name: "Clear stuck request", exact: true }).waitFor();
    assert.match(await stuckRow.innerText(), /Launch outcome unknown: no session receipt after 15 minutes/);
    assert.doesNotMatch(await stuckRow.innerText(), /Launch queued/, "an expired request is not shown as queued");
    await stuckRow.locator(".issue-key").click();
    const inspector = page.locator("#inspector"), requestCard = inspector.locator(".session-card", { hasText: "Launch request" });
    await requestCard.getByText("Outcome unknown (no receipt after 15 minutes)").waitFor();
    const start = inspector.getByRole("button", { name: "Start session", exact: true });
    assert.equal(await start.isEnabled(), true, "an expired request never blocks Start");
    const jiraLabel = await page.locator("#freshness").innerText();
    assert.match(jiraLabel, /^Jira: fresh /);
    assert.ok((await inspector.locator(".inspector-freshness").innerText()).startsWith(`${jiraLabel}. `), "the inspector and the connection bar show one Jira freshness label");
    await start.click();
    await page.locator("#launch-dialog[open]").waitFor();
    assert.equal(await page.locator("#launch-mode").inputValue(), "autopilot", "the inspector's Start opens a leaf in Implement, like the queue row");
    await page.locator("#cancel-launch").click();
    await stuckRow.getByRole("button", { name: "Clear stuck request", exact: true }).click();
    const confirmClear = stuckRow.getByRole("button", { name: "Confirm clear", exact: true });
    await confirmClear.waitFor();
    assert.equal((await store.read()).requests.stuck.status, "queued", "the first click sends nothing");
    const cleared = page.waitForResponse(response => response.url().endsWith("/api/clear-request") && response.ok());
    await confirmClear.focus();
    await page.keyboard.press("Enter");
    await cleared;
    const prepareAgain = stuckRow.getByRole("button", { name: "Prepare implementation", exact: true });
    await prepareAgain.waitFor();
    assert.equal(await prepareAgain.isEnabled(), true, "Start is available again");
    await page.waitForFunction(() => document.activeElement?.dataset.nodeId === "6");
    assert.equal((await store.read()).requests.stuck.status, "cancelled");
    await requestCard.getByText("Cleared", { exact: true }).waitFor();
    assert.equal(sent.length, 2, "Clearing a request launches nothing");
    await page.locator("#search").fill("");

    await byName("Hierarchy");
    // One search rule in both views: a parent key finds its children (DEMO-8 is a subtask of DEMO-6).
    await page.locator("#search").fill("DEMO-6");
    await page.waitForFunction(() => document.querySelectorAll('#tree [role="treeitem"]').length === 3);
    assert.deepEqual(await page.$$eval('#tree [role="treeitem"]', rows => rows.map(row => row.dataset.nodeId)), ["1", "6", "8"]);
    await page.locator("#search").fill("");
    await page.getByRole("treeitem", { name: /DEMO-5 / }).click();
    assert.match(await page.locator("#inspector").innerText(), /Missing criteria and blocked/);
    const preferencesSaved = page.waitForResponse(response => response.url().endsWith("/api/preferences") && response.ok()
        && response.request().postDataJSON()?.preferences?.query === "Ready example");
    await page.locator("#search").fill("Ready example");
    await preferencesSaved;
    await page.locator("#project").selectOption("43");
    await page.waitForFunction(() => document.getElementById("project-title").textContent === "Another project");
    assert.equal(await page.locator("#repository").inputValue(), "");
    assert.doesNotMatch(await page.locator("#inspector").innerText(), /Missing criteria and blocked/);
    await page.locator("#project").selectOption("42");
    await page.waitForFunction(() => document.getElementById("project-title").textContent === "Daily execution demo");
    await page.waitForFunction(() => document.getElementById("search").value === "Ready example");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("project-title").textContent === "Daily execution demo");
    await page.waitForFunction(() => document.getElementById("search").value === "Ready example");
    assert.match(await page.locator("#inspector").innerText(), /Missing criteria and blocked/);
    await page.locator("#search").fill("");

    const epic = page.getByRole("treeitem", { name: /DEMO-1 / });
    await epic.focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.getByRole("treeitem").count(), 1);
    assert.match(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), /DEMO-1/);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("treeitem").count(), 8);
    await page.getByRole("treeitem", { name: /DEMO-2 / }).click();
    await byName("Execution");
    await page.screenshot({ path: screenshotPath("execution.png"), fullPage: true });
    await page.setViewportSize({ width: 600, height: 960 });
    const back = page.getByRole("button", { name: /Back to work/i });
    if (await back.isVisible()) await back.click();
    await byName("Hierarchy");
    await page.getByRole("treeitem", { name: /DEMO-2 / }).click();
    await page.getByRole("button", { name: /Back to work/i }).click();
    await byName("Execution");
    assert.equal(await page.locator("#search").isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Narrow canvas must not overflow");
    await page.screenshot({ path: screenshotPath("narrow.png"), fullPage: true });
    assert.equal(sent.length, 2, "Only the explicitly confirmed fake launches are queued");
    assert.deepEqual(errors, []);
    console.log("PASS: state-aware queue, native acknowledgement, local navigation during pending action, Plan-with-warnings, Implement acknowledgement, edit invalidation, immutable launch snapshot, Update Jira confirmation, expired request (never blocks Start, cleared only on a confirming second click, focus back on its row), inspector Start defaults a leaf to Implement, one Jira freshness label in the bar and inspector, parent-key search in the hierarchy, project-scoped restoration, keyboard focus, freshness dots (fresh, keyboard tooltip, failed GitHub read is red), and narrow layout. External services were fake; no real sessions or Jira writes.");
} finally {
    navigation.release();
    await browser.close();
    await server.close();
    await rm(directory, { recursive: true });
}

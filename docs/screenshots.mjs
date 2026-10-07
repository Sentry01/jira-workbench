// Regenerates the guide screenshots from the synthetic demo fixture.
// No real Jira, GitHub, or session data is used, so the output is safe to publish.
//
//   node docs/screenshots.mjs
//
// Requires playwright-core and a Chromium-based browser (see verification/README.md).

import { launchBrowser } from "../verification/browser.mjs";
import { createFixture, seedProject } from "../verification/fixture.mjs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const images = process.env.SCREENSHOT_DIR || fileURLToPath(new URL("./images/", import.meta.url));
await mkdir(images, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "jira-workbench-docs-"));
const { workbench, store, startServer } = await createFixture({ directory });
await workbench.catalog();
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const captured = [];
// Keep guide images stable: a real commit label would be stale as soon as they are committed.
await page.route("**/api/version", route => route.fulfill({ json: { label: "demo build" } }));

const shot = async (name, target = page) => {
    await target.screenshot({ path: join(images, name) });
    captured.push(name);
};
const titleIs = value => page.waitForFunction(
    expected => document.getElementById("project-title").textContent === expected, value);
const dismissNotices = async () => {
    for (const button of await page.locator("#notice button", { hasText: "Dismiss" }).all()) {
        if (await button.isVisible()) await button.click();
    }
};

try {
    await page.goto(server.url);
    await page.waitForFunction(() => document.getElementById("site").options.length > 1);
    await shot("01-connect.png");

    await seedProject(workbench);
    await page.reload();
    await titleIs("Daily execution demo");
    await page.waitForFunction(() => document.body.innerText.includes("Answer question"));
    await dismissNotices();
    await shot("02-execution.png");

    await page.locator("#search").fill("Work item 8");
    await page.getByRole("button", { name: "Prepare implementation", exact: true }).first().click();
    await page.locator("#launch-dialog[open]").waitFor();
    const review = page.getByRole("button", { name: "Review changes", exact: true });
    if (await page.locator("#launch-ack-label").isHidden() && await review.isEnabled()) {
        const reviewed = page.waitForResponse(response => response.url().endsWith("/api/prepare") && response.ok());
        await review.click();
        await (await reviewed).finished();
    }
    await page.locator("#launch-ack-label").waitFor();
    await shot("03-launch-brief.png", page.locator("#launch-dialog"));
    await page.locator("#cancel-launch").click();
    await page.locator("#search").fill("");

    await page.getByRole("button", { name: "Hierarchy", exact: true }).click();
    await page.getByRole("treeitem", { name: /DEMO-3 / }).click();
    await page.waitForFunction(() => document.getElementById("inspector").innerText.includes("Running with a PR"));
    await dismissNotices();
    await shot("04-hierarchy.png");
    await page.waitForFunction(() => document.getElementById("inspector").innerText.includes("Pull request"));
    await page.locator("#inspector").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await shot("05-trace.png", page.locator("#inspector"));

    // A tighter crop of just the numbered chain, for the README.
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.locator("#inspector").evaluate(element => {
        const first = element.querySelector(".trace-step");
        element.scrollTop += first.getBoundingClientRect().top - element.getBoundingClientRect().top - 10;
    });
    const chain = await page.evaluate(() => {
        const steps = [...document.querySelectorAll("#inspector .trace-step")];
        const first = steps[0].getBoundingClientRect(), last = steps.at(-1).getBoundingClientRect();
        return { x: first.x - 10, y: first.y - 10, width: first.width + 20, height: last.bottom - first.top + 20 };
    });
    await page.screenshot({ path: join(images, "05b-trace-chain.png"), clip: chain });
    captured.push("05b-trace-chain.png");
    await page.setViewportSize({ width: 1440, height: 1080 });

    await page.setViewportSize({ width: 620, height: 900 });
    const back = page.getByRole("button", { name: /Back to work/i });
    if (await back.isVisible()) await back.click();
    await page.getByRole("button", { name: "Execution", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Answer question"));
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot("06-narrow.png");

    // A launch request with no session receipt after 15 minutes, and its Clear stuck request action.
    await page.setViewportSize({ width: 1440, height: 1080 });
    await store.update(data => {
        data.requests["demo-stuck"] = {
            requestId: "demo-stuck", previewId: "demo-stuck-preview", scope: "demo-site/42/6", nodeId: "6", issueKey: "DEMO-6",
            cloudId: "demo-site", jiraProjectId: "42", copilotProjectId: "app-project", mode: "autopilot", status: "queued",
            at: new Date(Date.now() - 20 * 60_000).toISOString(), contextHash: "demo-stuck", acknowledgedWarnings: [],
            brief: { hash: "demo-stuck", intent: "implement", objective: "Ready example", acceptanceCriteria: ["Display the result"], constraints: "",
                repository: { projectId: "app-project", repo: "example/demo" }, sources: [], warnings: [], children: [] },
        };
    });
    await page.getByRole("button", { name: "Refresh live state", exact: true }).click();
    await page.locator("#search").fill("Ready example");
    const stuck = page.locator('#tree [data-node-id="6"]');
    await stuck.getByRole("button", { name: "Clear stuck request", exact: true }).waitFor();
    await stuck.locator(".issue-key").click();
    await page.waitForFunction(() => document.getElementById("inspector").innerText.includes("Outcome unknown"));
    await page.locator("#inspector").evaluate(element => { element.scrollTop = 0; });
    await dismissNotices();
    await shot("07-stuck-request.png");

    console.log(`Wrote ${captured.length} screenshots to ${images}:\n  ${captured.join("\n  ")}`);
} finally {
    await browser.close();
    await server.close();
    await rm(directory, { recursive: true });
}

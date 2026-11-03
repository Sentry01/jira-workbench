import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, screenshotPath } from "./browser.mjs";
import { createFixture, issues, seedProject } from "./fixture.mjs";

// About 300 loaded issues with linked sessions: every session poll re-observes them and rewrites their freshness
// stamps, but nothing a row shows changes, so an unchanged poll must not touch the tree or the inspector.
const directory = await mkdtemp(join(tmpdir(), "jira-workbench-poll-"));
const { workbench, gateway, startServer } = await createFixture({ directory });
const extra = Array.from({ length: 292 }, (_, index) => ({
    ...issues[5], id: String(100 + index), key: `DEMO-${100 + index}`, summary: `Generated work item ${100 + index}`,
    description: "Synthetic description. ".repeat(40),
}));
let working = [...issues, ...extra];
gateway.issues = async (site, project) => ({ issues: project === "42" ? working : [], fetchedAt: new Date().toISOString() });
await seedProject(workbench);
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [], requests = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(`${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionPoll = () => page.waitForResponse(response => response.url().includes("/api/refresh-execution"), { timeout: 15_000 });
const rows = () => page.locator("#tree [data-node-id]").count();

try {
    await page.goto(server.url);
    await page.waitForFunction(count => document.querySelectorAll("#tree [data-node-id]").length >= count, 300);
    await page.locator('#tree [data-node-id="2"]').click();
    await page.locator("#inspector-content h2").waitFor();
    // The inspector shows trace times to the minute: keep the observed window inside one minute.
    while (new Date().getSeconds() < 10 || new Date().getSeconds() > 40) await sleep(500);
    await sessionPoll();
    await sleep(300);
    // Counts nodes added or removed: a rebuilt row, control or inspector section. PR-7 (M-13) also removes the remaining
    // same-value rewrites of each action control's label and aria-busy, which replace only a text node.
    await page.evaluate(() => {
        window.pollMutations = { tree: 0, inspector: 0 };
        window.controlRewrites = 0;
        for (const [id, key] of [["tree", "tree"], ["inspector-content", "inspector"]])
            new MutationObserver(records => {
                for (const record of records) {
                    const nodes = [...record.addedNodes, ...record.removedNodes];
                    if (nodes.some(node => node.nodeType === Node.ELEMENT_NODE)) window.pollMutations[key]++;
                    else window.controlRewrites++;
                }
            }).observe(document.getElementById(id), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const before = requests.length;
    const bodies = [];
    for (let poll = 0; poll < 2; poll++) bodies.push(await (await sessionPoll()).json());
    await sleep(500);
    const polled = requests.slice(before);
    assert.ok(bodies.every(body => body.issues === null && typeof body.issuesRevision === "string"), "unchanged polls carry no working set");
    assert.deepEqual(bodies.map(body => "tree" in body), [false, false], "the tree is built in the panel");
    assert.deepEqual(polled.filter(entry => entry.startsWith("GET /api/state")), [], `one request per poll: ${polled.join(", ")}`);
    assert.deepEqual(await page.evaluate(() => window.pollMutations), { tree: 0, inspector: 0 }, "unchanged polls rebuild nothing in the tree or inspector");
    console.log(`Same-value control rewrites left for PR-7 (M-13): ${await page.evaluate(() => window.controlRewrites)} over 2 polls.`);

    // A response for a revision the panel does not hold is never applied as current: the panel reads the full snapshot.
    await page.route("**/api/refresh-execution", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), issues: null, issuesRevision: "unknown:1" } });
    });
    const fallback = requests.length;
    const fullRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/state" && !new URL(response.url()).search, { timeout: 15_000 });
    await sessionPoll();
    await fullRead;
    await page.unroute("**/api/refresh-execution");
    assert.ok(requests.slice(fallback).includes("GET /api/state"), `full read after an unknown revision: ${requests.slice(fallback).join(", ")}`);
    assert.equal(await rows(), 300, "the working set is still shown in full");

    // A Jira change installs a new revision, and the next poll shows it.
    working = working.map(item => item.id === "2" ? { ...item, summary: "Needs your answer, renamed in Jira" } : item);
    await workbench.refresh({ fresh: true });
    const changed = await (await sessionPoll()).json();
    assert.ok(Array.isArray(changed.issues) && changed.issues.length === 300, "a new revision sends the working set");
    await page.waitForFunction(() => document.querySelector('#tree [data-node-id="2"]')?.textContent.includes("renamed in Jira"), null, { timeout: 5_000 });
    assert.match(await page.locator("#inspector-content h2").innerText(), /renamed in Jira/);
    await page.screenshot({ path: screenshotPath("poll.png") });
    assert.deepEqual(errors, []);
    console.log("PASS: 300 issues with linked sessions; unchanged session polls send no working set, make one request each and add, remove or replace no element in #tree or #inspector-content; a response for an unknown revision triggers a full read; a Jira change reaches the panel on the next poll. All services were synthetic; no Jira writes.");
} finally {
    await page.close();
    await browser.close();
    await server.close();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true });
}

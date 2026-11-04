import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser, screenshotPath, search } from "./browser.mjs";
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
    // Counts every mutation record: a rebuilt row, control or inspector section, and also a same-value rewrite of a
    // control's label, aria-busy, disabled or a feedback node's hidden flag, each of which still records a change.
    await page.evaluate(() => {
        window.pollMutations = { tree: 0, inspector: 0, controls: 0 };
        for (const [id, key] of [["tree", "tree"], ["inspector-content", "inspector"]])
            new MutationObserver(records => { window.pollMutations[key] += records.length; })
                .observe(document.getElementById(id), { subtree: true, childList: true, attributes: true, characterData: true });
        for (const control of document.querySelectorAll("header [data-action-key], #load-more, #repository"))
            new MutationObserver(records => { window.pollMutations.controls += records.length })
                .observe(control, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const before = requests.length;
    const bodies = [];
    for (let poll = 0; poll < 2; poll++) bodies.push(await (await sessionPoll()).json());
    await sleep(500);
    const polled = requests.slice(before);
    assert.ok(bodies.every(body => body.issues === null && typeof body.issuesRevision === "string"), "unchanged polls carry no working set");
    assert.deepEqual(bodies.map(body => "tree" in body), [false, false], "the tree is built in the panel");
    assert.deepEqual(polled.filter(entry => entry.startsWith("GET /api/state")), [], `one request per poll: ${polled.join(", ")}`);
    assert.deepEqual(await page.evaluate(() => window.pollMutations), { tree: 0, inspector: 0, controls: 0 },
        "unchanged polls write nothing in the tree, the inspector or the action controls");

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

    // A Jira change installs a new revision, and the next poll shows it, also in the row that has keyboard focus: the
    // changed row is replaced, focus stays on it, and every unchanged row is kept as the same element.
    await page.locator('#tree [data-node-id="2"] .row-select').focus();
    await page.evaluate(() => { window.keptRow = document.querySelector('#tree [data-node-id="3"]'); });
    working = working.map(item => item.id === "2" ? { ...item, summary: "Needs your answer, renamed in Jira" } : item);
    await workbench.refresh({ fresh: true });
    const changed = await (await sessionPoll()).json();
    assert.ok(Array.isArray(changed.issues) && changed.issues.length === 300, "a new revision sends the working set");
    await page.waitForFunction(() => document.querySelector('#tree [data-node-id="2"]')?.textContent.includes("renamed in Jira"), null, { timeout: 5_000 });
    assert.match(await page.locator("#inspector-content h2").innerText(), /renamed in Jira/);
    assert.deepEqual(await page.evaluate(() => ({
        focus: document.activeElement?.closest("#tree [data-node-id]")?.dataset.nodeId, key: document.activeElement?.dataset.focusKey,
        kept: window.keptRow === document.querySelector('#tree [data-node-id="3"]'),
    })), { focus: "2", key: "row:2", kept: true }, "the focused row updates in place and keeps focus; unchanged rows are kept");
    // Two rows can carry the same control key: one session or pull request linked to two issues, or the same refresh
    // action. Focus on such a control in a later row stays in that row when the row is rebuilt.
    const shared = await page.evaluate(() => {
        const [first, second] = document.querySelectorAll("#tree [data-node-id]");
        const control = second.querySelector(".row-action");
        first.querySelector(".row-action").dataset.focusKey = control.dataset.focusKey;
        control.focus();
        return { id: second.dataset.nodeId, key: control.dataset.focusKey, active: document.activeElement === control };
    });
    assert.ok(shared.active && shared.id !== "2", `a later row's action has focus: ${JSON.stringify(shared)}`);
    working = working.map(item => item.id === shared.id ? { ...item, summary: `${item.summary}, renamed again` } : item);
    await workbench.refresh({ fresh: true });
    await sessionPoll();
    await page.waitForFunction(id => document.querySelector(`#tree [data-node-id="${id}"]`)?.textContent.includes("renamed again"), shared.id, { timeout: 5_000 });
    assert.deepEqual(await page.evaluate(() => ({
        focus: document.activeElement?.closest("#tree [data-node-id]")?.dataset.nodeId, key: document.activeElement?.dataset.focusKey,
    })), { focus: shared.id, key: shared.key }, "focus returns to the control in its own row, not one with the same key in another row");

    // A poll that removes the focused row moves focus to the nearest remaining row (the next, else the previous), and
    // to the search field when no row is left, never to the page.
    const rename = async (id, summary) => {
        working = working.map(item => item.id === id ? { ...item, summary } : item);
        await workbench.refresh({ fresh: true });
        await sessionPoll();
        await page.waitForFunction(id => !document.querySelector(`#tree [data-node-id="${id}"]`), id, { timeout: 5_000 });
    };
    const focused = () => page.evaluate(() => ({ row: document.activeElement?.closest("#tree [data-node-id]")?.dataset.nodeId, id: document.activeElement?.id || document.activeElement?.tagName }));
    await search(page, "Generated work item 10");
    const order = await page.evaluate(() => [...document.querySelectorAll("#tree [data-node-id]")].map(row => row.dataset.nodeId));
    assert.equal(order.length, 10, `ten matching rows: ${order}`);
    await page.locator(`#tree [data-node-id="${order[4]}"] .row-select`).focus();
    await rename(order[4], "Moved out of the search");
    assert.equal((await focused()).row, order[5], "focus moves to the next row when the focused row leaves the list");
    await page.locator(`#tree [data-node-id="${order[9]}"] .row-select`).focus();
    await rename(order[9], "Also moved out of the search");
    assert.equal((await focused()).row, order[8], "focus moves to the previous row when the last row leaves the list");
    await search(page, order[0] === "100" ? "Generated work item 100" : `DEMO-${order[0]}`);
    await page.waitForFunction(() => document.querySelectorAll("#tree [data-node-id]").length === 1);
    await page.locator("#tree [data-node-id] .row-select").focus();
    await rename(await page.evaluate(() => document.querySelector("#tree [data-node-id]").dataset.nodeId), "Left the list entirely");
    assert.deepEqual(await focused(), { row: undefined, id: "search" }, "focus moves to the search field when no row is left");
    await search(page, "");
    await page.screenshot({ path: screenshotPath("poll.png") });
    assert.deepEqual(errors, []);
    console.log("PASS: 300 issues with linked sessions; unchanged session polls send no working set, make one request each and record no mutation in #tree, #inspector-content or the action controls; a response for an unknown revision triggers a full read; a Jira change reaches the panel on the next poll, including the focused row, which keeps focus (on its own control even when another row has one with the same key) while unchanged rows stay in place; when a poll removes the focused row, focus moves to the next or previous row, or to the search field when none is left. All services were synthetic; no Jira writes.");
} finally {
    await page.close();
    await browser.close();
    await server.close();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true });
}

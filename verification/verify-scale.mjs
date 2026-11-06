import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./browser.mjs";
import { createFixture, issues, seedProject } from "./fixture.mjs";

// UI budgets at 1,000 loaded issues, in all three views: the main-thread time a search keystroke costs (the key itself and
// the debounced render that follows), selecting a row, expanding a parent, ArrowDown, and an unchanged session poll.
// Each figure is a median after an untimed warm-up. Budgets sit well above what a loaded M-series laptop measures
// (keystroke under 130 ms, select 20 to 400 ms, expand 90 to 160 ms, poll under 200 ms), so a slower CI runner
// passes. Whole-list rebuilds cost more (v2.3.2: keystroke 460 to 590 ms, select 720 to 820 ms, expand 560 to 600 ms),
// and fail the structural checks below on any machine: a burst of keys renders once, a selection replaces only the
// two rows it changes, and a collapse removes rows without rebuilding the others.
const BUDGET = { keystroke: 400, select: 1000, expand: 600, arrow: 100, poll: 400 };
const directory = await mkdtemp(join(tmpdir(), "jira-workbench-scale-"));
const { workbench, gateway, startServer } = await createFixture({ directory });
// Ten epics of 99 stories each under the fixture's own items, so the hierarchy has depth and collapsible parents.
const extra = [];
for (let epic = 0; epic < 10; epic++) {
    const id = 1000 + epic * 100;
    extra.push({ ...issues[0], id: String(id), key: `DEMO-${id}`, summary: `Generated epic ${epic}`, parentKey: null });
    for (let n = 1; n < 100 && extra.length + issues.length < 1000; n++) {
        extra.push({ ...issues[5], id: String(id + n), key: `DEMO-${id + n}`, summary: `Generated story ${id + n} payment`, parentKey: `DEMO-${id}` });
    }
}
const working = [...issues, ...extra];
gateway.issues = async (site, project) => ({ issues: project === "42" ? working : [], fetchedAt: new Date().toISOString() });
await seedProject(workbench);
const server = await startServer(workbench);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(() => {
    window.longTasks = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
});

// Main-thread time from the action until the panel is idle: the action's own synchronous time plus every long task
// (over 50 ms) that follows it, including the debounced search render.
const cost = (action, arg) => page.evaluate(async ({ action, arg }) => {
    const before = window.longTasks.length, started = performance.now();
    if (action === "type") {
        const search = document.getElementById("search");
        search.value = arg;
        search.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (action === "select") document.querySelector(`#tree [data-node-id="${arg}"]`).click();
    else if (action === "toggle") document.querySelector(`#tree [data-node-id="${arg}"] button.toggle`).click();
    else if (action === "arrow") document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    void document.body.offsetHeight;
    const sync = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 300));
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const tasks = window.longTasks.slice(before);
    return Math.max(sync, tasks.reduce((sum, ms) => sum + ms, 0));
}, { action, arg });
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const results = {};

try {
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelectorAll("#tree [data-node-id]").length >= 900, null, { timeout: 60_000 });
    for (const view of ["execution", "hierarchy", "kanban"]) {
        await page.locator(`#view-${view}`).click();
        await page.waitForFunction(view => document.getElementById("tree").dataset.view === view && document.querySelectorAll("#tree [data-node-id]").length >= 900, view);
        for (const query of ["p", ""]) await cost("type", query);
        // The first actions after a 1,000-row load pay for JIT warm-up and collecting the load's garbage.
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
        for (const warm of await page.evaluate(() => [...document.querySelectorAll("#tree [data-node-id]")].slice(-3).map(row => row.dataset.nodeId))) await cost("select", warm);
        const typing = [];
        for (let round = 0; round < 3; round++) {
            for (const query of ["p", "pa", "pay"]) typing.push(await cost("type", query));
            typing.push(await cost("type", ""));
        }
        results[`${view} keystroke`] = median(typing);
        // Typing a burst renders once: the keys themselves do no tree work.
        const burst = await page.evaluate(async () => {
            const tree = document.getElementById("tree"), search = document.getElementById("search");
            let records = 0;
            const observer = new MutationObserver(list => { records += list.length; });
            observer.observe(tree, { childList: true, subtree: true });
            for (const query of ["g", "ge", "gen"]) { search.value = query; search.dispatchEvent(new Event("input", { bubbles: true })); }
            // Records are delivered after this task: take the pending ones now, or synchronous tree work would go unseen.
            const during = observer.takeRecords().length;
            await new Promise(resolve => setTimeout(resolve, 300));
            observer.disconnect();
            search.value = "";
            search.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 300));
            return { during, after: records };
        });
        assert.equal(burst.during, 0, `${view}: keys in a burst do not render the tree`);
        assert.ok(burst.after > 0, `${view}: the burst renders after the pause`);
        const ids = await page.evaluate(() => [...document.querySelectorAll("#tree [data-node-id]")].slice(20, 400).filter((_, i) => i % 60 === 0).map(row => row.dataset.nodeId));
        const select = [];
        for (const id of ids) select.push(await cost("select", id));
        results[`${view} select`] = median(select);
        // Rows added to the list by one more selection: the old and the new selected row, nothing else. Kanban cards sit
        // inside their columns, so rows are counted wherever they are added.
        const replaced = await page.evaluate(async id => {
            const tree = document.getElementById("tree");
            let added = 0;
            const observer = new MutationObserver(list => {
                for (const record of list) for (const node of record.addedNodes) if (node.dataset?.nodeId) added++;
            });
            observer.observe(tree, { childList: true, subtree: true });
            document.querySelector(`#tree [data-node-id="${id}"]`).click();
            await new Promise(resolve => setTimeout(resolve, 100));
            observer.disconnect();
            return added;
        }, ids[1]);
        assert.ok(replaced <= 2, `${view}: a selection replaced ${replaced} rows`);
        const arrows = [];
        await page.locator(`#tree [data-node-id="${ids[0]}"] ${view === "hierarchy" ? "" : ".row-select"}`.trim()).focus();
        for (let n = 0; n < 6; n++) arrows.push(await cost("arrow"));
        results[`${view} ArrowDown`] = median(arrows);
        assert.notEqual(await page.evaluate(() => document.activeElement.closest("[data-node-id]")?.dataset.nodeId), ids[0], `${view}: ArrowDown moves focus`);
        if (view === "hierarchy") {
            const toggles = [];
            for (let n = 0; n < 4; n++) toggles.push(await cost("toggle", "1000"));
            results["hierarchy expand"] = median(toggles);
            const collapse = await page.evaluate(async () => {
                const tree = document.getElementById("tree"), before = tree.children.length;
                let added = 0;
                const observer = new MutationObserver(list => { for (const record of list) added += record.addedNodes.length; });
                observer.observe(tree, { childList: true });
                document.querySelector('#tree [data-node-id="1000"] button.toggle').click();
                await new Promise(resolve => setTimeout(resolve, 100));
                observer.disconnect();
                const after = tree.children.length;
                document.querySelector('#tree [data-node-id="1000"] button.toggle').click();
                return { before, after, added };
            });
            assert.ok(collapse.after < collapse.before && collapse.added <= 1, `collapse rebuilt rows: ${JSON.stringify(collapse)}`);
        }
        // An unchanged session poll: the time from its response to the end of the work it causes.
        const polls = [];
        for (let n = 0; n < 3; n++) {
            await page.evaluate(() => { window.pollBefore = window.longTasks.length; });
            await page.waitForResponse(response => response.url().includes("/api/refresh-execution"), { timeout: 15_000 });
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
            polls.push(await page.evaluate(() => window.longTasks.slice(window.pollBefore).reduce((sum, ms) => sum + ms, 0)));
        }
        results[`${view} unchanged poll`] = median(polls);
    }
    console.log(Object.entries(results).map(([name, ms]) => `${name}: ${ms.toFixed(0)} ms`).join("; "));
    for (const [name, ms] of Object.entries(results)) {
        const budget = name.endsWith("keystroke") ? BUDGET.keystroke : name.endsWith("select") ? BUDGET.select : name.endsWith("expand") ? BUDGET.expand
            : name.endsWith("ArrowDown") ? BUDGET.arrow : BUDGET.poll;
        assert.ok(ms <= budget, `${name}: ${ms.toFixed(0)} ms over the ${budget} ms budget at 1,000 issues`);
    }
    assert.deepEqual(errors, []);
    console.log("PASS: 1,000 loaded issues in all three views; a search keystroke, row selection, expand, ArrowDown and an unchanged session poll stay within their main-thread budgets; a typing burst renders the tree once, a selection replaces only its two rows, and a collapse rebuilds only the toggled row. All services were synthetic; no Jira writes.");
} finally {
    await page.close();
    await browser.close();
    await server.close();
    workbench.close();
    await workbench.idle();
    await rm(directory, { recursive: true, force: true });
}

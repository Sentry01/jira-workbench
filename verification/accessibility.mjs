// WCAG 2.2 AA checks for the canvas, run by verify-canvas.mjs against the fake fixture. Each check reproduces a
// failure found in review: a ticking alert region, low-contrast status text, small targets, focus dropped to the
// page, a parent row focused out of view, re-announced notices, tooltips that cannot be hovered or dismissed, and a
// tab stop for every row control.
import assert from "node:assert/strict";

// Stand-ins for the host's dark theme tokens (GitHub Primer dark). The real values are not in this repository.
// --true-color-purple is left unset on purpose, so the hard-coded fallback hue is checked too.
const DARK_TOKENS = {
    "--background-color-default": "#0d1117", "--text-color-default": "#e6edf3", "--text-color-muted": "#9198a1",
    "--border-color-default": "#3d444d", "--true-color-blue": "#4493f8", "--true-color-green": "#3fb950", "--true-color-red": "#f85149",
};

// Elements whose text carries status, rendered once as probes so every state is measured whatever the data shows.
const PROBES = `
<span class="badge done">Done</span><span class="badge session">Session: idle</span><span class="badge merged">#14 merged</span>
<span class="badge pr">#12 open</span><span class="badge indeterminate">In Progress</span><span class="badge new">To Do</span><span class="badge">No linked activity</span>
<span class="type-icon epic">E</span><span class="type-icon story">S</span><span class="type-icon subtask">T</span>
<ol class="progress-tracker"><li class="progress-step disabled"><span class="progress-label">In Jira</span><span class="progress-count">7 of 7 (unverified)</span></li></ol>
<button class="primary" type="button">Start session</button>`;

// Runs in the page: WCAG contrast of each element's text against the background it is drawn on.
function measure(selectors) {
    const parse = value => {
        const rgb = value.match(/^rgba?\(([^)]+)\)/);
        if (rgb) { const [r, g, b, a = 1] = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; }
        const srgb = value.match(/^color\(srgb ([^)]+)\)/);
        if (srgb) { const [r, g, b, a = 1] = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number); return [r * 255, g * 255, b * 255, a]; }
        throw new Error(`Unparsed color: ${value}`);
    };
    const over = (top, bottom) => top.slice(0, 3).map((channel, i) => channel * top[3] + bottom[i] * (1 - top[3]));
    const luminance = color => {
        const [r, g, b] = color.map(channel => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const background = element => {
        const layers = [];
        for (let node = element; node; node = node.parentElement) {
            const color = parse(getComputedStyle(node).backgroundColor);
            if (color[3] > 0) layers.push(color);
            if (color[3] >= 1) break;
        }
        return layers.reverse().reduce((base, layer) => over(layer, base), [255, 255, 255]);
    };
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length).map(node => {
        let opacity = 1;
        for (let current = node; current; current = current.parentElement) opacity *= Number(getComputedStyle(current).opacity);
        const fg = parse(getComputedStyle(node).color), bg = background(node);
        return { selector, text: node.textContent.trim().slice(0, 40), ratio: Math.round(ratio(over([...fg.slice(0, 3), fg[3] * opacity], bg), bg) * 100) / 100 };
    }));
}

async function contrast(page, theme) {
    await page.evaluate(html => {
        const probe = document.createElement("div");
        probe.id = "a11y-probe";
        probe.style.cssText = "position: absolute; inset: 0 auto auto 0; display: flex; gap: 4px; background: var(--surface)";
        probe.innerHTML = html;
        document.body.append(probe);
    }, PROBES);
    try {
        const text = await page.evaluate(measure, [
            "#a11y-probe .badge", "#a11y-probe .type-icon", "#a11y-probe .progress-label", "#a11y-probe .progress-count", "#a11y-probe .primary",
            "#tree .badge", "#tree .type-icon", ".progress-step.disabled .progress-label", ".progress-step.disabled .progress-count",
        ]);
        assert.ok(text.some(entry => entry.selector === ".progress-step.disabled .progress-count"), `${theme}: an unverified progress step is shown`);
        const failing = text.filter(entry => entry.ratio < 4.5);
        assert.deepEqual(failing, [], `${theme}: status text is at least 4.5:1`);
        // Non-text contrast (1.4.11): the input boundary is 3:1, and the pressed view is not shown by color alone.
        const ui = await page.evaluate(() => {
            const search = document.getElementById("search"), style = getComputedStyle(search);
            const probe = document.createElement("span");
            probe.style.color = style.borderTopColor;
            probe.style.backgroundColor = style.backgroundColor;
            probe.className = "a11y-border-probe";
            document.getElementById("a11y-probe").append(probe);
            const pressed = document.querySelector('.view-switch button[aria-pressed="true"]'), unpressed = document.querySelector('.view-switch button[aria-pressed="false"]');
            return { pressedShadow: getComputedStyle(pressed).boxShadow, unpressedShadow: getComputedStyle(unpressed).boxShadow };
        });
        const [border] = await page.evaluate(measure, [".a11y-border-probe"]);
        assert.ok(border.ratio >= 3, `${theme}: input border ${border.ratio}:1 is at least 3:1`);
        assert.match(ui.pressedShadow, /inset/, `${theme}: the pressed view has an underline`);
        assert.equal(ui.unpressedShadow, "none");
        return text.length;
    } finally {
        await page.evaluate(() => document.getElementById("a11y-probe")?.remove());
    }
}

async function reconnecting(page, workbench) {
    const connection = workbench.connection, nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    workbench.connection = {
        status: () => ({ state: "offline", reason: "Atlassian MCP server unreachable", server: "atlassian", connector: false, nextCheckAt }),
        read: (run, options) => run(options), current: { state: "offline" }, signIn: async () => ({}),
    };
    workbench.error = "Jira unreachable";
    try {
        await page.waitForFunction(() => document.getElementById("errors").textContent.includes("Reconnecting automatically"));
        assert.match(await page.locator("#retry-time").innerText(), /^Next attempt at .+\.$/);
        // The panel polls every second while reconnecting; the alert region must not change while the state does not.
        const mutations = await page.evaluate(() => new Promise(resolve => {
            let count = 0;
            const observer = new MutationObserver(list => { count += list.length; });
            observer.observe(document.getElementById("errors"), { childList: true, subtree: true, characterData: true });
            setTimeout(() => { observer.disconnect(); resolve(count); }, 5_000);
        }));
        assert.equal(mutations, 0, "the role=alert region is not rewritten while reconnecting");
        // Contrast, while the stale Jira data shows unverified progress steps.
        const light = await contrast(page, "light");
        await page.emulateMedia({ colorScheme: "dark" });
        // Set through the CSSOM: the panel's CSP blocks injected style elements.
        await page.evaluate(tokens => { for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value); }, DARK_TOKENS);
        const dark = await contrast(page, "dark");
        assert.ok(light > 10 && dark > 10, "status text was measured");
    } finally {
        workbench.connection = connection;
        workbench.error = null;
        await page.evaluate(tokens => { for (const name of Object.keys(tokens)) document.documentElement.style.removeProperty(name); }, DARK_TOKENS);
        await page.emulateMedia({ colorScheme: "light" });
    }
    await page.waitForFunction(() => document.getElementById("errors").hidden && document.getElementById("retry-time").hidden);
}

async function targets(page) {
    const small = () => page.$$eval("#tree button, #tree summary", nodes => nodes.filter(node => node.getClientRects().length).map(node => {
        const box = node.getBoundingClientRect();
        return { text: node.getAttribute("aria-label") || node.textContent.trim().slice(0, 30), width: box.width, height: box.height };
    }).filter(box => box.width < 24 || box.height < 24));
    await page.locator("#view-hierarchy").click();
    await page.waitForFunction(() => document.querySelector("#tree .toggle"));
    assert.deepEqual(await small(), [], "hierarchy targets are at least 24 by 24");
    await page.locator("#view-execution").click();
    await page.waitForFunction(() => document.querySelector("#tree .execution-evidence summary"));
    assert.deepEqual(await small(), [], "queue targets are at least 24 by 24");
}

async function rowsAndTabStops(page) {
    const rows = await page.$$eval("#tree [data-node-id]", nodes => nodes.map(node => ({
        role: node.getAttribute("role"), focusable: node.hasAttribute("tabindex"), select: Boolean(node.querySelector(":scope .row-select")),
    })));
    assert.ok(rows.length > 3);
    assert.ok(rows.every(row => row.role === "listitem" && !row.focusable && row.select), "a queue row is a plain list item with a select button");
    const stops = () => page.$$eval("#tree *", nodes => {
        const tabbable = nodes.filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length);
        return { count: tabbable.length, rows: new Set(tabbable.map(node => node.closest("[data-node-id]")?.dataset.nodeId)).size };
    });
    const first = await stops();
    assert.equal(first.rows, 1, `only one row is in the tab order: ${JSON.stringify(first)}`);
    const select = page.locator("#tree .row-select").nth(1);
    await select.focus();
    await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("row-select")), true, "arrow keys move between rows");
    assert.deepEqual(await stops(), first, "moving between rows keeps one tab stop");
    await page.locator("#skip-to-details").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "inspector", "the skip link moves past the list");
    assert.equal(await page.locator(".source-freshness").getAttribute("role"), "group");
}

async function arrowLeftInView(page) {
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.locator("#view-hierarchy").click();
    await page.locator("#expand").click();
    await page.waitForFunction(() => document.querySelectorAll('#tree [role="treeitem"]').length === 8);
    await page.evaluate(() => {
        const scroller = document.getElementById("work-scroll");
        scroller.scrollTop = scroller.scrollHeight;
        document.querySelector('#tree [data-node-id="7"]').focus({ preventScroll: true });
    });
    const parentHidden = await page.evaluate(() => {
        const row = document.querySelector('#tree [data-node-id="1"]').getBoundingClientRect(), scroller = document.getElementById("work-scroll").getBoundingClientRect();
        return row.bottom <= scroller.top || row.top >= scroller.bottom;
    });
    assert.equal(parentHidden, true, "the parent starts out of view");
    await page.keyboard.press("ArrowLeft");
    const placed = await page.evaluate(() => {
        const row = document.activeElement.getBoundingClientRect(), scroller = document.getElementById("work-scroll").getBoundingClientRect();
        const header = document.getElementById("hierarchy-header").getBoundingClientRect();
        return { id: document.activeElement.dataset.nodeId, top: row.top, bottom: row.bottom, headerBottom: header.bottom, scrollerBottom: scroller.bottom };
    });
    assert.equal(placed.id, "1");
    assert.ok(placed.top >= placed.headerBottom - 1 && placed.bottom <= placed.scrollerBottom + 1, `ArrowLeft keeps the parent in view, below the header: ${JSON.stringify(placed)}`);
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator("#view-execution").click();
}

async function tooltips(page) {
    const tip = () => page.evaluate(() => {
        const style = getComputedStyle(document.getElementById("freshness"), "::after");
        return style.content !== "none" && style.display !== "none";
    });
    await page.locator("#freshness").hover();
    assert.equal(await tip(), true, "hovering shows the detail");
    const box = await page.locator("#freshness").boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height + 12, { steps: 6 });
    assert.equal(await tip(), true, "the pointer can move onto the tooltip");
    await page.keyboard.press("Escape");
    assert.equal(await tip(), false, "Escape dismisses it");
    await page.mouse.move(0, 0);
    await page.locator("#freshness").hover();
    assert.equal(await tip(), true, "it shows again on the next hover");
    await page.mouse.move(0, 0);
}

// Runs an action from the keyboard with its request slowed down, and reports where focus is during and after it.
async function keyboardAction(page, control, route) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const handler = async request => { await held; await request.continue(); };
    await page.route(route, handler);
    try {
        await control.focus();
        const key = await control.evaluate(node => node.dataset.actionKey);
        await page.keyboard.press("Enter");
        await page.waitForFunction(actionKey => [...document.querySelectorAll("[data-action-key]")]
            .some(node => node.dataset.actionKey === actionKey && node.getAttribute("aria-busy") === "true"), key);
        const during = await page.evaluate(() => document.activeElement === document.body ? "BODY" : document.activeElement.dataset.actionKey || document.activeElement.id);
        release();
        await page.waitForFunction(actionKey => ![...document.querySelectorAll("[data-action-key]")]
            .some(node => node.dataset.actionKey === actionKey && node.getAttribute("aria-busy") === "true"), key);
        await page.waitForTimeout(100);
        const after = await page.evaluate(() => document.activeElement === document.body ? "BODY" : document.activeElement.dataset.actionKey || document.activeElement.id);
        return { key, during, after };
    } finally {
        await page.unroute(route, handler);
    }
}

// Where the focused element is drawn: inside the viewport, and inside #work-scroll's visible box when it lives there.
const focusInView = page => page.evaluate(() => {
    const active = document.activeElement, box = active.getBoundingClientRect(), scroller = document.getElementById("work-scroll");
    const within = (inner, outer) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
    const viewport = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    return { focused: active.id || active.textContent.trim().slice(0, 30), inViewport: within(box, viewport),
        inScroller: !scroller.contains(active) || within(box, scroller.getBoundingClientRect()) };
});

// Dismissing the last notice from the top of a scrolled page returns focus to the row control that ran the action,
// which sits below the viewport and outside #work-scroll's visible box. Focus must be brought into view.
async function scrolledDismiss(page) {
    await page.evaluate(() => { for (const dismiss of document.querySelectorAll("#notice button")) if (!dismiss.hidden) dismiss.click(); });
    await page.setViewportSize({ width: 1440, height: 500 });
    const answer = page.locator('#tree [data-node-id="2"]').getByRole("button", { name: "Answer question", exact: true });
    await answer.click();
    const notice = page.locator("#notice .action-notice", { hasText: "acknowledged" });
    await notice.waitFor();
    await page.evaluate(() => {
        const scroller = document.getElementById("work-scroll");
        scroller.scrollTop = scroller.scrollHeight;
        scrollTo(0, 0);
    });
    await notice.getByRole("button").focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await focusInView(page), { focused: "Answer question", inViewport: true, inScroller: true },
        "focus after Dismiss is on the action's control, scrolled into view");
    await page.setViewportSize({ width: 1440, height: 1080 });
}

async function focusKept(page) {
    const header = [["#refresh-execution", "**/api/refresh-execution"], ["#connections", "**/api/catalog"], ["#refresh", "**/api/refresh"]];
    for (const [selector, route] of header) {
        const result = await keyboardAction(page, page.locator(selector), route);
        assert.equal(result.during, result.key, `${selector} keeps focus while pending`);
        assert.equal(result.after, result.key, `${selector} has focus when it finishes`);
    }
    // Notices: role=status is atomic by default, so the region must opt out to announce only the changed row.
    assert.equal(await page.locator("#notice").getAttribute("aria-atomic"), "false");
    // The next action adds one row and leaves the rows already announced in place.
    const before = await page.$$eval("#notice > .action-notice", rows => rows.length);
    await page.evaluate(() => { window.__noticeRows = [...document.querySelectorAll("#notice > .action-notice")]; window.__noticeAdds = 0;
        new MutationObserver(list => { for (const record of list) window.__noticeAdds += record.addedNodes.length; }).observe(document.getElementById("notice"), { childList: true }); });
    const answer = page.locator('#tree [data-node-id="2"]').getByRole("button", { name: "Answer question", exact: true });
    const row = await keyboardAction(page, answer, "**/api/open");
    assert.notEqual(row.during, "BODY", "a row action keeps focus while pending");
    assert.notEqual(row.after, "BODY", "a row action keeps focus when it finishes");
    const notices = await page.evaluate(() => ({ adds: window.__noticeAdds, kept: window.__noticeRows.every(node => node.isConnected) }));
    assert.ok(notices.adds <= 1 && notices.kept, `existing notices are not rebuilt: ${JSON.stringify(notices)} (${before} before)`);
    // Dismiss removes its own button; focus moves on instead of dropping to the page.
    const dismiss = page.locator("#notice button:visible").first();
    await dismiss.focus();
    await page.keyboard.press("Enter");
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY", "focus survives Dismiss");
}

async function launchFocus(page) {
    await page.locator("#search").fill("Ready example");
    const prepare = page.locator('#tree [data-node-id="6"]').getByRole("button", { name: "Prepare implementation", exact: true });
    await prepare.focus();
    await page.keyboard.press("Enter");
    await page.locator("#launch-dialog[open]").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("launch-dialog").open);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Prepare implementation", "Cancel returns focus to the Start button");
    await page.keyboard.press("Enter");
    await page.locator("#launch-dialog[open]").waitFor();
    await page.locator("#launch-mode").selectOption("plan");
    const reviewed = page.waitForResponse(response => response.url().endsWith("/api/prepare") && response.ok());
    await page.locator("#review-changes").click();
    await (await reviewed).finished();
    await page.waitForFunction(() => !document.getElementById("confirm-launch").disabled);
    // Confirm from a scrolled page: the notice that takes focus is above the viewport.
    await page.setViewportSize({ width: 1440, height: 500 });
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.locator("#confirm-launch").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.getElementById("launch-dialog").open);
    const active = await focusInView(page);
    assert.deepEqual(active, { focused: "notice", inViewport: true, inScroller: true }, "after a confirmed launch, focus moves to the notice that reports it, in view");
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator("#search").fill("");
}

// In the narrow details view the list is hidden. Dismissing the last notice for an action that has a control both in
// the hidden list and in the details must focus a visible element, not the hidden row control or the hidden search.
async function narrowDismiss(page) {
    await page.evaluate(() => { for (const dismiss of document.querySelectorAll("#notice button")) if (!dismiss.hidden) dismiss.click(); });
    await page.setViewportSize({ width: 600, height: 960 });
    const back = page.getByRole("button", { name: "Back to work", exact: true });
    if (await back.isVisible()) await back.click();
    await page.locator('#tree [data-node-id="3"] .row-select').click();
    const review = page.locator("#inspector").getByRole("button", { name: "Review PR", exact: true });
    await review.click();
    const notice = page.locator("#notice .action-notice", { hasText: "acknowledged" });
    await notice.waitFor();
    await notice.getByRole("button").focus();
    await page.keyboard.press("Enter");
    const active = await page.evaluate(() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent,
        inInspector: document.getElementById("inspector").contains(document.activeElement), rendered: document.activeElement.getClientRects().length > 0 }));
    assert.deepEqual(active, { tag: "BUTTON", text: "Review PR", inInspector: true, rendered: true }, "focus after Dismiss is on the visible control that ran the action");
    await back.click();
    await page.setViewportSize({ width: 1440, height: 1080 });
}

/** Runs every check; the caller's page must show the seeded demo project at its default size. Queues one launch. */
export async function verifyAccessibility({ page, workbench }) {
    await reconnecting(page, workbench);
    await targets(page);
    await rowsAndTabStops(page);
    await arrowLeftInView(page);
    await tooltips(page);
    await focusKept(page);
    await launchFocus(page);
    await narrowDismiss(page);
    await scrolledDismiss(page);
}

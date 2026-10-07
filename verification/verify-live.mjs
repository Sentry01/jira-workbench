import { launchBrowser } from "./browser.mjs";
import assert from "node:assert/strict";

const address = new URL(process.env.WORKBENCH_URL);
const token = address.hash.slice(1);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const readState = async () => {
    const response = await page.request.get(`${address.origin}/api/state`, { headers: { "x-workbench-token": token } });
    assert.equal(response.status(), 200);
    return response.json();
};
try {
    await page.goto(address.href);
    const before = await readState();
    assert.equal(before.error, null);
    assert.ok(before.issues.length > 0);
    const item = before.issues.find(issue => before.links[`${before.scope.slice(0, before.scope.lastIndexOf("/") + 1)}${issue.id}`]?.prs.length);
    assert.ok(item, "An existing verified PR is needed for this read-only navigation check");
    await page.waitForFunction(() => document.getElementById("project-title").textContent !== "Your work, connected.");
    await page.locator("#search").fill(item.key);
    await page.getByText(item.summary, { exact: true }).first().click();
    const navigation = page.waitForResponse(response => response.url().endsWith("/api/open-pr"));
    await page.locator("#inspector").getByRole("button", { name: "Open PR", exact: true }).first().click();
    const receipt = await (await navigation).json();
    assert.equal(receipt.status, "acknowledged", JSON.stringify(receipt));
    const after = await readState();
    assert.equal(after.requests.length, before.requests.length, "Navigation must not create ticket work");
    assert.equal(after.preferences.selected, item.id);
    assert.deepEqual(errors, []);
    const cleared = page.waitForResponse(response => response.url().endsWith("/api/preferences") && response.ok()
        && response.request().postDataJSON()?.preferences?.query === "");
    await page.locator("#search").fill("");
    await cleared;
    console.log(JSON.stringify({
        project: before.project.key, issues: before.issues.length, linkedIssue: item.key,
        primary: before.executions.find(row => row.nodeId === item.id)?.primary,
        nativeNavigation: receipt.status, newLaunches: after.requests.length - before.requests.length,
    }));
} finally {
    await browser.close();
}

import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_EXECUTABLE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

export function launchBrowser() {
    const executablePath = process.env.BROWSER_EXECUTABLE || DEFAULT_EXECUTABLE;
    if (!existsSync(executablePath)) {
        throw new Error(`No browser at ${executablePath}. Set BROWSER_EXECUTABLE to a Chrome, Edge, or Chromium binary.`);
    }
    return chromium.launch({ executablePath, headless: process.env.HEADED !== "1" });
}

export function screenshotPath(name) {
    const directory = process.env.SCREENSHOT_DIR || join(tmpdir(), "jira-workbench-verification");
    mkdirSync(directory, { recursive: true });
    return join(directory, name);
}

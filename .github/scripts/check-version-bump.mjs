// Fails when a change to the shipped canvas does not raise the plugin version, so no change merges unreleased.
// Usage: node .github/scripts/check-version-bump.mjs [base-ref] [repository-root]
// CI runs it on pull requests, where HEAD is the merge commit and HEAD^1 is the base branch.
// NO_RELEASE=true (the no-release label) skips it for a change that should wait for a later release.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const base = process.argv[2] || "HEAD^1";
const root = resolve(process.argv[3] || ".");
const PLUGIN_FILE = ".github/plugin/plugin.json";
const SHIPPED = "extensions/jira-workbench/";
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const fail = (message, file = PLUGIN_FILE) => {
    console.log(`::error file=${file}::${message}`);
    process.exit(1);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Tests and Markdown do not reach users; everything else under the extension does.
const isShipped = file => file.startsWith(SHIPPED) && !file.startsWith(`${SHIPPED}test/`) && !file.endsWith(".md");

let changed;
// --no-renames lists both sides of a rename, so moving a shipped file out of the extension still counts.
try { changed = git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean); }
catch (error) { fail(`Cannot list the files changed since ${base}: ${String(error.stderr || error.message).trim()}`); }

const shipped = changed.filter(isShipped);
if (!shipped.length) {
    console.log(`No change to the shipped canvas since ${base}; no new version needed.`);
    process.exit(0);
}
if (process.env.NO_RELEASE === "true") {
    console.log(`::notice::The shipped canvas changed, but the pull request has the no-release label; the version check is skipped.`);
    process.exit(0);
}

const versionOf = (text, where) => {
    let version;
    try { version = JSON.parse(text)?.version; }
    catch (error) { fail(`${PLUGIN_FILE} ${where} cannot be read: ${error.message}`); }
    const parts = VERSION.exec(typeof version === "string" ? version : "");
    if (!parts) fail(`${PLUGIN_FILE} ${where} has "version" ${JSON.stringify(version)}; it must be MAJOR.MINOR.PATCH.`);
    return { text: version, core: parts.slice(1, 4).map(Number), pre: parts[4]?.split(".") ?? null };
};

// Semantic Versioning precedence: numeric core first; a prerelease ranks below its release.
const compareIdentifier = (a, b) => {
    const [na, nb] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (na && nb) return Number(a) - Number(b);
    if (na !== nb) return na ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
};
const compare = (a, b) => {
    for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
    if (!a.pre || !b.pre) return (a.pre ? -1 : 0) - (b.pre ? -1 : 0);
    for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
        const order = compareIdentifier(a.pre[i], b.pre[i]);
        if (order) return order;
    }
    return a.pre.length - b.pre.length;
};

let baseText;
try { baseText = git("show", `${base}:${PLUGIN_FILE}`); }
catch (error) { fail(`Cannot read ${PLUGIN_FILE} at ${base}: ${String(error.stderr || error.message).trim()}`); }
let headText;
try { headText = readFileSync(join(root, PLUGIN_FILE), "utf8"); }
catch (error) { fail(`${PLUGIN_FILE} cannot be read: ${error.message}`); }

const before = versionOf(baseText, `at ${base}`);
const after = versionOf(headText, "in this change");
if (compare(after, before) <= 0) {
    fail(`This change ships new canvas code (${shipped.join(", ")}) but "version" is ${JSON.stringify(after.text)}, `
        + `not higher than ${JSON.stringify(before.text)} at ${base}. Raise it in plugin.json and marketplace.json `
        + `(see Releasing in CONTRIBUTING.md), or add the no-release label to the pull request.`);
}

console.log(`The shipped canvas changed and the version rises from ${before.text} to ${after.text}.`);

// Checks that the plugin and marketplace manifests describe one release, and prints its tag.
// Usage: node .github/scripts/check-release.mjs [repository-root]
// CI runs it on every pull request; the release workflow runs it before creating the tag.
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const PLUGIN_FILE = ".github/plugin/plugin.json";
const MARKETPLACE_FILE = ".github/plugin/marketplace.json";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const errors = [];
const fail = (file, message) => errors.push({ file, message });

const read = file => {
    let value;
    try { value = JSON.parse(readFileSync(join(root, file), "utf8")); }
    catch (error) { fail(file, `cannot be read: ${error.message}`); return null; }
    // A valid JSON scalar or array (null, "x", []) is not a manifest; accepting null once yielded a "null" tag.
    if (!value || typeof value !== "object" || Array.isArray(value)) { fail(file, "must contain a JSON object."); return null; }
    return value;
};

const plugin = read(PLUGIN_FILE);
const marketplace = read(MARKETPLACE_FILE);
let tag = null;

if (plugin) {
    if (!VERSION.test(plugin.version || "")) fail(PLUGIN_FILE, `"version" must be MAJOR.MINOR.PATCH, not ${JSON.stringify(plugin.version)}.`);
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(plugin.repository || "")?.[1];
    if (!repo) fail(PLUGIN_FILE, `"repository" must be a https://github.com/OWNER/REPO URL.`);
    const entry = marketplace?.plugins?.find(item => item?.name === plugin.name);
    if (marketplace && !entry) fail(MARKETPLACE_FILE, `has no plugin entry named ${JSON.stringify(plugin.name)}.`);
    if (entry && VERSION.test(plugin.version || "") && repo) {
        tag = `v${plugin.version}`;
        const expected = { source: "github", repo, ref: tag };
        const pinned = entry.source && typeof entry.source === "object" && Object.keys(entry.source).length === Object.keys(expected).length
            && Object.entries(expected).every(([key, value]) => entry.source[key] === value);
        if (entry.version !== plugin.version) fail(MARKETPLACE_FILE, `"version" is ${JSON.stringify(entry.version)}; plugin.json says ${JSON.stringify(plugin.version)}.`);
        if (!pinned) fail(MARKETPLACE_FILE, `"source" must pin the release: ${JSON.stringify(expected)}. Found ${JSON.stringify(entry.source)}.`);
    }
}

if (!errors.length && !tag) fail(PLUGIN_FILE, "does not name a release.");
if (errors.length) {
    for (const { file, message } of errors) console.log(`::error file=${file}::${file} ${message}`);
    process.exit(1);
}

console.log(`Release ${tag}: plugin.json and marketplace.json agree.`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nversion=${plugin.version}\n`);

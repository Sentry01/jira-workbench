// Points this plugin's Awesome Copilot listing (plugins/external.json in github/awesome-copilot) at a release.
// Usage: node .github/scripts/awesome-copilot-listing.mjs <external.json> <name> <owner/repo> <version> <sha>
// Changes only version, source.ref and source.sha of the matching entry; other fields go through upstream review.
// Prints and writes changed=true|false to GITHUB_OUTPUT. The awesome-copilot-sync workflow runs it.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [file, name, repo, version, sha] = process.argv.slice(2);
const die = message => { console.error(`::error::${message}`); process.exit(1); };

if (!file || !name || !repo || !version || !sha) die("usage: awesome-copilot-listing.mjs <external.json> <name> <owner/repo> <version> <sha>");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) die(`version must be MAJOR.MINOR.PATCH, not ${JSON.stringify(version)}.`);
if (!/^[0-9a-f]{40}$/.test(sha)) die(`sha must be a full 40-character commit SHA, not ${JSON.stringify(sha)}.`);

const text = readFileSync(file, "utf8");
const listings = JSON.parse(text);
if (!Array.isArray(listings)) die(`${file} must contain a JSON array.`);
const entries = listings.filter(item => item?.name === name && item?.source?.source === "github" && item.source.repo === repo);
// A new listing must go through the upstream submission issue, never a direct edit.
if (entries.length !== 1) die(`${file} must have exactly one GitHub entry named ${JSON.stringify(name)} from ${repo}; found ${entries.length}.`);

const [entry] = entries;
const ref = `v${version}`;
const changed = entry.version !== version || entry.source.ref !== ref || entry.source.sha !== sha;
if (changed) {
    Object.assign(entry, { version });
    Object.assign(entry.source, { ref, sha });
    // Upstream keeps the file in JSON.stringify(_, null, 2) form, so this rewrite touches only the changed lines.
    writeFileSync(file, `${JSON.stringify(listings, null, 2)}\n`);
}
console.log(changed ? `Listing now pins ${name} ${ref} at ${sha}.` : `Listing already pins ${name} ${ref} at ${sha}.`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);

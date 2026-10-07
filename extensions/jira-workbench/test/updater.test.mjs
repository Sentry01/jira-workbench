import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildLabel, detectInstall, readIdentity, treeHash } from "../lib/version.mjs";
import { Updater, releasePin } from "../lib/updater.mjs";

const exec = promisify(execFile);
const HEAD = "a".repeat(40), UPSTREAM = "b".repeat(40), OTHER = "c".repeat(40);
const TREE = "1".repeat(40), REMOTE_TREE = "2".repeat(40);

// A scripted git/gh: each key is the argv after `git -C <root>` (or `gh`), joined by spaces.
function fakeRun(script) {
    const calls = [];
    const run = async (exe, args) => {
        const key = exe === "git" ? args.slice(2).join(" ") : `gh ${args[0]} ${args[1]}`;
        calls.push(key);
        const value = typeof script[key] === "function" ? script[key]() : script[key];
        if (value === undefined || value instanceof Error) throw value || new Error(`unexpected: ${key}`);
        return { stdout: `${value}\n` };
    };
    return { run, calls };
}

const gitScript = (overrides = {}) => ({
    "rev-parse HEAD": HEAD,
    "symbolic-ref --short -q HEAD": "main",
    "config --get branch.main.remote": "origin",
    "config --get branch.main.merge": "refs/heads/main",
    "fetch --quiet --no-tags origin refs/heads/main": "",
    "rev-parse @{u}": UPSTREAM,
    "merge-base --is-ancestor HEAD @{u}": "",
    "rev-list --count HEAD..@{u}": "3",
    "log -1 --format=%cs @{u}": "2026-09-30",
    "status --porcelain --untracked-files=no": "",
    "merge --ff-only @{u}": "",
    ...overrides,
});
const gitIdentity = { kind: "git", head: HEAD, commit: HEAD.slice(0, 7), date: "2026-09-28", dirty: false, tree: null, version: "1.0.0", repo: "example/demo" };
const install = { kind: "git", root: "/repo/extensions/jira-workbench", repoRoot: "/repo" };
const fakeSession = () => {
    const calls = [];
    return {
        calls,
        connection: { sendRequest: async (method, params) => {
            calls.push([method, params]);
            return method === "plugins.list" ? { plugins: [{ name: "other" }, { name: "jira-workbench", marketplace: "jira-workbench" }] } : {};
        } },
        rpc: {
            extensions: { reload: async () => { calls.push(["extensions.reload"]); } },
            plugins: { reload: async params => { calls.push(["plugins.reload", params]); } },
        },
    };
};

test("tree hash matches git's tree object ID, ignoring local-only files", async t => {
    const dir = await mkdtemp(join(tmpdir(), "jw-tree-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, "lib"), { recursive: true });
    await mkdir(join(dir, "empty"));
    await writeFile(join(dir, "extension.mjs"), "export {};\n");
    await writeFile(join(dir, "lib", "a.mjs"), "a\n");
    await writeFile(join(dir, "lib-b.mjs"), "sorts between lib/ and lib.c\n");
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    await symlink("extension.mjs", join(dir, "link.mjs"));
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "add", "-A"]);
    const { stdout } = await exec("git", ["-C", dir, "write-tree"]);
    await mkdir(join(dir, "artifacts", ".local"), { recursive: true });
    await writeFile(join(dir, "artifacts", ".local", "state.json"), "{}");
    await writeFile(join(dir, ".DS_Store"), "x");
    assert.equal(await treeHash(dir), stdout.trim());
});

test("install detection ignores an enclosing repository and recognises plugin installs", async t => {
    const home = await mkdtemp(join(tmpdir(), "jw-home-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, "installed-plugins", "jira-workbench", "jira-workbench", "extensions", "jira-workbench");
    await mkdir(root, { recursive: true });
    const nested = fakeRun({ "rev-parse --show-toplevel": home });
    assert.equal((await detectInstall({ root, run: nested.run, copilotHome: home })).kind, "plugin", "~/.copilot's own repository is not this checkout");
    const pluginClone = fakeRun({ "rev-parse --show-toplevel": join(home, "installed-plugins", "jira-workbench", "jira-workbench") });
    assert.equal((await detectInstall({ root, run: pluginClone.run, copilotHome: home })).kind, "plugin", "a plugin that is a git clone is still updated by the plugin manager");
    const noGit = fakeRun({ "rev-parse --show-toplevel": new Error("not a repository") });
    assert.equal((await detectInstall({ root, run: noGit.run, copilotHome: join(home, "elsewhere") })).kind, "copy");
    const checkout = join(home, "checkout", "extensions", "jira-workbench");
    await mkdir(checkout, { recursive: true });
    const own = fakeRun({ "rev-parse --show-toplevel": join(home, "checkout") });
    assert.equal((await detectInstall({ root: checkout, run: own.run, copilotHome: home })).kind, "git");
});

test("identity labels the loaded commit, and falls back to the tree when git is unavailable", async t => {
    const dir = await mkdtemp(join(tmpdir(), "jw-id-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = join(dir, "extensions", "jira-workbench");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "extension.mjs"), "export {};\n");
    await mkdir(join(dir, ".github", "plugin"), { recursive: true });
    await writeFile(join(dir, ".github", "plugin", "plugin.json"), JSON.stringify({ version: "1.2.0", repository: "https://github.com/example/demo" }));
    const git = fakeRun({ "rev-parse HEAD": HEAD, "log -1 --format=%cs": "2026-09-27", "status --porcelain --untracked-files=no": " M ui/app.mjs" });
    const identity = await readIdentity({ kind: "git", root, repoRoot: dir }, git.run);
    assert.equal(identity.repo, "example/demo");
    assert.equal(buildLabel(identity), `${HEAD.slice(0, 7)}-dirty · 2026-09-27`);
    assert.ok(!git.calls.some(call => call.includes("describe")), "tags must not replace the commit hash");
    const broken = fakeRun({});
    const copy = await readIdentity({ kind: "git", root, repoRoot: dir }, broken.run);
    assert.equal(copy.kind, "copy");
    assert.match(buildLabel(copy), /^v1\.2\.0 · tree [0-9a-f]{7}$/);
    assert.equal(buildLabel(copy, { commit: OTHER, date: "2026-09-30", tree: copy.tree }), `${OTHER.slice(0, 7)} · 2026-09-30`, "a tree matching GitHub is labelled with its commit");
    assert.equal(buildLabel({ commit: null, tree: null }), "unknown build");
});

test("git checkout: offers a fast-forward update, then merges and reloads", async () => {
    const { run, calls } = fakeRun(gitScript());
    const session = fakeSession();
    const updater = new Updater({ install, identity: gitIdentity, session, run, reloadDelayMs: 0 });
    const status = await updater.check();
    assert.equal(status.state, "available");
    assert.equal(status.action, "update");
    assert.match(status.message, /bbbbbbb \(2026-09-30, 3 commits ahead\)/);
    assert.equal((await updater.apply()).state, "reloading");
    assert.ok(calls.includes("merge --ff-only @{u}"));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(session.calls, [["extensions.reload"]]);
    await assert.rejects(updater.apply(), /already in progress/);
});

test("git checkout: stays quiet when current or diverged, and never pulls over local changes", async () => {
    const current = new Updater({ install, identity: gitIdentity, run: fakeRun(gitScript({ "rev-parse @{u}": HEAD })).run });
    assert.deepEqual([(await current.check()).state, current.status().message], ["current", null]);
    const diverged = new Updater({ install, identity: gitIdentity, run: fakeRun(gitScript({ "merge-base --is-ancestor HEAD @{u}": new Error("exit 1") })).run });
    assert.equal((await diverged.check()).message, null);
    const detached = new Updater({ install, identity: gitIdentity, run: fakeRun(gitScript({ "symbolic-ref --short -q HEAD": new Error("detached") })).run });
    assert.equal((await detached.check()).state, "current");
    const dirty = fakeRun(gitScript({ "status --porcelain --untracked-files=no": " M lib/server.mjs" }));
    const blocked = new Updater({ install, identity: gitIdentity, run: dirty.run });
    const status = await blocked.check();
    assert.equal(status.state, "blocked");
    assert.equal(status.action, null);
    assert.match(status.message, /local changes/);
    await assert.rejects(blocked.apply(), /local changes/);
    assert.ok(!dirty.calls.includes("merge --ff-only @{u}"));
});

test("git checkout: a HEAD moved on disk (manual pull or another session's update) only needs a reload", async () => {
    const { run, calls } = fakeRun(gitScript({ "rev-parse HEAD": OTHER }));
    const session = fakeSession();
    const updater = new Updater({ install, identity: gitIdentity, session, run, reloadDelayMs: 0 });
    const status = await updater.check();
    assert.deepEqual([status.state, status.action], ["installed", "reload"]);
    assert.match(status.message, /ccccccc/);
    await updater.apply();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(!calls.some(call => call.startsWith("fetch") || call.startsWith("merge")));
    assert.deepEqual(session.calls, [["extensions.reload"]]);
});

test("plugin install: compares the folder tree with GitHub and updates through the plugin manager", async () => {
    const remote = JSON.stringify({ data: { repository: { defaultBranchRef: { target: { oid: OTHER, committedDate: "2026-09-30T01:16:20Z", file: { oid: REMOTE_TREE } } } } } });
    const { run } = fakeRun({ "gh api graphql": remote });
    const identity = { kind: "plugin", head: null, commit: null, date: null, dirty: false, tree: TREE, version: "1.0.0", repo: "example/demo" };
    const session = fakeSession();
    const updater = new Updater({ install: { ...install, kind: "plugin" }, identity, session, run, hash: async () => TREE, reloadDelayMs: 0 });
    const status = await updater.check();
    assert.deepEqual([status.state, status.action, status.label], ["available", "update", "v1.0.0 · tree 1111111"]);
    await updater.apply();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(session.calls, [
        ["plugins.list", {}],
        ["plugins.update", { name: "jira-workbench@jira-workbench" }],
        ["plugins.reload", { reloadMcp: false }],
    ]);
    const matching = JSON.stringify({ data: { repository: { defaultBranchRef: { target: { oid: OTHER, committedDate: "2026-09-30T01:16:20Z", file: { oid: TREE } } } } } });
    const upToDate = new Updater({ install: { ...install, kind: "plugin" }, identity, run: fakeRun({ "gh api graphql": matching }).run, hash: async () => TREE });
    assert.deepEqual([(await upToDate.check()).state, upToDate.status().label], ["current", "ccccccc · 2026-09-30"]);
});

// The marketplace on the default branch pins the release that `copilot plugin update` installs; unreleased
// commits on main must not be offered, because the plugin manager would not install them.
const MAIN_TREE = "3".repeat(40);
const marketplaceWith = source => JSON.stringify({ plugins: [{ name: "other", source: "./other" }, { name: "jira-workbench", version: "1.2.0", source }] });
const headWith = text => JSON.stringify({ data: { repository: { defaultBranchRef: { target: {
    oid: UPSTREAM, committedDate: "2026-10-04T00:00:00Z", file: { oid: MAIN_TREE }, marketplace: text === undefined ? null : { object: { text } },
} } } } });
const releaseWith = (tree, commit = { oid: OTHER, committedDate: "2026-10-03T01:00:00Z" }) =>
    JSON.stringify({ data: { repository: { commit, folder: tree && { oid: tree }, manifest: { text: JSON.stringify({ version: "1.2.0" }) } } } });
const ghScript = (head, release) => {
    const calls = [];
    const run = async (exe, args) => { calls.push(args); return { stdout: args.some(arg => arg.startsWith("commit=")) ? release : head }; };
    return { run, calls };
};
const pinnedIdentity = { kind: "plugin", head: null, commit: null, date: null, dirty: false, tree: TREE, version: "1.1.0", repo: "example/demo" };
const pinned = (head, release) => {
    const gh = ghScript(head, release);
    return { gh, updater: new Updater({ install: { ...install, kind: "plugin" }, identity: pinnedIdentity, run: gh.run, hash: async () => TREE }) };
};

test("plugin install: compares with the release the marketplace pins, not the default branch", async () => {
    const tagged = marketplaceWith({ source: "github", repo: "example/demo", ref: "v1.2.0" });
    const newer = pinned(headWith(tagged), releaseWith(REMOTE_TREE));
    const status = await newer.updater.check();
    assert.deepEqual([status.state, status.action], ["available", "update"]);
    assert.equal(status.message, "Update available: v1.2.0 (ccccccc, 2026-10-03).");
    assert.equal(newer.gh.calls.length, 2);
    assert.deepEqual(newer.gh.calls[1].slice(4), ["-f", "owner=example", "-f", "name=demo",
        "-f", "commit=v1.2.0", "-f", "folder=v1.2.0:extensions/jira-workbench", "-f", "manifest=v1.2.0:.github/plugin/plugin.json"]);

    const released = pinned(headWith(tagged), releaseWith(TREE));
    assert.deepEqual([(await released.updater.check()).state, released.updater.status().label], ["current", "v1.2.0 · ccccccc · 2026-10-03"],
        "the installed release is current even though main has moved on");

    const annotated = pinned(headWith(tagged), releaseWith(TREE, { target: { oid: OTHER, committedDate: "2026-10-03T01:00:00Z" } }));
    assert.equal((await annotated.updater.check()).state, "current", "an annotated tag resolves to its commit");

    const bySha = pinned(headWith(marketplaceWith({ source: "github", repo: "example/demo", sha: OTHER })), releaseWith(REMOTE_TREE));
    await bySha.updater.check();
    assert.ok(bySha.gh.calls[1].includes(`folder=${OTHER}:extensions/jira-workbench`));

    const unpinned = pinned(headWith(marketplaceWith("./")), releaseWith(TREE));
    const status2 = await unpinned.updater.check();
    assert.deepEqual([status2.state, unpinned.gh.calls.length], ["available", 1], "a path source still follows the default branch");
    assert.match(status2.message, /^Update available: bbbbbbb \(2026-10-04\)\.$/);
});

test("plugin install: a release merged but not yet tagged is never offered", async () => {
    const tagged = marketplaceWith({ source: "github", repo: "example/demo", ref: "v1.2.0" });
    const { updater } = pinned(headWith(tagged), JSON.stringify({ data: { repository: { commit: null, folder: null, manifest: null } } }));
    assert.deepEqual([(await updater.check()).state, updater.status().message], ["unknown", null]);
    await assert.rejects(updater.apply(), /^Error: Could not check for updates: Release v1\.2\.0 is not on GitHub yet\.$/);
});

test("release pins: only a GitHub source with a plain ref or full sha is followed", async () => {
    assert.equal(releasePin(null, "example/demo"), null);
    assert.equal(releasePin(marketplaceWith("./"), "example/demo"), null);
    assert.equal(releasePin(marketplaceWith({ source: "github", repo: "example/demo" }), "example/demo"), null);
    assert.deepEqual(releasePin(marketplaceWith({ source: "github", ref: "v1.2.0" }), "example/demo"), { repo: "example/demo", rev: "v1.2.0" });
    assert.deepEqual(releasePin(marketplaceWith({ source: "github", repo: "example/demo", ref: "v1", sha: OTHER }), "x/y"), { repo: "example/demo", rev: OTHER },
        "a sha wins over a ref");
    for (const [source, message] of [
        [{ source: "github", ref: "v1.2.0:secret" }, /invalid ref/],
        [{ source: "github", ref: "-v1" }, /invalid ref/],
        [{ source: "github", ref: "main^{tree}" }, /invalid ref/],
        [{ source: "github", ref: "a..b" }, /invalid ref/],
        [{ source: "github", sha: "abc123" }, /invalid commit/],
        [{ source: "github", repo: "not a repo", ref: "v1" }, /Invalid GitHub repository/],
        [{ source: "url", url: "https://example.com/x.git" }, /outside GitHub/],
    ]) assert.throws(() => releasePin(marketplaceWith(source), "example/demo"), message, JSON.stringify(source));
    const bad = pinned(headWith(marketplaceWith({ source: "github", ref: "v1:x" })), releaseWith(TREE));
    assert.equal((await bad.updater.check()).state, "unknown");
    assert.equal(bad.gh.calls.length, 1, "an invalid pin is never sent to GitHub");
});

test("copied install: reports an update without offering to apply it; failures stay silent", async () => {
    const remote = JSON.stringify({ data: { repository: { defaultBranchRef: { target: { oid: OTHER, committedDate: "2026-09-30", file: { oid: REMOTE_TREE } } } } } });
    const identity = { kind: "copy", head: null, commit: null, date: null, dirty: false, tree: TREE, version: null, repo: "example/demo" };
    const copy = new Updater({ install: { ...install, kind: "copy" }, identity, run: fakeRun({ "gh api graphql": remote }).run, hash: async () => TREE });
    const status = await copy.check();
    assert.equal(status.action, null);
    assert.match(status.message, /Reinstall the extension from example\/demo/);
    const offline = new Updater({ install: { ...install, kind: "copy" }, identity, run: fakeRun({ "gh api graphql": new Error("gh: not logged in") }).run, hash: async () => TREE });
    const quiet = await offline.check();
    assert.deepEqual([quiet.state, quiet.message], ["unknown", null]);
    const noConnection = new Updater({ install: { ...install, kind: "plugin" }, identity: { ...identity, kind: "plugin" }, session: { rpc: {} }, run: fakeRun({ "gh api graphql": remote }).run, hash: async () => TREE });
    await assert.rejects(noConnection.apply(), /copilot plugin update jira-workbench/);
    assert.match(noConnection.status().message, /^Update failed:/);
});

test("concurrent applies run one update, and a reload that leaves the process alive offers Reload again", async () => {
    const script = gitScript();
    const slow = async (exe, args) => { await new Promise(resolve => setTimeout(resolve, 5)); return fakeRun(script).run(exe, args); };
    const merges = [];
    const run = async (exe, args) => { if (args.includes("merge")) merges.push(args); return slow(exe, args); };
    const session = fakeSession();
    const updater = new Updater({ install, identity: gitIdentity, session, run, reloadDelayMs: 0, restartTimeoutMs: 20 });
    const [first, second] = await Promise.allSettled([updater.apply(), updater.apply()]);
    assert.equal(first.status, "fulfilled");
    assert.match(second.reason.message, /already in progress/);
    assert.equal(merges.length, 1);
    assert.equal((await updater.check()).state, "reloading", "checks do not disturb a pending restart");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(session.calls, [["extensions.reload"]]);
    const status = updater.status();
    assert.deepEqual([status.state, status.action], ["error", "reload"]);
    assert.match(status.message, /did not restart/);
    assert.equal(updater.applying, false);
});

test("a failed check never reports the build as up to date", async () => {
    const offline = new Updater({ install, identity: gitIdentity, run: fakeRun(gitScript({ "fetch --quiet --no-tags origin refs/heads/main": new Error("network down") })).run });
    await assert.rejects(offline.apply(), /^Error: Could not check for updates: network down$/);
    assert.equal(offline.applying, false);
    const current = new Updater({ install, identity: gitIdentity, run: fakeRun(gitScript({ "rev-parse @{u}": HEAD })).run });
    await assert.rejects(current.apply(), /up to date/);
});

test("local check: flags a build installed on disk without contacting upstream, and keeps pending updates", async () => {
    let head = HEAD;
    const { run, calls } = fakeRun(gitScript({ "rev-parse HEAD": () => head }));
    const updater = new Updater({ install, identity: gitIdentity, run });
    assert.equal((await updater.local()).state, "unknown");
    head = OTHER;
    const status = await updater.local();
    assert.deepEqual([status.state, status.action], ["installed", "reload"]);
    assert.ok(calls.every(call => call === "rev-parse HEAD"), "no fetch or gh call on the per-minute path");
    const plugin = new Updater({ install: { ...install, kind: "plugin" }, identity: { ...gitIdentity, kind: "plugin", head: null, tree: TREE }, run, hash: async () => REMOTE_TREE });
    assert.match((await plugin.local()).message, /tree 2222222/);
    const unchanged = new Updater({ install: { ...install, kind: "plugin" }, identity: { ...gitIdentity, kind: "plugin", head: null, tree: TREE }, run, hash: async () => TREE });
    unchanged.state = { state: "available", action: "update", target: null, message: "Update available." };
    assert.equal((await unchanged.local()).action, "update", "an unchanged disk leaves the upstream result alone");
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Finding S4: every session with the extension installed used to run git fetch / gh api every 10 minutes.
test("the updater checks only while at least one panel holds it", async () => {
    const { run, calls } = fakeRun(gitScript({ "rev-parse @{u}": HEAD }));
    const updater = new Updater({ install, identity: gitIdentity, run, firstCheckMs: 5, checkEveryMs: 10 });
    await wait(40);
    assert.deepEqual(calls, [], "no panel open: no git or gh");
    updater.acquire();
    updater.acquire();
    for (let i = 0; i < 40 && !calls.length; i++) await wait(5);
    assert.ok(calls.includes("fetch --quiet --no-tags origin refs/heads/main"), "the first panel starts the checks");
    updater.release();
    const held = calls.length;
    await wait(40);
    assert.ok(calls.length > held, "one panel still open: checks continue");
    updater.release();
    await wait(10); // a check already running may finish
    const closed = calls.length;
    await wait(50);
    assert.equal(calls.length, closed, "the last panel closed: no more checks");
    updater.release();
    assert.equal(updater.holders, 0, "an extra release is harmless");
    updater.acquire();
    for (let i = 0; i < 40 && calls.length === closed; i++) await wait(5);
    assert.ok(calls.length > closed, "a panel opened again restarts the checks");
    updater.release();
});

// Finding L9: gh api -F coerces values, so a repository named 2048 would be sent as a number.
test("the update check sends owner and name to GitHub as strings", async () => {
    const seen = [];
    const remote = JSON.stringify({ data: { repository: { defaultBranchRef: { target: { oid: OTHER, committedDate: "2026-09-30", file: { oid: TREE } } } } } });
    const run = async (exe, args) => { seen.push([exe, ...args]); return { stdout: remote }; };
    const identity = { kind: "copy", head: null, commit: null, date: null, dirty: false, tree: TREE, version: null, repo: "2048/2048" };
    const updater = new Updater({ install: { ...install, kind: "copy" }, identity, run, hash: async () => TREE });
    assert.equal((await updater.check()).state, "current");
    const gh = seen.find(([exe]) => exe === "gh");
    assert.deepEqual(gh.slice(0, 3), ["gh", "api", "graphql"]);
    assert.deepEqual(gh.slice(5), ["-f", "owner=2048", "-f", "name=2048"]);
    assert.ok(!gh.includes("-F"), "no typed (-F) fields");
});

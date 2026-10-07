import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { REPO } from "./validate.mjs";

export const execFileAsync = promisify(execFile);
const extensionRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_REPOSITORY = "Sentry01/jira-workbench";
// Mirrors the extension's .gitignore, so an untouched install hashes to the tree committed on GitHub.
const IGNORED = new Set([".git", "artifacts", "node_modules", ".DS_Store"]);

export const gitIn = (root, run) => (args, timeout = 3000) =>
    run("git", ["-C", root, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
        .then(({ stdout }) => String(stdout).trim());

const objectId = (type, body) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest();

async function tree(dir) {
    const entries = [];
    for (const name of await readdir(dir)) {
        if (IGNORED.has(name)) continue;
        const path = join(dir, name), info = await lstat(path);
        let mode, id;
        if (info.isDirectory()) { id = await tree(path); mode = "40000"; if (!id) continue; }
        else if (info.isSymbolicLink()) { id = objectId("blob", Buffer.from(await readlink(path))); mode = "120000"; }
        else if (info.isFile()) { id = objectId("blob", await readFile(path)); mode = info.mode & 0o111 ? "100755" : "100644"; }
        else continue;
        entries.push({ name, mode, id, key: Buffer.from(info.isDirectory() ? `${name}/` : name) });
    }
    if (!entries.length) return null;
    entries.sort((a, b) => Buffer.compare(a.key, b.key));
    return objectId("tree", Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.name}\0`), entry.id])));
}

// Git's tree object ID for a folder: lets an install without .git (plugin or copy) be matched to GitHub.
export async function treeHash(dir) {
    return (await tree(dir))?.toString("hex") ?? null;
}

// git: a checkout of this repository (the path ~/.copilot/extensions links to);
// plugin: a copy managed by `copilot plugin`; copy: anything else, such as an install_extension folder.
export async function detectInstall({ root = extensionRoot, run = execFileAsync, copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot") } = {}) {
    const real = await realpath(root).catch(() => resolve(root));
    const repoRoot = resolve(real, "..", "..");
    // First: a marketplace plugin can itself be a git clone, but only the plugin manager may update it.
    const plugins = await realpath(join(copilotHome, "installed-plugins")).catch(() => null);
    if (plugins && real.startsWith(plugins + sep)) return { kind: "plugin", root: real, repoRoot };
    try {
        // A copy nested in another repository (such as a versioned ~/.copilot) must not report that repository's commit.
        const top = await gitIn(real, run)(["rev-parse", "--show-toplevel"]);
        if (await realpath(top).catch(() => top) === repoRoot) return { kind: "git", root: real, repoRoot };
    } catch { /* not a git checkout */ }
    return { kind: "copy", root: real, repoRoot };
}

async function readManifest(repoRoot) {
    try {
        const manifest = JSON.parse(await readFile(join(repoRoot, ".github", "plugin", "plugin.json"), "utf8"));
        const repo = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(manifest.repository || "")?.[1];
        return { version: typeof manifest.version === "string" ? manifest.version : null, repo: REPO.test(repo || "") ? repo : null };
    } catch {
        return { version: null, repo: null };
    }
}

export async function readIdentity(install, run = execFileAsync) {
    const manifest = await readManifest(install.repoRoot);
    const base = { version: manifest.version, repo: manifest.repo || DEFAULT_REPOSITORY };
    if (install.kind === "git") {
        try {
            const git = gitIn(install.root, run);
            // rev-parse, not describe: describe returns tag names once the repository has tags.
            const [head, date, changes] = await Promise.all([
                git(["rev-parse", "HEAD"]),
                git(["log", "-1", "--format=%cs"]),
                git(["status", "--porcelain", "--untracked-files=no"]),
            ]);
            if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Unexpected HEAD.");
            return { ...base, kind: "git", head, commit: head.slice(0, 7), date, dirty: changes !== "", tree: null };
        } catch { /* fall back to hashing the files */ }
    }
    const tree = await treeHash(install.root).catch(() => null);
    return { ...base, kind: install.kind === "plugin" ? "plugin" : "copy", head: null, commit: null, date: null, dirty: false, tree };
}

export function buildLabel(identity, remote = null) {
    if (identity.commit) return `${identity.commit}${identity.dirty ? "-dirty" : ""}${identity.date ? ` · ${identity.date}` : ""}`;
    if (identity.tree && remote?.tree === identity.tree) return `${remote.version ? `v${remote.version} · ` : ""}${remote.commit.slice(0, 7)} · ${remote.date}`;
    if (identity.tree) return `${identity.version ? `v${identity.version} · ` : ""}tree ${identity.tree.slice(0, 7)}`;
    return "unknown build";
}

// Read at load time: files changing on disk later must not change what this process reports it is running.
const loaded = (async () => {
    const install = await detectInstall();
    return { install, identity: await readIdentity(install) };
})();
export const version = () => loaded;

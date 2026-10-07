import { REPO } from "./validate.mjs";
import { buildLabel, execFileAsync, gitIn, treeHash } from "./version.mjs";

const PLUGIN = "jira-workbench";
const EXTENSION_PATH = "extensions/jira-workbench";
const MARKETPLACE_PATH = ".github/plugin/marketplace.json";
const PLUGIN_MANIFEST_PATH = ".github/plugin/plugin.json";
const SHA = /^[0-9a-f]{40}$/;
// A tag or branch name; never an expression (no ":", "^", "~", "@{", "..") and never an option.
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const REMOTE_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { target { ... on Commit { oid committedDate file(path: "${EXTENSION_PATH}") { oid }
    marketplace: file(path: "${MARKETPLACE_PATH}") { object { ... on Blob { text } } } } } } } }`;
const RELEASE_QUERY = `query($owner: String!, $name: String!, $commit: String!, $folder: String!, $manifest: String!) {
  repository(owner: $owner, name: $name) {
    commit: object(expression: $commit) { ... on Commit { oid committedDate } ... on Tag { target { ... on Commit { oid committedDate } } } }
    folder: object(expression: $folder) { oid }
    manifest: object(expression: $manifest) { ... on Blob { text } } } }`;

// What `copilot plugin update` installs, as the marketplace on the default branch declares it: a release pinned
// by sha or ref, or null when the plugin is served from the default branch itself (a path source).
export function releasePin(marketplaceText, repo) {
    if (!marketplaceText) return null;
    const source = JSON.parse(marketplaceText)?.plugins?.find(plugin => plugin?.name === PLUGIN)?.source;
    if (!source || typeof source !== "object") return null;
    if (source.source !== "github") throw new Error("The marketplace installs this plugin from outside GitHub.");
    const pinRepo = source.repo ?? repo;
    if (!REPO.test(pinRepo || "")) throw new Error("Invalid GitHub repository.");
    if (source.sha !== undefined) {
        if (!SHA.test(source.sha)) throw new Error("The marketplace pins an invalid commit.");
        return { repo: pinRepo, rev: source.sha };
    }
    if (source.ref === undefined) return null;
    if (!REF.test(source.ref)) throw new Error("The marketplace pins an invalid ref.");
    return { repo: pinRepo, rev: source.ref };
}

function manifestVersion(text) {
    try { const version = JSON.parse(text)?.version; return VERSION.test(version || "") ? version : null; }
    catch { return null; }
}

// Watches for a newer build of this extension and applies it on request, then reloads the session's
// extensions; the host re-opens every open panel against the new process.
export class Updater {
    constructor({ install, identity, session = null, run = execFileAsync, hash = treeHash, checkEveryMs = 10 * 60_000, firstCheckMs = 15_000, reloadDelayMs = 300, restartTimeoutMs = 20_000 }) {
        Object.assign(this, { install, identity, session, run, hash, checkEveryMs, firstCheckMs, reloadDelayMs, restartTimeoutMs });
        this.git = gitIn(install.root, run);
        this.remote = null;
        this.state = { state: "unknown", action: null, message: null, target: null };
        this.checking = null;
        this.looking = null;
        this.applying = false;
        this.timers = [];
        this.holders = 0;
    }

    // Held by each open panel: checks run only while at least one is open, so a session with the extension
    // installed but no Workbench open never runs git or gh.
    acquire() {
        if (this.holders++ === 0) this.start();
        return this;
    }

    release() {
        if (this.holders > 0 && --this.holders === 0) this.stop();
    }

    start() {
        this.stop();
        this.timers.push(setTimeout(() => void this.check(), this.firstCheckMs), setInterval(() => void this.check(), this.checkEveryMs));
        for (const timer of this.timers) timer.unref?.();
        return this;
    }

    stop() {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers = [];
    }

    status() {
        return { label: buildLabel(this.identity, this.remote), kind: this.identity.kind, ...this.state };
    }

    check() {
        return this.applying ? Promise.resolve(this.status()) : this.refresh();
    }

    // Cheap and local, so every panel poll catches a build installed by a manual pull, `copilot plugin update`,
    // or another session's update within a minute, without waiting for the next upstream check.
    local() {
        if (this.applying || this.checking || this.state.state === "installed") return Promise.resolve(this.status());
        this.looking ??= this.moved()
            .then(state => { if (state && !this.applying) this.state = { ...state, checkedAt: new Date().toISOString() }; }, () => {})
            .finally(() => { this.looking = null; });
        return this.looking.then(() => this.status());
    }

    // The build on disk differs from the one this process loaded: only a reload is needed.
    async moved() {
        if (this.identity.kind === "git") {
            const head = await this.git(["rev-parse", "HEAD"]);
            return head !== this.identity.head ? installed(head.slice(0, 7)) : null;
        }
        const disk = await this.hash(this.install.root);
        return disk && this.identity.tree && disk !== this.identity.tree ? installed(`tree ${disk.slice(0, 7)}`) : null;
    }

    refresh() {
        this.checking ??= (this.identity.kind === "git" ? this.checkGit() : this.checkPackaged())
            .then(state => { this.state = { ...state, checkedAt: new Date().toISOString() }; },
                error => { this.state = { state: "unknown", action: null, message: null, target: null, error: error.message }; })
            .finally(() => { this.checking = null; });
        return this.checking.then(() => this.status());
    }

    async checkGit() {
        const git = this.git, head = this.identity.head;
        const moved = await this.moved();
        if (moved) return moved;
        const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
        const remote = branch && await git(["config", "--get", `branch.${branch}.remote`]).catch(() => "");
        const merge = branch && await git(["config", "--get", `branch.${branch}.merge`]).catch(() => "");
        if (!remote || !merge) return quiet("current");
        await git(["fetch", "--quiet", "--no-tags", remote, merge], 30_000);
        const upstream = await git(["rev-parse", "@{u}"]);
        if (upstream === head) return quiet("current");
        const behind = await git(["merge-base", "--is-ancestor", "HEAD", "@{u}"]).then(() => true, () => false);
        if (!behind) return quiet("diverged");
        const [count, date, changes] = await Promise.all([
            git(["rev-list", "--count", "HEAD..@{u}"]),
            git(["log", "-1", "--format=%cs", "@{u}"]),
            git(["status", "--porcelain", "--untracked-files=no"]),
        ]);
        const target = { commit: upstream.slice(0, 7), date, behind: Number(count) };
        const summary = `Update available: ${target.commit} (${date}, ${plural(target.behind, "commit")} ahead).`;
        if (changes) return { state: "blocked", action: null, target, message: `${summary} This checkout has local changes; commit or stash them, then pull.` };
        return { state: "available", action: "update", target, message: summary };
    }

    async checkPackaged() {
        const moved = await this.moved();
        if (moved) return moved;
        this.remote = await this.readRemote();
        if (!this.identity.tree || this.remote.tree === this.identity.tree) return quiet("current");
        const target = { commit: this.remote.commit.slice(0, 7), date: this.remote.date, version: this.remote.version || null };
        const summary = target.version
            ? `Update available: v${target.version} (${target.commit}, ${target.date}).`
            : `Update available: ${target.commit} (${target.date}).`;
        if (this.identity.kind === "plugin") return { state: "available", action: "update", target, message: summary };
        return { state: "available", action: null, target, message: `${summary} Reinstall the extension from ${this.identity.repo} to get it.` };
    }

    // The build an update would install: the release the marketplace pins, or the default branch when unpinned.
    async readRemote() {
        const head = (await this.graphql(REMOTE_QUERY, this.identity.repo))?.repository?.defaultBranchRef?.target;
        if (!SHA.test(head?.oid || "") || !head.file?.oid) throw new Error("GitHub did not return the extension folder.");
        const pin = releasePin(head.marketplace?.object?.text, this.identity.repo);
        if (!pin) return { commit: head.oid, date: day(head.committedDate), tree: head.file.oid };
        const release = (await this.graphql(RELEASE_QUERY, pin.repo, {
            commit: pin.rev, folder: `${pin.rev}:${EXTENSION_PATH}`, manifest: `${pin.rev}:${PLUGIN_MANIFEST_PATH}`,
        }))?.repository;
        const commit = release?.commit?.target ?? release?.commit;
        // Right after a release is merged, its tag is created by a workflow; until then there is nothing to install.
        if (!SHA.test(commit?.oid || "") || !release.folder?.oid) throw new Error(`Release ${pin.rev} is not on GitHub yet.`);
        return { commit: commit.oid, date: day(commit.committedDate), tree: release.folder.oid, version: manifestVersion(release.manifest?.text) };
    }

    async graphql(query, repo, fields = {}) {
        if (!REPO.test(repo || "")) throw new Error("Invalid GitHub repository.");
        const [owner, name] = repo.split("/");
        // -f sends strings; -F would turn a repository named 2048 into a number and fail the String! variable.
        const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
            ...Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`])];
        const { stdout } = await this.run("gh", args, { timeout: 20_000 });
        return JSON.parse(stdout)?.data;
    }

    async apply() {
        if (this.applying) throw new Error("An update is already in progress.");
        // Claimed before the first await, so a second click or panel cannot start a second update.
        this.applying = true;
        let current = null;
        try {
            current = await this.refresh();
            // A failed check compared nothing, so it must not read as "up to date".
            if (current.error) throw new Error(`Could not check for updates: ${current.error}`);
            if (current.action !== "update" && current.action !== "reload") throw new Error(current.message || "This build is up to date.");
            if (current.action === "update") {
                this.state = { ...this.state, state: "updating", action: null, message: "Updating… the Workbench restarts in a few seconds." };
                if (this.identity.kind === "git") await this.git(["merge", "--ff-only", "@{u}"], 30_000);
                else await this.updatePlugin();
            }
        } catch (error) {
            this.applying = false;
            if (current?.action) this.state = { state: "error", action: null, target: current.target, message: `Update failed: ${error.message}` };
            throw error;
        }
        this.state = { ...this.state, state: "reloading", action: null, message: "Restarting the Workbench…" };
        const failed = message => {
            this.applying = false;
            this.state = { state: "error", action: "reload", target: null, message };
        };
        setTimeout(() => void this.reload().then(
            // A successful reload ends this process; still being here means the host did not restart it.
            () => setTimeout(() => failed("The Workbench did not restart. Reload extensions to finish."), this.restartTimeoutMs).unref?.(),
            error => failed(`Reload failed: ${error.message}. Reload extensions to finish.`),
        ), this.reloadDelayMs).unref?.();
        return this.status();
    }

    // Server-level plugin RPC is reachable only through the session's connection; without it, point at the CLI.
    async updatePlugin() {
        const connection = this.session?.connection;
        if (typeof connection?.sendRequest !== "function") throw new Error(`run \`copilot plugin update ${PLUGIN}\``);
        const { plugins = [] } = await connection.sendRequest("plugins.list", {});
        const entry = plugins.find(plugin => plugin.name === PLUGIN);
        if (!entry) throw new Error(`the ${PLUGIN} plugin is not installed`);
        await connection.sendRequest("plugins.update", { name: entry.marketplace ? `${entry.name}@${entry.marketplace}` : entry.name });
    }

    async reload() {
        const rpc = this.session?.rpc;
        if (this.identity.kind === "plugin" && typeof rpc?.plugins?.reload === "function") await rpc.plugins.reload({ reloadMcp: false });
        else if (typeof rpc?.extensions?.reload === "function") await rpc.extensions.reload();
        else throw new Error("this host cannot reload extensions");
    }
}

const day = date => String(date || "").slice(0, 10);
const quiet = state => ({ state, action: null, target: null, message: null });
const installed = build => ({ state: "installed", action: "reload", target: null, message: `A different build (${build}) is on disk. Reload to run it.` });
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

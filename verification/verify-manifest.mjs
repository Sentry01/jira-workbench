// Proves, with the Copilot app's own runtime, that plugin.json lets the runtime discover the Workbench extension
// and resume a session after a cold restart (#44). As a control, the same plugin without "$schema", the v2.5.0
// manifest shape, must fail, so a pass shows the harness can see the regression.
// Local only: it needs the app's cached SDK and runtime, and it never sends a prompt or contacts Jira.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ID = "plugin:jira-workbench:jira-workbench";

// The app keeps its SDK and runtime in versioned folders; the most recently updated one is the one it uses.
function findSdk() {
    if (process.env.COPILOT_SDK_DIR) return resolve(process.env.COPILOT_SDK_DIR);
    const cache = join(homedir(), "Library", "Caches", "github-copilot-sdk", "cli");
    const folders = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith("copilot-sdk-runtime-")) : [];
    const newest = folders.map(name => join(cache, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!newest) throw new Error(`No Copilot SDK found under ${cache}. Open the Copilot app once, or set COPILOT_SDK_DIR to its copilot-sdk folder.`);
    return join(newest, "copilot-sdk");
}

const sdk = findSdk();
const runtimePath = process.env.COPILOT_RUNTIME || join(sdk, "..", "copilot-runtime");
for (const path of [join(sdk, "index.js"), runtimePath]) if (!existsSync(path)) throw new Error(`Missing ${path}.`);
const { CopilotClient, RuntimeConnection, approveAll } = await import(pathToFileURL(join(sdk, "index.js")));

// Copies the plugin as a marketplace install would see it: tracked and new files, without ignored local state.
async function stagePlugin(target, editManifest) {
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8" })
        .split("\0").filter(file => file && existsSync(join(repository, file)));
    for (const file of files) {
        await mkdir(dirname(join(target, file)), { recursive: true });
        await cp(join(repository, file), join(target, file));
    }
    const manifest = JSON.parse(await readFile(join(target, "plugin.json"), "utf8"));
    await writeFile(join(target, "plugin.json"), JSON.stringify(editManifest(manifest), null, 2));
}

// Creates a named session (so it persists without a turn), stops the runtime, then resumes it in a new one.
async function createStopResume(label, editManifest) {
    const work = await mkdtemp(join(tmpdir(), "jira-workbench-manifest-"));
    const plugin = join(work, "jira-workbench");
    const launched = [];
    const clients = [];
    try {
        await stagePlugin(plugin, editManifest);
        // Like the app: the standalone runtime, a host launch provider and the plugin directory on each session.
        const client = () => {
            const instance = new CopilotClient({
                baseDirectory: join(work, "home"), workingDirectory: work, logLevel: "error",
                connection: RuntimeConnection.forStdio({ path: runtimePath }),
                extensionLaunchProvider: { resolve: async ({ id, modulePath }) => {
                    launched.push(id);
                    return { launch: { executable: process.execPath, args: [modulePath], env: {} } };
                } },
            });
            clients.push(instance);
            return instance;
        };
        const config = { onPermissionRequest: approveAll, workingDirectory: work, pluginDirectories: [plugin], requestExtensions: true, extensionSdkPath: sdk };
        const discovered = async session => {
            for (let attempt = 0; attempt < 20; attempt++) {
                const ids = (await session.rpc.extensions.list()).extensions.map(extension => extension.id);
                if (ids.length) return ids;
                await new Promise(done => setTimeout(done, 250));
            }
            return [];
        };
        const first = client();
        await first.start();
        const created = await first.createSession({ ...config, name: `Manifest check ${label}` });
        const atCreate = await discovered(created);
        await first.stop();
        const second = client();
        await second.start();
        let atResume = null, resumeError = null;
        try { atResume = await discovered(await second.resumeSession(created.sessionId, config)); }
        catch (error) { resumeError = error.message; }
        await second.stop();
        return { atCreate, atResume, resumeError, launched };
    } finally {
        await Promise.all(clients.map(instance => instance.forceStop().catch(() => {})));
        await rm(work, { recursive: true, force: true });
    }
}

const current = await createStopResume("current", manifest => manifest);
assert.ok(current.atCreate.includes(EXTENSION_ID), `a new session discovers ${EXTENSION_ID}; found ${JSON.stringify(current.atCreate)}`);
assert.equal(current.resumeError, null, `the session resumes after a cold restart: ${current.resumeError}`);
assert.ok(current.atResume.includes(EXTENSION_ID), `the resumed session discovers ${EXTENSION_ID}; found ${JSON.stringify(current.atResume)}`);
assert.ok(current.launched.filter(id => id === EXTENSION_ID).length >= 2, `the extension launches on create and on resume; launched ${JSON.stringify(current.launched)}`);

const control = await createStopResume("control", ({ $schema, ...manifest }) => manifest);
assert.ok(!control.atCreate.includes(EXTENSION_ID), "control: without $schema the runtime does not discover the extension");
assert.match(control.resumeError || "", /Invalid extensions object form: expected \{ paths: string\[\] \}/,
    "control: without $schema the cold resume fails as reported in #44");

console.log(`PASS: with ${runtimePath}, the current plugin.json was discovered as ${EXTENSION_ID}, launched, and resumed after a cold restart; the same manifest without "$schema" was not discovered and failed to resume with "${control.resumeError}". No prompt was sent and Jira was not contacted.`);

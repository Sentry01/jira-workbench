import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./check-version-bump.mjs", import.meta.url));
const PLUGIN = "plugin.json";
const LEGACY_PLUGIN = ".github/plugin/plugin.json";
const plugin = version => JSON.stringify({ name: "demo", version });

// Builds a scratch repository with a base commit and a change on top, then runs the checker against HEAD^1.
// `files` maps a path to its new content, or to null to delete it. `baseManifest` is where the base keeps plugin.json.
async function check({ from = "1.2.0", to = from, files = {}, env = {}, baseManifest = PLUGIN }) {
    const root = await mkdtemp(join(tmpdir(), "jw-bump-"));
    const git = (...args) => exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root });
    const write = async (file, content) => {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), content);
    };
    try {
        await git("init", "-q");
        await write(baseManifest, plugin(from));
        await write("com.github.copilot/extensions/jira-workbench/lib/model.mjs", "export const a = 1;\n");
        await write("com.github.copilot/extensions/jira-workbench/README.md", "# Demo\n");
        await git("add", "-A");
        await git("commit", "-q", "-m", "base");
        if (baseManifest !== PLUGIN) await git("mv", baseManifest, PLUGIN);
        if (to !== from) await write(PLUGIN, plugin(to));
        for (const [file, content] of Object.entries(files)) {
            if (content === null) await git("rm", "-q", file);
            else await write(file, content);
        }
        await git("add", "-A");
        await git("commit", "-q", "--allow-empty", "-m", "change");
        return await exec(process.execPath, [SCRIPT, "", root], { env: { ...process.env, NO_RELEASE: "", ...env } })
            .then(({ stdout }) => ({ code: 0, stdout }), error => ({ code: error.code, stdout: error.stdout }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const code = { "com.github.copilot/extensions/jira-workbench/lib/model.mjs": "export const a = 2;\n" };

test("a change that ships nothing passes without a new version", async () => {
    const files = {
        "com.github.copilot/extensions/jira-workbench/README.md": "# Demo, revised\n",
        "com.github.copilot/extensions/jira-workbench/test/model.test.mjs": "// test\n",
        "docs/guide.md": "Guide\n",
        ".github/workflows/tests.yml": "name: tests\n",
    };
    const result = await check({ files });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No change to the shipped canvas/);
});

test("a shipped change that keeps or lowers the version fails and names the files", async () => {
    const cases = [
        ["1.2.0", "1.2.0", "kept"], ["1.2.0", "1.1.9", "lowered"], ["1.2.0", "1.2.0-rc.1", "prerelease of the same version"],
        ["1.3.0-20261008083306013", "1.3.0-20261008083306012.1", "lowered by a long numeric identifier"],
    ];
    for (const [from, to, label] of cases) {
        const result = await check({ from, to, files: code });
        assert.equal(result.code, 1, label);
        assert.match(result.stdout, /^::error file=plugin\.json::/, label);
        assert.match(result.stdout, /extensions\/jira-workbench\/lib\/model\.mjs/, label);
        assert.match(result.stdout, /Releasing in CONTRIBUTING\.md/, label);
    }
});

test("added, deleted and moved shipped files count as shipped changes", async () => {
    const cases = [
        { "com.github.copilot/extensions/jira-workbench/ui/new.css": "body {}\n" },
        { "com.github.copilot/extensions/jira-workbench/lib/model.mjs": null },
        // Identical content, so git sees a rename out of the extension.
        { "com.github.copilot/extensions/jira-workbench/lib/model.mjs": null, "scripts/model.mjs": "export const a = 1;\n" },
        // Git quotes non-ASCII paths unless the output is NUL-separated.
        { "com.github.copilot/extensions/jira-workbench/ui/caf\u00e9.css": "body {}\n" },
    ];
    for (const files of cases) assert.equal((await check({ files })).code, 1, Object.keys(files)[0]);
});

test("a shipped change that raises the version passes", async () => {
    const cases = [
        ["1.2.0", "1.2.1"], ["1.2.0", "1.3.0"], ["1.2.0", "2.0.0"], ["1.9.0", "1.10.0"],
        ["1.2.0", "1.3.0-beta.1"], ["1.3.0-beta.1", "1.3.0"], ["1.3.0-beta.2", "1.3.0-beta.10"],
        ["1.3.0-beta", "1.3.0-beta.1"], ["1.3.0-1", "1.3.0-alpha"],
        ["1.3.0-20261008083306012", "1.3.0-20261008083306013"],
    ];
    for (const [from, to] of cases) {
        const result = await check({ from, to, files: code });
        assert.equal(result.code, 0, `${from} -> ${to}: ${result.stdout}`);
        assert.match(result.stdout, new RegExp(`from ${from.replaceAll(".", "\\.")} to ${to.replaceAll(".", "\\.")}`));
    }
});

test("a base that keeps the manifest at .github/plugin/plugin.json is still compared", async () => {
    const raised = await check({ from: "1.2.0", to: "1.2.1", files: code, baseManifest: LEGACY_PLUGIN });
    assert.equal(raised.code, 0, raised.stdout);
    assert.match(raised.stdout, /from 1\.2\.0 to 1\.2\.1/);
    const kept = await check({ files: code, baseManifest: LEGACY_PLUGIN });
    assert.equal(kept.code, 1, "moving the manifest without raising the version still fails");
    assert.match(kept.stdout, /not higher than "1\.2\.0"/);
});

test("the no-release label skips the check", async () => {
    const result = await check({ files: code, env: { NO_RELEASE: "true" } });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^::notice::.*no-release label/);
    assert.equal((await check({ files: code, env: { NO_RELEASE: "false" } })).code, 1, "a false label value still checks");
});

test("a version that is not MAJOR.MINOR.PATCH fails", async () => {
    for (const to of ["1.3", "v1.3.0", ""]) {
        const result = await check({ to, files: code });
        assert.equal(result.code, 1, JSON.stringify(to));
        assert.match(result.stdout, /must be MAJOR\.MINOR\.PATCH/, JSON.stringify(to));
    }
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./check-release.mjs", import.meta.url));
const REPOSITORY = "https://github.com/example/demo";
const plugin = (version = "1.2.0") => ({ name: "demo", version, repository: REPOSITORY });
const marketplace = (version = "1.2.0", source = { source: "github", repo: "example/demo", ref: `v${version}` }) =>
    ({ name: "demo", plugins: [{ name: "other", source: "./other" }, { name: "demo", version, source }] });
const raw = value => ({ raw: value });

// Runs the checker on a scratch repository holding the two manifests; returns its exit code, output and GITHUB_OUTPUT.
async function check(pluginJson, marketplaceJson) {
    const root = await mkdtemp(join(tmpdir(), "jw-release-"));
    try {
        await mkdir(join(root, ".github", "plugin"), { recursive: true });
        const write = (name, value) => writeFile(join(root, ".github", "plugin", name), value?.raw ?? JSON.stringify(value));
        await Promise.all([write("plugin.json", pluginJson), write("marketplace.json", marketplaceJson)]);
        const output = join(root, "github-output");
        await writeFile(output, "");
        const result = await exec(process.execPath, [SCRIPT, root], { env: { ...process.env, GITHUB_OUTPUT: output } })
            .then(({ stdout }) => ({ code: 0, stdout }), error => ({ code: error.code, stdout: error.stdout }));
        return { ...result, outputs: await readFile(output, "utf8") };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("matching manifests pass and publish the tag", async () => {
    const result = await check(plugin(), marketplace());
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^Release v1\.2\.0: /);
    assert.equal(result.outputs, "tag=v1.2.0\nversion=1.2.0\n");
    const reordered = marketplace();
    reordered.plugins[1].source = { ref: "v1.2.0", repo: "example/demo", source: "github" };
    assert.equal((await check(plugin(), reordered)).code, 0, "the order of the source keys does not matter");
});

test("a manifest that is not a JSON object fails and never yields a tag", async () => {
    for (const value of ["null", "\"1.2.0\"", "[]", "42", "true"]) {
        for (const [name, args] of [["marketplace.json", [plugin(), raw(value)]], ["plugin.json", [raw(value), marketplace()]]]) {
            const result = await check(...args);
            assert.equal(result.code, 1, `${name} = ${value}`);
            assert.match(result.stdout, new RegExp(`${name.replace(".", "\\.")} must contain a JSON object`), `${name} = ${value}`);
            assert.doesNotMatch(result.stdout, /Release /, `${name} = ${value}`);
            assert.equal(result.outputs, "", `${name} = ${value} writes no tag`);
        }
    }
});

test("manifests that disagree, or a release that is not pinned, fail", async () => {
    const cases = [
        [plugin("1.3.0"), marketplace(), /"version" is "1\.2\.0"; plugin\.json says "1\.3\.0"/],
        [plugin(), marketplace("1.2.0", "./"), /"source" must pin the release/],
        [plugin(), marketplace("1.2.0", { source: "github", repo: "example/demo", ref: "main" }), /"source" must pin the release/],
        [plugin(), marketplace("1.2.0", { source: "github", repo: "example/demo", ref: "v1.2.0", sha: "a".repeat(40) }), /"source" must pin the release/],
        [plugin("1.2"), marketplace(), /"version" must be MAJOR\.MINOR\.PATCH/],
        [{ ...plugin(), repository: "https://example.com/demo" }, marketplace(), /"repository" must be a https:\/\/github\.com/],
        [{ ...plugin(), name: "missing" }, marketplace(), /has no plugin entry named "missing"/],
        [plugin(), raw("{"), /marketplace\.json cannot be read/],
    ];
    for (const [pluginJson, marketplaceJson, message] of cases) {
        const result = await check(pluginJson, marketplaceJson);
        assert.equal(result.code, 1, String(message));
        assert.match(result.stdout, message);
        assert.equal(result.outputs, "", `${message} writes no tag`);
    }
});

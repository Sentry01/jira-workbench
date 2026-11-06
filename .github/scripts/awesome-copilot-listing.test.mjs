import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./awesome-copilot-listing.mjs", import.meta.url));
const OLD_SHA = "0".repeat(40);
const NEW_SHA = "a".repeat(40);
const demo = (version = "1.0.0", sha = OLD_SHA, repo = "example/demo") => ({
    name: "demo", description: "Demo", version, keywords: ["x"],
    source: { source: "github", repo, ref: `v${version}`, sha },
});
const other = { name: "other", version: "9.9.9", source: { source: "github", repo: "someone/other", ref: "v9.9.9" } };

// Runs the script on a scratch external.json; returns its exit code, output, GITHUB_OUTPUT and the file afterwards.
async function run(listings, version = "1.2.0", sha = NEW_SHA) {
    const root = await mkdtemp(join(tmpdir(), "jw-listing-"));
    try {
        const file = join(root, "external.json");
        const output = join(root, "github-output");
        await writeFile(file, `${JSON.stringify(listings, null, 2)}\n`);
        await writeFile(output, "");
        const result = await exec(process.execPath, [SCRIPT, file, "demo", "example/demo", version, sha], { env: { ...process.env, GITHUB_OUTPUT: output } })
            .then(({ stdout }) => ({ code: 0, stdout, stderr: "" }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
        return { ...result, output: await readFile(output, "utf8"), text: await readFile(file, "utf8") };
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("pins the entry to the release and leaves every other field and entry alone", async () => {
    const result = await run([other, demo()]);
    assert.equal(result.code, 0);
    assert.equal(result.output, "changed=true\n");
    assert.deepEqual(JSON.parse(result.text), [other, { ...demo("1.2.0", NEW_SHA) }]);
});

test("reports no change when the listing already pins the release", async () => {
    const listings = [other, demo("1.2.0", NEW_SHA)];
    const result = await run(listings);
    assert.equal(result.code, 0);
    assert.equal(result.output, "changed=false\n");
    assert.equal(result.text, `${JSON.stringify(listings, null, 2)}\n`);
});

test("refuses to add a listing that is missing or comes from another repository", async () => {
    for (const listings of [[other], [other, demo("1.0.0", OLD_SHA, "fork/demo")]]) {
        const result = await run(listings);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /exactly one GitHub entry named "demo" from example\/demo; found 0/);
        assert.equal(result.text, `${JSON.stringify(listings, null, 2)}\n`);
    }
});

test("rejects a malformed version or SHA without touching the file", async () => {
    for (const [version, sha, message] of [["1.2", NEW_SHA, /version must be/], ["1.2.0", "abc123", /sha must be/]]) {
        const result = await run([demo()], version, sha);
        assert.equal(result.code, 1);
        assert.match(result.stderr, message);
        assert.deepEqual(JSON.parse(result.text), [demo()]);
    }
});

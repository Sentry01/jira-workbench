import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(new URL("../workflows/awesome-copilot-sync.yml", import.meta.url), "utf8");
const tokenStep = workflow.match(/      - name: Check for the token\n[\s\S]*?        run: \|\n((?: {10}.*\n)+)/)?.[1];

function checkToken(token) {
    assert.ok(tokenStep, "workflow must have a token-check step");
    return spawnSync("bash", ["-e", "-c", tokenStep], {
        encoding: "utf8",
        env: { ...process.env, TOKEN: token, GITHUB_OUTPUT: "/dev/null" },
    });
}

test("fails the sync when the token is missing", () => {
    const result = checkToken("");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::AWESOME_COPILOT_TOKEN is not set/);
});

test("allows the sync to continue when a token is present", () => {
    const result = checkToken("test-token");
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /test-token/);
});

test("the generated pull request retains the upstream template without claiming unverified testing", () => {
    const body = workflow.match(/cat > "\$RUNNER_TEMP\/body\.md" <<EOF\n([\s\S]*?)\n {10}EOF/)?.[1];
    assert.ok(body, "workflow must generate a pull request body");
    const types = body.match(/## Type of Contribution\n([\s\S]*?)\n {10}---/)?.[1];
    assert.ok(types, "pull request body must have contribution types");
    assert.deepEqual([...types.matchAll(/- \[([ x])\] (.+)/g)].map(([, checked, label]) => [checked, label]), [
        [" ", "New instruction file."],
        [" ", "New prompt file."],
        [" ", "New agent file."],
        [" ", "New plugin."],
        [" ", "New skill file."],
        [" ", "New agentic workflow."],
        [" ", "New canvas extension."],
        ["x", "Update to existing instruction, prompt, agent, plugin, skill, workflow, or canvas extension."],
        [" ", "Other (please specify):"],
    ]);
    assert.match(body, /<!-- Briefly describe your contribution and its purpose\./);
    assert.match(body, /<!-- Add any additional information or context for reviewers here\. -->/);
    assert.match(body, /- \[ \] I have tested my instructions, prompt, agent, skill, workflow, or canvas extension with GitHub Copilot\./);
    assert.doesNotMatch(body, /\$(?:VERSION|TAG|SHA)\b/);
});

function runPullRequestStep(openNumber, diffStatus = "1") {
    const start = workflow.indexOf("      - name: Open or update the pull request\n");
    assert.notEqual(start, -1);
    const next = workflow.indexOf("\n      - ", start + 1);
    const step = workflow.slice(start, next === -1 ? undefined : next);
    const run = step.indexOf("        run: |\n");
    assert.notEqual(run, -1);
    const script = step.slice(run + "        run: |\n".length)
        .split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
    const root = mkdtempSync(join(tmpdir(), "jw-sync-"));
    try {
        writeFileSync(join(root, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_COMMANDS"
if [ "$1" = diff ]; then exit "$DIFF_STATUS"; fi
`, { mode: 0o755 });
        writeFileSync(join(root, "gh"), `#!/bin/sh
if [ "$1" = api ] && [ "$2" = user ]; then
  case "$4" in .login) echo author ;; .id) echo 123 ;; esac
elif [ "$1" = pr ] && [ "$2" = list ]; then
  echo "$OPEN_PR"
else
  printf '%s\\n' "$@" > "$GH_ARGS"
fi
`, { mode: 0o755 });
        const result = spawnSync("bash", ["-e", "-c", script], {
            encoding: "utf8",
            cwd: root,
            env: {
                ...process.env, PATH: `${root}:${process.env.PATH}`, GH_ARGS: join(root, "gh-args"),
                OPEN_PR: openNumber, DIFF_STATUS: diffStatus, GIT_COMMANDS: join(root, "git-commands"),
                RUNNER_TEMP: root, UPSTREAM: "github/awesome-copilot", BRANCH: "jira-workbench-sync",
                GITHUB_REPOSITORY: "example/jira-workbench", NAME: "jira-workbench",
                VERSION: "1.2.3", TAG: "v1.2.3", SHA: "a".repeat(40),
            },
        });
        return {
            result,
            args: existsSync(join(root, "gh-args")) ? readFileSync(join(root, "gh-args"), "utf8").trim().split("\n") : [],
            body: existsSync(join(root, "body.md")) ? readFileSync(join(root, "body.md"), "utf8") : "",
            git: readFileSync(join(root, "git-commands"), "utf8"),
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

test("updating an open pull request preserves its body", () => {
    const { result, args } = runPullRequestStep("17");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(args, [
        "api", "--method", "PATCH", "repos/github/awesome-copilot/pulls/17",
        "-f", "title=Update jira-workbench external plugin to 1.2.3", "--silent",
    ]);
});

test("creates a pull request from the fork when none is open", () => {
    const { result, args, body } = runPullRequestStep("");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(args.slice(0, -1), [
        "pr", "create", "--repo", "github/awesome-copilot", "--base", "main",
        "--head", "author:jira-workbench-sync", "--title",
        "Update jira-workbench external plugin to 1.2.3", "--body-file",
    ]);
    assert.match(body, /https:\/\/github\.com\/example\/jira-workbench\/releases/);
});

test("does not rewrite an open pull request whose proposed files already match", () => {
    const { result, args, git } = runPullRequestStep("17", "0");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(args, []);
    assert.match(git, /fetch --quiet origin jira-workbench-sync/);
    assert.doesNotMatch(git, /^push /m);
});

test("fails instead of pushing when the existing pull request cannot be compared", () => {
    const { result, args, git } = runPullRequestStep("17", "128");
    assert.equal(result.status, 128);
    assert.deepEqual(args, []);
    assert.doesNotMatch(git, /^push /m);
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertRepo } from "./validate.mjs";
const exec = promisify(execFile);

export async function readPr(repo, number, run = exec) {
    assertRepo(repo, "Invalid GitHub repository.");
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("A positive PR number is required.");
    const fields = "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision";
    const { stdout } = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", fields], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    const expected = `https://github.com/${repo}/pull/${number}`;
    if (result.number !== number || result.url?.toLowerCase() !== expected.toLowerCase())
        throw new Error("GitHub returned a different identity than the requested reference.");
    return result;
}

// Posts the "CCR gate" commit status: success only when Copilot code review has reviewed the pull request's
// current head commit and found it clean. Required on main, it stops any merge, by a person or an agent,
// while that review is missing, still running, out of date, or reports open issues.
// Unresolved review threads are enforced separately, by main's conversation resolution rule.
// Usage: node .github/scripts/ccr-gate.mjs
// It reads and writes through the GitHub API only; it never checks out or runs pull request code.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client, postStatus } from "./stack-gate.mjs";

export const CONTEXT = "CCR gate";
export const REVIEWER = "copilot-pull-request-reviewer[bot]";
const VERDICTS = ["Approval recommended", "Needs a closer look", "Changes recommended"];
// The overview's own summary line for a clean review, and its count fields for open and previously missed
// issues. Only those fields count: a resolved finding's title can mention issues too.
const NO_OPEN_ISSUES = /^\*\*No open issues\*\*/m;
const SOME_ISSUES = /^\s*<summary>\s*<strong>\s*[1-9]\d* (?:open|previously missed) issues?\s*<\/strong>/im;

// The verdict heading of a Copilot code review overview, or null when the body has none.
export function verdictOf(body = "") {
    for (const line of body.split("\n")) {
        if (!line.startsWith("### ")) continue;
        const verdict = VERDICTS.find(v => line.includes(v));
        if (verdict) return verdict;
    }
    return null;
}

// Clean means the latest Copilot review is of the head commit, recommends approval, has the "No open issues"
// summary line, and has no open or previously missed issue count. "Needs a closer look" is not clean: it can
// report issues the review missed earlier. Text that merely mentions "No open issues" is not the summary line.
export function ccrStatus(pull, reviews = []) {
    const review = reviews.filter(r => r.user?.login === REVIEWER && r.state !== "PENDING").at(-1);
    const head = pull.head.sha.slice(0, 7);
    if (!review) return { state: "failure", description: "Waiting for Copilot code review." };
    if (review.commit_id !== pull.head.sha) return { state: "failure", description: `Waiting for Copilot code review of ${head}.` };
    const verdict = verdictOf(review.body);
    const body = review.body ?? "";
    if (verdict === "Approval recommended" && NO_OPEN_ISSUES.test(body) && !SOME_ISSUES.test(body)) {
        return { state: "success", description: `Copilot code review of ${head}: approval recommended, no open issues.` };
    }
    return { state: "failure", description: `Copilot code review of ${head}: ${verdict ? verdict.toLowerCase() : "no recognized verdict"}.` };
}

// Every run checks every open pull request, from the open list alone: one request for the list, then one for
// each pull request's reviews and one for each head commit's statuses, to stay well inside the GITHUB_TOKEN
// budget of 1,000 requests an hour. Several open pull requests can share a head commit, and a status belongs
// to the commit, so success needs a clean review on every one of them. Runs are serialized, and a newer
// pending run replaces an older one, so the last status posted always comes from the latest read.
// If a check fails partway, its commit is blocked rather than left with an earlier success, and the rest are
// still checked. Returns how many statuses changed and the errors met.
export async function run(api, { targetUrl, log = console.log } = {}) {
    const heads = new Map();
    for (const pull of await api.list("pulls?state=open&per_page=100")) {
        if (!heads.has(pull.head.sha)) heads.set(pull.head.sha, []);
        heads.get(pull.head.sha).push(pull);
    }
    let changed = 0;
    const errors = [];
    for (const [sha, pulls] of heads) {
        const names = pulls.map(p => `#${p.number}`).join(", ");
        try {
            const results = [];
            for (const p of pulls) {
                results.push({ number: p.number, ...ccrStatus(p, await api.list(`pulls/${p.number}/reviews?per_page=100`)) });
            }
            const failed = results.find(r => r.state !== "success");
            const result = !failed ? results[0]
                : results.length > 1 ? { state: "failure", description: `#${failed.number}: ${failed.description}` }
                : failed;
            const posted = await postStatus(api, sha, CONTEXT, result, targetUrl);
            if (posted) changed++;
            log(`${names}: ${result.state}: ${result.description}${posted ? "" : " (unchanged)"}`);
        } catch (error) {
            errors.push(`${names}: ${error.message}`);
            log(`${names}: ${error.message}`);
            const blocked = { state: "failure", description: "Could not check Copilot code review; blocked until the CCR gate runs again." };
            try { if (await postStatus(api, sha, CONTEXT, blocked, targetUrl)) changed++; }
            catch (postError) { log(`Could not block ${sha.slice(0, 7)}: ${postError.message}`); }
        }
    }
    return { changed, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    const api = client({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
    const targetUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    // `changed` lets the workflow re-evaluate stacks only when a member's CCR gate may have changed.
    run(api, { targetUrl }).then(({ changed, errors }) => {
        if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${changed > 0}\n`);
        if (errors.length) throw new Error(`CCR gate failed for ${errors.join("; ")}`);
    }).catch(error => {
        console.log(`::error::${error.message}`);
        process.exit(1);
    });
}

// Posts the "CCR gate" commit status: success only when Copilot code review has reviewed the pull request's
// current head commit and found it clean. Required on main, it stops any merge, by a person or an agent,
// while that review is missing, still running, out of date, or reports open issues.
// Unresolved review threads are enforced separately, by main's conversation resolution rule.
// Usage: node .github/scripts/ccr-gate.mjs
// It reads and writes through the GitHub API only; it never checks out or runs pull request code.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client, postStatus } from "./stack-gate.mjs";

export const CONTEXT = "CCR gate";
export const REVIEWER = "copilot-pull-request-reviewer[bot]";
const VERDICTS = ["Approval recommended", "Needs a closer look", "Changes recommended"];

// The verdict heading of a Copilot code review overview, or null when the body has none.
export function verdictOf(body = "") {
    for (const line of body.split("\n")) {
        if (!line.startsWith("### ")) continue;
        const verdict = VERDICTS.find(v => line.includes(v));
        if (verdict) return verdict;
    }
    return null;
}

// Clean means the latest Copilot review is of the head commit, recommends approval and lists no open issues.
// "Needs a closer look" is not clean: it can report issues the review missed earlier.
export function ccrStatus(pull, reviews = []) {
    const review = reviews.filter(r => r.user?.login === REVIEWER && r.state !== "PENDING").at(-1);
    const head = pull.head.sha.slice(0, 7);
    if (!review) return { state: "failure", description: "Waiting for Copilot code review." };
    if (review.commit_id !== pull.head.sha) return { state: "failure", description: `Waiting for Copilot code review of ${head}.` };
    const verdict = verdictOf(review.body);
    if (verdict === "Approval recommended" && /\bNo open issues\b/.test(review.body ?? "")) {
        return { state: "success", description: `Copilot code review of ${head}: approval recommended, no open issues.` };
    }
    return { state: "failure", description: `Copilot code review of ${head}: ${verdict ? verdict.toLowerCase() : "no recognized verdict"}.` };
}

// The schedule, and a manual run without a number, check every open pull request.
export async function pullNumbers(api, eventName, event, input) {
    if (event.pull_request) return [event.pull_request.number];
    if (eventName === "workflow_dispatch" && input) {
        if (!/^\d+$/.test(String(input).trim())) throw new Error(`"${input}" is not a pull request number.`);
        return [Number(input)];
    }
    return (await api.list("pulls?state=open&per_page=100")).map(p => p.number);
}

export async function run(api, eventName, event, { input, targetUrl, log = console.log } = {}) {
    for (const number of await pullNumbers(api, eventName, event, input)) {
        const pull = await api.get(`pulls/${number}`);
        if (!pull || pull.state !== "open") continue;
        const reviews = await api.list(`pulls/${number}/reviews?per_page=100`);
        const result = ccrStatus(pull, reviews);
        const posted = await postStatus(api, pull.head.sha, CONTEXT, result, targetUrl);
        log(`#${number}: ${result.state}: ${result.description}${posted ? "" : " (unchanged)"}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const env = process.env;
    const api = client({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
    const targetUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    run(api, env.GITHUB_EVENT_NAME, event, { input: env.PULL_REQUEST, targetUrl }).catch(error => {
        console.log(`::error::${error.message}`);
        process.exit(1);
    });
}

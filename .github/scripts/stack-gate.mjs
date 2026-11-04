// Posts the "Stack gate" commit status, so no pull request in a stack merges unless the whole stack can.
// GitHub already blocks merging a pull request while one below it is not ready, but it lets a lower part of
// the stack merge on its own. This status is success on every open member only when all of them are ready:
// not a draft, required checks passing, no reviewer requesting changes, and no unresolved review thread.
// Usage: node .github/scripts/stack-gate.mjs resolve | evaluate <stack-number>
// It reads and writes through the GitHub API only; it never checks out or runs pull request code.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CONTEXT = "Stack gate";
// GitHub counts these check run conclusions as passing for a required check.
const PASSING = new Set(["success", "neutral", "skipped"]);
const DESCRIPTION_LIMIT = 140;

// The checks the stack's base branch requires, from branch protection and rulesets, without the gate itself:
// judging a member by its own Stack gate status would make every member wait on the others forever.
// An app ID pins a check to one source; -1 or none means any source.
export function requiredChecks(branch, rules = []) {
    const found = new Map();
    const add = (context, appId) => {
        if (!context || context === CONTEXT) return;
        const app = Number(appId) > 0 ? Number(appId) : null;
        found.set(`${context}\0${app ?? ""}`, { context, appId: app });
    };
    const classic = branch?.protection?.required_status_checks;
    if (classic?.checks?.length) for (const check of classic.checks) add(check.context, check.app_id);
    else for (const context of classic?.contexts ?? []) add(context, null);
    for (const rule of rules) {
        if (rule?.type !== "required_status_checks") continue;
        for (const check of rule.parameters?.required_status_checks ?? []) add(check.context, check.integration_id);
    }
    return [...found.values()];
}

// Each required check is "pass", "fail" or "pending", from its latest check run or its commit status.
// A check pinned to an app accepts only that app's check runs; commit statuses carry no app to match.
export function checkStates(required, checkRuns = [], statuses = []) {
    return required.map(({ context, appId }) => {
        const run = checkRuns
            .filter(r => r.name === context && (!appId || r.app?.id === appId))
            .sort((a, b) => b.id - a.id)[0];
        const status = appId ? null : statuses.find(s => s.context === context);
        const states = [
            !run ? null : run.status !== "completed" ? "pending" : PASSING.has(run.conclusion) ? "pass" : "fail",
            !status ? null : status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail",
        ];
        const state = states.includes("pass") ? "pass" : states.includes("fail") && !states.includes("pending") ? "fail" : "pending";
        return { context, state };
    });
}

// Reviewers whose latest review requests changes. Comments do not change a reviewer's verdict; a dismissal clears it.
export function changesRequestedBy(reviews = []) {
    const latest = new Map();
    for (const review of reviews) {
        if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user?.login ?? "", review.state);
    }
    return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
}

// What keeps one open member from merging: short labels for the status, details for the log.
// main requires conversation resolution, so an unresolved review thread blocks a member too.
export function memberProblems({ pull, required, checkRuns, statuses, reviews, unresolvedThreads = 0 }) {
    const problems = [];
    const details = [];
    if (pull.draft) { problems.push("draft"); details.push("is a draft"); }
    const blockers = changesRequestedBy(reviews);
    if (blockers.length) { problems.push("changes requested"); details.push(`changes requested by ${blockers.join(", ")}`); }
    if (unresolvedThreads > 0) {
        const threads = `${unresolvedThreads} unresolved thread${unresolvedThreads === 1 ? "" : "s"}`;
        problems.push(threads);
        details.push(`${threads} in review`);
    }
    const checks = checkStates(required, checkRuns, statuses);
    const failing = checks.filter(c => c.state === "fail").map(c => c.context);
    const pending = checks.filter(c => c.state === "pending").map(c => c.context);
    if (failing.length) { problems.push("checks failing"); details.push(`failing: ${failing.join(", ")}`); }
    if (pending.length) { problems.push("checks pending"); details.push(`waiting for: ${pending.join(", ")}`); }
    return { number: pull.number, problems, details };
}

// One verdict for the whole stack; every open member gets the same status.
export function verdict(stackNumber, members) {
    const notReady = members.filter(m => m.problems.length);
    if (!notReady.length) {
        const count = members.length === 1 ? "The open pull request" : `All ${members.length} open pull requests`;
        return { state: "success", description: `${count} in stack #${stackNumber} ${members.length === 1 ? "is" : "are"} ready.` };
    }
    const head = `Stack #${stackNumber} not ready: `;
    const parts = notReady.map(m => `#${m.number} (${m.problems.join(", ")})`);
    let description = head + parts.join(", ");
    for (let shown = parts.length - 1; description.length > DESCRIPTION_LIMIT && shown > 0; shown--) {
        description = `${head}${parts.slice(0, shown).join(", ")} and ${parts.length - shown} more`;
    }
    return { state: "failure", description: description.slice(0, DESCRIPTION_LIMIT) };
}

export const NOT_IN_STACK = { state: "success", description: "Not in a stack." };

// A minimal REST client. get() returns null for 404; list() follows Link pagination.
export function client({ token, repository, apiUrl = "https://api.github.com" }) {
    const request = async (method, path, body) => {
        const url = path.startsWith("https://") ? path : `${apiUrl}/repos/${repository}/${path}`;
        const response = await fetch(url, {
            method,
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "user-agent": "jira-workbench-stack-gate",
                ...(body ? { "content-type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (method === "GET" && response.status === 404) return { data: null, next: null };
        if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
        const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
        return { data: await response.json(), next };
    };
    return {
        get: async path => (await request("GET", path)).data,
        list: async (path, key) => {
            const items = [];
            for (let url = path; url;) {
                const { data, next } = await request("GET", url);
                if (!data) break;
                items.push(...(key ? data[key] ?? [] : data));
                url = next;
            }
            return items;
        },
        post: async (path, body) => (await request("POST", path, body)).data,
        graphql: async (query, variables) => {
            const { data } = await request("POST", `${apiUrl}/graphql`, { query, variables });
            if (data.errors?.length) throw new Error(`GraphQL: ${data.errors.map(e => e.message).join("; ")}`);
            return data.data;
        },
        repository,
    };
}

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
    }
  }
}`;

// The number of review threads on a pull request that are not resolved. Only GraphQL exposes isResolved.
export async function unresolvedThreads(api, number) {
    const [owner, name] = api.repository.split("/");
    let count = 0;
    for (let cursor = null, more = true; more;) {
        const data = await api.graphql(THREADS, { owner, name, number, cursor });
        const threads = data?.repository?.pullRequest?.reviewThreads;
        if (!threads) break;
        count += threads.nodes.filter(t => !t.isResolved).length;
        more = threads.pageInfo.hasNextPage;
        cursor = threads.pageInfo.endCursor;
    }
    return count;
}

// Posts only a change: GitHub keeps at most 1000 statuses per commit and context, and the sweep re-posts often.
async function post(api, sha, { state, description }, targetUrl, statuses) {
    statuses ??= (await api.get(`commits/${sha}/status?per_page=100`))?.statuses ?? [];
    const current = statuses.find(s => s.context === CONTEXT);
    if (current?.state === state && current.description === description) return false;
    await api.post(`statuses/${sha}`, { state, description, context: CONTEXT, ...(targetUrl ? { target_url: targetUrl } : {}) });
    return true;
}

// Recomputes one stack and posts the verdict to the head commit of every open member.
export async function evaluateStack(api, stackNumber, { targetUrl, log = console.log } = {}) {
    const stack = await api.get(`stacks/${stackNumber}`);
    if (!stack) {
        log(`Stack #${stackNumber} no longer exists; nothing to gate.`);
        return null;
    }
    const base = encodeURIComponent(stack.base.ref);
    const branch = await api.get(`branches/${base}`);
    const rules = await api.list(`rules/branches/${base}?per_page=100`);
    const required = requiredChecks(branch, rules);
    const members = [];
    for (const entry of stack.pull_requests) {
        const pull = await api.get(`pulls/${entry.number}`);
        if (!pull || pull.state !== "open" || pull.merged_at) continue;
        const sha = pull.head.sha;
        const [checkRuns, combined, reviews, threads] = await Promise.all([
            api.list(`commits/${sha}/check-runs?filter=latest&per_page=100`, "check_runs"),
            api.get(`commits/${sha}/status?per_page=100`),
            api.list(`pulls/${pull.number}/reviews?per_page=100`),
            unresolvedThreads(api, pull.number),
        ]);
        const statuses = combined?.statuses ?? [];
        members.push({ ...memberProblems({ pull, required, checkRuns, statuses, reviews, unresolvedThreads: threads }), sha, statuses });
    }
    if (!members.length) {
        log(`Stack #${stackNumber} has no open pull requests; nothing to gate.`);
        return null;
    }
    // Branch protection is readable with repository read access. If it is hidden, fail closed rather than
    // judge the stack by no checks at all.
    let result = verdict(stackNumber, members);
    if (branch?.protected && !branch.protection) {
        result = { state: "failure", description: `Cannot read the checks ${stack.base.ref} requires; run the stack gate again.` };
    }
    log(`Stack #${stackNumber} into ${stack.base.ref}, required checks: ${required.map(c => c.context).join(", ") || "none"}`);
    for (const m of members) log(`  #${m.number} ${m.sha.slice(0, 7)}: ${m.details.join("; ") || "ready"}`);
    log(`Stack gate: ${result.state}: ${result.description}`);
    for (const m of members) await post(api, m.sha, result, targetUrl, m.statuses);
    return { ...result, members };
}

// Which pull requests an event touches. A CI run names its pull requests, or is found through its commit.
// The schedule, and a manual run without a number, sweep every open pull request.
export async function pullsForEvent(api, eventName, event, input) {
    if (eventName === "schedule" || (eventName === "workflow_dispatch" && !input)) {
        const pulls = await api.list("pulls?state=open&per_page=100");
        return pulls.map(pull => ({ number: pull.number, pull }));
    }
    if (eventName === "workflow_dispatch") {
        if (!/^\d+$/.test(String(input).trim())) throw new Error(`"${input}" is not a pull request number.`);
        return [{ number: Number(input) }];
    }
    if (eventName === "workflow_run") {
        const run = event.workflow_run;
        if (run.pull_requests?.length) return run.pull_requests.map(p => ({ number: p.number }));
        const pulls = await api.list(`commits/${run.head_sha}/pulls?per_page=100`);
        return pulls.filter(p => p.state === "open" && p.head?.sha === run.head_sha).map(p => ({ number: p.number }));
    }
    const pull = event.pull_request;
    return pull ? [{ number: pull.number, stack: pull.stack?.number }] : [];
}

// Posts success on pull requests outside any stack, and returns the stacks to evaluate.
// A closed pull request keeps the stack its event named, so the members left behind are refreshed.
export async function resolve(api, eventName, event, { input, targetUrl, log = console.log } = {}) {
    const stacks = new Set();
    for (const { number, stack, pull: listed } of await pullsForEvent(api, eventName, event, input)) {
        const pull = listed ?? await api.get(`pulls/${number}`);
        const current = pull?.stack?.number ?? (await api.list(`stacks?pull_request=${number}`))[0]?.number;
        if (current ?? stack) { stacks.add(current ?? stack); continue; }
        if (pull?.state !== "open") continue;
        const posted = await post(api, pull.head.sha, NOT_IN_STACK, targetUrl);
        log(`#${number} is not in a stack: ${posted ? "posted success" : "already success"}.`);
    }
    return [...stacks];
}

async function main() {
    const [mode, stackNumber] = process.argv.slice(2);
    const env = process.env;
    const api = client({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
    const targetUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    if (mode === "resolve") {
        const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
        const stacks = await resolve(api, env.GITHUB_EVENT_NAME, event, { input: env.PULL_REQUEST, targetUrl });
        console.log(`Stacks to evaluate: ${stacks.map(s => `#${s}`).join(", ") || "none"}`);
        if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `stacks=${JSON.stringify(stacks)}\n`);
    } else if (mode === "evaluate" && /^\d+$/.test(stackNumber ?? "")) {
        await evaluateStack(api, Number(stackNumber), { targetUrl });
    } else {
        throw new Error("Usage: node .github/scripts/stack-gate.mjs resolve | evaluate <stack-number>");
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.log(`::error::${error.message}`);
        process.exit(1);
    });
}

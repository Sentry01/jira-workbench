import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertRepo } from "./validate.mjs";
const exec = promisify(execFile);

const PR_TTL_MS = 60_000;
const GH_CONCURRENCY = 4;
const CHECK_FIELDS = ["name", "context", "conclusion", "state", "status"];

export async function readPr(repo, number, run = exec) {
    assertRepo(repo, "Invalid GitHub repository.");
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("A positive PR number is required.");
    const fields = "number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision";
    const { stdout } = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", fields], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    const expected = `https://github.com/${repo}/pull/${number}`;
    if (result.number !== number || result.url?.toLowerCase() !== expected.toLowerCase())
        throw new Error("GitHub returned a different identity than the requested reference.");
    // Stored with every trace: keep only the check fields the panel reads.
    if (Array.isArray(result.statusCheckRollup))
        result.statusCheckRollup = result.statusCheckRollup.filter(check => check && typeof check === "object")
            .map(check => Object.fromEntries(CHECK_FIELDS.filter(field => check[field] != null).map(field => [field, check[field]])));
    return result;
}

// One per process, shared by every panel: concurrent reads of the same PR share one gh call, a result is reused for
// a minute unless the caller asks for a fresh read, and at most 4 gh processes run at once.
export class PrReader {
    constructor({ run = exec, ttlMs = PR_TTL_MS, limit = GH_CONCURRENCY, now = Date.now } = {}) {
        Object.assign(this, { run, ttlMs, limit, now });
        this.inflight = new Map();
        this.recent = new Map();
        this.active = 0;
        this.waiting = [];
        this.read = this.read.bind(this);
    }
    read(repo, number, { fresh = false } = {}) {
        const key = `${String(repo).toLowerCase()}#${number}`;
        if (this.inflight.has(key)) return this.inflight.get(key);
        const hit = this.recent.get(key);
        if (!fresh && hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
        const pending = this.slot(() => readPr(repo, number, this.run)).then(value => {
            this.recent.set(key, { at: this.now(), value });
            return value;
        }).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
        for (const [old, entry] of this.recent) if (this.now() - entry.at >= this.ttlMs) this.recent.delete(old);
        return pending;
    }
    async slot(work) {
        if (this.active >= this.limit) await new Promise(resolve => this.waiting.push(resolve));
        else this.active++;
        try { return await work(); }
        finally {
            const next = this.waiting.shift();
            if (next) next(); else this.active--;
        }
    }
}

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const STALE_LOCK_MS = 30_000;
const FINISHED_REQUESTS_KEPT = 20;

function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
}

// A writer that crashed between creating and removing the lock must not block every later write.
async function breakStaleLock(lockPath) {
    let info, owner;
    try {
        info = await stat(lockPath);
        owner = Number.parseInt((await readFile(lockPath, "utf8")).split(" ")[0], 10);
    } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
    }
    const age = Date.now() - info.mtimeMs;
    if (age < STALE_LOCK_MS && (!Number.isSafeInteger(owner) || alive(owner))) return false;
    const aside = `${lockPath}.stale-${randomUUID()}`;
    try { await rename(lockPath, aside); }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
    const moved = await stat(aside);
    if (moved.ino !== info.ino) {
        // Another writer replaced the stale lock between our checks; hand its lock back.
        await rename(aside, lockPath);
        return false;
    }
    await unlink(aside);
    return true;
}

// The panel re-reads this file every few seconds and rewrites it on every preference change, so keep it small.
// Every request still stored as queued (whether waiting or expired) is kept; finished ones are pruned per scope.
function compact(data) {
    for (const link of Object.values(data.links)) {
        // `origins` held GitHub source issues for a trace step that was retired.
        if (link && typeof link === "object") delete link.origins;
    }
    const finished = new Map();
    for (const [id, request] of Object.entries(data.requests)) {
        if (!request || typeof request !== "object") continue;
        // Older launches stored full descendant summaries; the reviewed context needs only their keys.
        if (Array.isArray(request.brief?.children))
            request.brief.children = request.brief.children.map(child => child && typeof child === "object" ? child.key : child);
        if (request.status === "queued") continue;
        const at = Date.parse(request.completedAt || request.cancelledAt || request.at);
        if (!finished.has(request.scope)) finished.set(request.scope, []);
        finished.get(request.scope).push({ id, at: Number.isFinite(at) ? at : -Infinity });
    }
    for (const list of finished.values())
        for (const { id } of list.sort((a, b) => b.at - a.at).slice(FINISHED_REQUESTS_KEPT)) delete data.requests[id];
}

export class Store {
    constructor(path) { this.path = path; }
    async read() {
        let text;
        try { text = await readFile(join(this.path, "state.json"), "utf8"); }
        catch (error) {
            if (error.code === "ENOENT") return { version: 1, mappings: {}, links: {}, requests: {} };
            throw error;
        }
        const data = JSON.parse(text);
        if (data.version !== 1 || !data.mappings || !data.links || !data.requests)
            throw new Error("Unsupported Jira Workbench state; preserve the file and check the extension version.");
        return data;
    }
    async update(change) {
        await mkdir(this.path, { recursive: true, mode: 0o700 });
        const lockPath = join(this.path, "write.lock");
        let lock;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { lock = await open(lockPath, "wx", 0o600); break; }
            catch (error) {
                if (error.code !== "EEXIST") throw error;
                if (await breakStaleLock(lockPath)) continue;
                await delay(50);
            }
        }
        if (!lock) throw new Error(`State is locked by another writer. If all Workbench sessions are stopped, inspect ${lockPath}.`);
        const temp = join(this.path, `state-${randomUUID()}.tmp`);
        try {
            await lock.writeFile(`${process.pid} ${Date.now()}`);
            const data = await this.read();
            const result = await change(data);
            compact(data);
            const file = await open(temp, "wx", 0o600);
            try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync(); }
            finally { await file.close(); }
            await rename(temp, join(this.path, "state.json"));
            return result;
        } finally {
            await lock.close();
            try { await unlink(lockPath); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            try { await unlink(temp); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    }
}

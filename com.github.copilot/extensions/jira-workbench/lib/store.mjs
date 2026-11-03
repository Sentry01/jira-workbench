import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isSessionId } from "./validate.mjs";

const STALE_LOCK_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const FINISHED_REQUESTS_KEPT = 20;
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

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

// Earlier versions stored the host's echoed session ID, which the host could return masked ("******"). The launch
// receipt kept the real ID; restore it only when the receipt and invalid record uniquely match each other.
function repairSessionIds(data) {
    for (const [scope, link] of Object.entries(data.links)) {
        if (!Array.isArray(link?.sessions)) continue;
        const invalidSessions = link.sessions.filter(session => session && !isSessionId(session.id));
        for (const session of invalidSessions) {
            const owners = Object.values(data.requests).filter(r => r?.scope === scope && r.status === "attached"
                && isSessionId(r.sessionId) && !link.sessions.some(s => s?.id === r.sessionId)
                && (!session.contextHash || r.contextHash === session.contextHash));
            if (owners.length === 1 && invalidSessions.filter(s => !s.contextHash || s.contextHash === owners[0].contextHash).length === 1)
                session.id = owners[0].sessionId;
        }
    }
    return data;
}

// Entries that parse but have the wrong shape (a hand edit, another build sharing the file) are set aside rather than
// break every panel; the next write drops them. Returns one description per entry set aside or repaired.
function validate(data) {
    const problems = [];
    const drop = (collection, key, why) => { delete data[collection][key]; problems.push(`${collection}["${key}"] ${why}; it was ignored`); };
    for (const [key, request] of Object.entries(data.requests)) {
        if (!isObject(request)) drop("requests", key, "is not an object");
        else if (typeof request.scope !== "string") drop("requests", key, "has no scope");
    }
    for (const [key, mapping] of Object.entries(data.mappings))
        if (!isObject(mapping)) drop("mappings", key, "is not an object");
    for (const [key, link] of Object.entries(data.links)) {
        if (!isObject(link)) { drop("links", key, "is not an object"); continue; }
        for (const list of ["sessions", "prs"]) {
            if (!Array.isArray(link[list])) { link[list] = []; problems.push(`links["${key}"].${list} is not a list; it was reset`); continue; }
            const kept = link[list].filter(isObject);
            if (kept.length !== link[list].length) {
                problems.push(`links["${key}"].${list} held ${link[list].length - kept.length} malformed entries; they were ignored`);
                link[list] = kept;
            }
        }
    }
    if (data.preferences !== undefined && !isObject(data.preferences)) { data.preferences = {}; problems.push("preferences is not an object; it was reset"); }
    return problems;
}

// The panel re-reads this file every few seconds and rewrites it on every preference change, so keep it small.
// Every request still stored as queued (whether waiting or expired) is kept; finished ones are pruned per scope.
function compact(data) {
    // A change can only have written these shapes by mistake; normalize them so the file stays valid.
    validate(data);
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
    constructor(path, { heartbeatMs = HEARTBEAT_MS } = {}) {
        this.path = path;
        this.heartbeatMs = heartbeatMs;
        // Writers in this process wait here instead of polling write.lock; the lock still guards other processes.
        this.queue = Promise.resolve();
        this.problems = new Map();
    }
    // One message per malformed entry seen by this process, naming the file so the user can find it.
    notices() { return [...this.problems.values()]; }
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
        if (![data.mappings, data.links, data.requests].every(isObject))
            throw new Error(`Unsupported Jira Workbench state in ${join(this.path, "state.json")}; preserve the file and check the extension version.`);
        for (const problem of validate(data)) {
            if (this.problems.has(problem)) continue;
            const message = `Jira Workbench state ${join(this.path, "state.json")}: ${problem}. It is removed on the next save.`;
            this.problems.set(problem, message);
            console.warn(message);
        }
        return repairSessionIds(data);
    }
    update(change) {
        const run = this.queue.then(() => this.write(change));
        this.queue = run.catch(() => {});
        return run;
    }
    async write(change) {
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
        // After a long stall another writer may have taken this lock as stale; then this writer must neither replace
        // state.json nor remove that writer's lock. The open handle pins this lock's inode, so the path still naming
        // that inode proves ownership even if writing the token failed; the token identifies the owner to a reader.
        const token = randomUUID();
        const mine = async () => {
            try {
                const [own, current] = await Promise.all([lock.stat(), stat(lockPath)]);
                return own.ino === current.ino && own.dev === current.dev;
            } catch { return false; }
        };
        // Touches this writer's own lock file (the handle, not the path), so a slow but live owner never looks stale.
        const heartbeat = setInterval(() => { const now = new Date(); void lock.utimes(now, now).catch(() => {}); }, this.heartbeatMs);
        heartbeat.unref();
        try {
            await lock.writeFile(`${process.pid} ${Date.now()} ${token}`);
            const data = await this.read();
            const result = await change(data);
            compact(data);
            const file = await open(temp, "wx", 0o600);
            try { await file.writeFile(JSON.stringify(data)); await file.sync(); }
            finally { await file.close(); }
            if (!await mine()) throw new Error(`The state lock was taken over by another writer after a long pause; this change was not saved. Try again. (${lockPath})`);
            await rename(temp, join(this.path, "state.json"));
            return result;
        } finally {
            clearInterval(heartbeat);
            const owned = await mine();
            await lock.close();
            if (owned) {
                try { await unlink(lockPath); }
                catch (error) { if (error.code !== "ENOENT") throw error; }
            }
            try { await unlink(temp); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    }
}

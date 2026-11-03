import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_SCOPES = 8;
// An entry without a valid time sorts last, so it can never push a dated working set out of order.
const fetched = entry => { const at = Date.parse(entry?.fetchedAt); return Number.isFinite(at) ? at : -Infinity; };
const empty = () => ({ version: 1, catalog: null, projectLists: {}, lastScope: null, issues: {} });

// Disposable warm-start snapshot shared by every session's panel. It never gates a launch:
// anything read from here is shown as cached until this process re-verifies it.
export class Cache {
    constructor(path) { this.path = path; this.file = join(path, "cache.json"); this.queue = Promise.resolve(); }
    async read() { return (await this.load()).data; }
    async load() {
        let text = null;
        try {
            text = await readFile(this.file, "utf8");
            const data = JSON.parse(text);
            if (data?.version !== 1 || typeof data !== "object") return { data: empty(), text };
            return { data: { ...empty(), ...data }, text };
        } catch { return { data: empty(), text }; }
    }
    update(change) {
        const run = this.queue.then(async () => {
            const { data, text: before } = await this.load();
            change(data);
            const scopes = Object.entries(data.issues).sort(([, a], [, b]) => (fetched(b) - fetched(a)) || 0);
            data.issues = Object.fromEntries(scopes.slice(0, MAX_SCOPES));
            const text = JSON.stringify(data);
            if (text === before) return;
            await mkdir(this.path, { recursive: true, mode: 0o700 });
            const temp = join(this.path, `cache-${randomUUID()}.tmp`);
            try {
                const file = await open(temp, "wx", 0o600);
                try { await file.writeFile(text); }
                finally { await file.close(); }
                await rename(temp, this.file);
            } finally {
                try { await unlink(temp); }
                catch (error) { if (error.code !== "ENOENT") throw error; }
            }
        });
        this.queue = run.catch(() => {});
        return run;
    }
}

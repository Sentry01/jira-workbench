import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_SCOPES = 8;
const empty = () => ({ version: 1, catalog: null, projectLists: {}, lastScope: null, issues: {} });

// Disposable warm-start snapshot shared by every session's panel. It never gates a launch:
// anything read from here is shown as cached until this process re-verifies it.
export class Cache {
    constructor(path) { this.path = path; this.file = join(path, "cache.json"); this.queue = Promise.resolve(); }
    async read() {
        try {
            const data = JSON.parse(await readFile(this.file, "utf8"));
            if (data?.version !== 1 || typeof data !== "object") return empty();
            return { ...empty(), ...data };
        } catch { return empty(); }
    }
    update(change) {
        const run = this.queue.then(async () => {
            const data = await this.read();
            change(data);
            const scopes = Object.entries(data.issues).sort(([, a], [, b]) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
            data.issues = Object.fromEntries(scopes.slice(0, MAX_SCOPES));
            await mkdir(this.path, { recursive: true, mode: 0o700 });
            const temp = join(this.path, `cache-${randomUUID()}.tmp`);
            try {
                const file = await open(temp, "wx", 0o600);
                try { await file.writeFile(JSON.stringify(data)); }
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

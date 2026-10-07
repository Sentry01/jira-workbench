import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildLabel, version } from "./version.mjs";

const files = [
    ["/", "../ui/index.html", "text/html; charset=utf-8"],
    ["/app.mjs", "../ui/app.mjs", "text/javascript; charset=utf-8"],
    ["/model.mjs", "./model.mjs", "text/javascript; charset=utf-8"],
    ["/view-model.mjs", "./view-model.mjs", "text/javascript; charset=utf-8"],
    ["/validate.mjs", "./validate.mjs", "text/javascript; charset=utf-8"],
    ["/style.css", "../ui/style.css", "text/css; charset=utf-8"],
];
// The UI is read once, with the server code, so a long-lived process never pairs a newer UI from disk
// with the older API it loaded at startup; a git pull only takes effect after an extension reload.
export const loadAssets = (read = file => readFile(new URL(file, import.meta.url))) =>
    Promise.all(files.map(async ([path, file, type]) => [path, [await read(file), type]])).then(entries => new Map(entries));
const pinned = loadAssets();
pinned.catch(() => {});

// Body caps are derived from the validators behind each route, so a request they accept is never refused as too large.
// JSON.stringify writes one UTF-16 code unit as at most 6 bytes: "\u0001" for a control character or lone surrogate,
// and at most 3 for any other text.
const JSON_BYTES_PER_CHAR = 6;
// Keys, Jira and session IDs, the mode and warning acknowledgements around the validated text.
const ENVELOPE_BYTES = 4_096;
// createBrief (via /api/prepare) is the largest validated text: objective 2,000 + acceptance criteria 10,000
// + constraints 4,000 characters = 16,000 * 6 + 4,096 = 100,096 bytes.
const BODY_LIMIT = (2_000 + 10_000 + 4_000) * JSON_BYTES_PER_CHAR + ENVELOPE_BYTES;
// savePreferences: 10,000 collapsed IDs of up to 100 characters, each with 3 bytes of quotes and comma,
// plus a 500-character query and a 100-character selection = 6,030,000 + 3,600 + 4,096 = 6,037,696 bytes.
const BODY_LIMITS = {
    "/api/preferences": 10_000 * (100 * JSON_BYTES_PER_CHAR + 3) + (500 + 100) * JSON_BYTES_PER_CHAR + ENVELOPE_BYTES,
};

export async function startServer(workbench, { assets = pinned, updater = null } = {}) {
    const token = randomBytes(32).toString("hex");
    let origin;
    const reply = (res, status, value) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(value));
    };
    const routes = {
        "/api/catalog": () => workbench.catalog({ fresh: true }),
        "/api/projects": input => workbench.projects(input.cloudId),
        "/api/select": input => workbench.select(input),
        "/api/map": input => workbench.map(input),
        "/api/refresh": () => workbench.refresh({ fresh: true }),
        "/api/sign-in": () => workbench.signIn(),
        "/api/refresh-execution": input => workbench.refreshExecution(input),
        "/api/trace": input => workbench.refreshTrace(input.nodeId),
        "/api/preferences": input => workbench.savePreferences(input),
        "/api/prepare": input => workbench.prepare(input),
        "/api/launch": input => workbench.launch(input),
        "/api/sync-jira": () => workbench.syncJira(),
        "/api/link": input => workbench.linkSession(input),
        "/api/open": input => workbench.openSession(input),
        "/api/open-pr": input => workbench.openPr(input),
        "/api/clear-request": input => workbench.clearRequest(input),
        "/api/update": () => {
            if (!updater) throw new Error("Updates are not available in this host.");
            return updater.apply();
        },
    };
    // Each panel polls this about once a minute; the updater compares the loaded build with the files on disk.
    const build = async () => updater ? updater.local() : { label: buildLabel((await version()).identity), state: "unknown", action: null, message: null };
    const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
        void (async () => {
            if (`http://${req.headers.host}` !== origin) { reply(res, 403, { error: "Invalid host." }); return; }
            const path = new URL(req.url, origin).pathname;
            const served = req.method === "GET" ? (await assets).get(path) : null;
            if (served) {
                res.writeHead(200, { "Content-Type": served[1] });
                res.end(served[0]);
                return;
            }
            const provided = Buffer.from(String(req.headers["x-workbench-token"] || ""));
            if (provided.length !== token.length || !timingSafeEqual(provided, Buffer.from(token))
                || (req.headers.origin && req.headers.origin !== origin)) {
                reply(res, 403, { error: "This request is not from the open Workbench panel." }); return;
            }
            if (req.method === "GET" && path === "/api/state") { reply(res, 200, await workbench.snapshot()); return; }
            if (req.method === "GET" && path === "/api/version") { reply(res, 200, await build()); return; }
            if (req.method !== "POST" || !routes[path]) { reply(res, 404, { error: "Unknown action." }); return; }
            if (!req.headers["content-type"]?.startsWith("application/json")) { reply(res, 415, { error: "JSON required." }); return; }
            const limit = BODY_LIMITS[path] ?? BODY_LIMIT;
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                // Past the cap, keep reading but discard: a client still writing a large body cannot read a 413 sent
                // before its upload ends, and stopping the read would leave both sides waiting.
                if (size <= limit) chunks.push(chunk);
            }
            if (size > limit) { reply(res, 413, { error: "Request is too large." }); return; }
            const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            if (!input || Array.isArray(input) || typeof input !== "object") { reply(res, 400, { error: "An object is required." }); return; }
            reply(res, 200, await routes[path](input));
        })().catch(error => {
            if (!res.headersSent) reply(res, 400, { error: error.message || "Workbench action failed." });
            else res.destroy(error);
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        url: `${origin}/#${token}`,
        close: async () => {
            server.closeIdleConnections();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}

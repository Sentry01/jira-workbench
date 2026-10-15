import { execFile } from "node:child_process";
import { Gateway } from "./gateway.mjs";
import { bounded, isConnector, preferred, serverLabel, signInError } from "./runtime.mjs";

// Session events after which a tool that was missing or failing may work again.
export const RECONNECT_EVENTS = [
    "session.mcp_servers_loaded", "session.mcp_server_status_changed", "session.mcp_server_needs_reconnect",
    "mcp.oauth_completed", "mcp.headers_refresh_completed", "mcp.tools.list_changed",
];
const VERIFY = ["getAccessibleAtlassianResources", {}];

// The one place that decides whether Jira is reachable. One per extension process: every panel shares its
// gateway (one tool snapshot, one ~2s rebuild) and its state, and a single timer drives every check.
//   connecting  the Jira MCP server is starting, or a read failed and the server list must be re-checked
//   ready       a Jira read worked; while a panel is open, a keepalive read every few minutes
//   signin      the Atlassian sign-in expired or the server waits for one; panel reads fail fast
//   down        the server failed, is stopped or disabled, or reads keep failing
export class Connection {
    constructor(session, options = {}) {
        this.session = session;
        this.gateway = options.gateway || new Gateway(session, options.gatewayOptions);
        this.debounceMs = options.debounceMs ?? 500;
        // A cheap Jira read every few minutes makes the runtime refresh an expiring OAuth token in the background.
        this.keepaliveMs = options.keepaliveMs ?? 4 * 60_000;
        // Only a server that *failed* is restarted, a bounded number of times; stopped, disabled or
        // needs-auth servers reflect a user decision or need the user, so they are left alone.
        this.restartDelaysMs = options.restartDelaysMs ?? [2_000, 15_000, 60_000];
        // Observed live: the runtime delivers MCP events to extensions late and in batches (10s+), so while Jira is
        // not ready the server list is polled; mcp.list costs ~4ms and no Jira call. Every watchMs for watchForMs
        // after the last change, then backing off between backoffMs[0] and backoffMs[1].
        this.watchMs = options.watchMs ?? 1_000;
        this.watchForMs = options.watchForMs ?? 30_000;
        this.backoffMs = options.backoffMs ?? [2_000, 60_000];
        // Atlassian v2 answers the passive probe with HTTP 400 whether or not the token works, and each Jira read
        // made with a dead token makes the runtime broadcast an OAuth request. While signed out, such a read is
        // made at most once per step, doubling between signInReadMs[0] and signInReadMs[1].
        this.signInReadMs = options.signInReadMs ?? [5_000, 5 * 60_000];
        // How long a check waits for the tool list, the only thing that identifies the app's Atlassian connector.
        this.learnMs = options.learnMs ?? 1_500;
        this.openUrl = options.openUrl ?? openInBrowser;
        this.panels = new Map();
        this.listeners = new Set();
        this.restarts = new Map();
        this.listed = new Map();
        this.unsubscribe = [];
        this.due = new Set();
        this.current = { state: "connecting", reason: null, server: null, since: Date.now() };
        this.changedAt = Date.now();
        this.slow = 0;
        this.resetVerify();
    }
    start() {
        if (typeof this.session.on === "function")
            for (const type of RECONNECT_EVENTS) this.unsubscribe.push(this.session.on(type, () => this.onEvent(type)));
        return this;
    }
    stop() {
        this.stopped = true;
        for (const off of this.unsubscribe.splice(0)) if (typeof off === "function") off();
        for (const [workbench, off] of this.panels) { off(); if (workbench.connection === this) workbench.connection = null; }
        this.panels.clear();
        this.listeners.clear();
        this.due.clear();
        this.restartAt = null;
        this.schedule();
    }
    status() {
        return { ...this.current, connector: Boolean(this.current.server) && isConnector(this.server(this.current.server)),
            nextCheckAt: this.nextAt ? new Date(this.nextAt).toISOString() : null, restarts: Object.fromEntries(this.restarts) };
    }
    // The last listed state of a server, or just its name.
    server(name) { return this.listed.get(name) || { name }; }
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    attach(workbench) {
        if (this.stopped || this.panels.has(workbench)) return;
        workbench.connection = this;
        this.panels.set(workbench, this.onChange(change => workbench.connectionChanged(change)));
        workbench.connectionChanged({ status: this.status(), previous: null, event: false });
        this.kick();
    }
    detach(workbench) {
        this.panels.get(workbench)?.();
        if (!this.panels.delete(workbench)) return;
        if (workbench.connection === this) workbench.connection = null;
        // Nobody is looking: no keepalive and no polling until a panel opens again.
        if (!this.panels.size) this.schedule();
    }

    // Every panel Jira read goes through here. While sign-in is required, an ordinary read fails fast without
    // reaching the runtime; an explicit user action (fresh) makes exactly one attempt.
    async read(run, { fresh = false } = {}) {
        const signin = this.current.state === "signin";
        if (signin && !fresh) throw signInError(this.server(this.current.server || "atlassian"));
        try {
            const value = await run(signin ? { fresh: true, retries: 0 } : { fresh });
            this.reached();
            return value;
        } catch (error) {
            if (signin && error?.kind === "auth") this.signInMissed();
            const reported = await this.failed(error);
            if (error?.kind && error.kind !== "permanent") this.kick();
            throw reported;
        }
    }
    // Runs only when the user presses Sign in: the runtime returns an authorization URL and completes the flow in
    // the background; the checks below notice the new token and reload the panels.
    async signIn() {
        const serverName = this.current.server || "atlassian";
        if (isConnector(this.server(serverName)))
            throw new Error(`${serverLabel(this.server(serverName))} signs in through the Copilot app. Reconnect it there; the Workbench reloads on its own.`);
        const login = this.session.rpc.mcp?.oauth?.login;
        if (!login) throw new Error(`This Copilot version cannot start sign-in from a canvas. Run /mcp auth ${serverName} in Copilot.`);
        const options = {
            serverName, clientName: "Jira Workbench (GitHub Copilot)",
            callbackSuccessMessage: "Signed in to Atlassian. Return to the Jira Workbench in Copilot; it reloads on its own.",
        };
        const start = extra => bounded(Promise.resolve().then(() => login({ ...options, ...extra })), this.gateway.timeouts.login, "the Atlassian sign-in")
            .then(result => result?.authorizationUrl);
        // Observed live with Atlassian v2: login first probes with the cached dead token, gets HTTP 400 instead of
        // 401 and throws ("MCP server probe returned HTTP 400"). forceReauth drops that token, so retry with it once.
        let authorizationUrl;
        try { authorizationUrl = await start(); }
        catch { authorizationUrl = await start({ forceReauth: true }); }
        // No URL means the runtime believes its cached token is still valid; the probe knows better, so force it.
        if (!authorizationUrl && await this.probe(serverName) === "expired") authorizationUrl = await start({ forceReauth: true });
        if (!authorizationUrl) { this.kick("signedIn"); return { signedIn: true }; }
        if (!/^https:\/\//.test(authorizationUrl)) throw new Error("Sign-in returned an unexpected authorization URL.");
        let opened = false;
        try { await this.openUrl(authorizationUrl); opened = true; } catch { /* the panel shows the link instead */ }
        // The user is signing in now: check soon (still one read per step) rather than after a long backoff.
        if (this.current.state === "signin") { this.readDelay = this.signInReadMs[0]; this.readAt = Math.min(this.readAt, Date.now() + this.readDelay); }
        return { authorizationUrl, opened };
    }

    // What a failed Jira read means for the connection; returns the error the panel should show.
    async failed(error) {
        if (this.stopped || !error?.kind) return error;
        const server = error.server || this.current.server || "atlassian";
        const state = this.current.state;
        if (error.kind === "auth") {
            // The server itself waits for sign-in: its status says so, no probe needed.
            if (error.needsSignIn) { this.set("signin", { reason: error.message, server }, "status"); return error; }
            // A failed read is never evidence that a sign-in started working again.
            if (state === "signin") return signInError(this.server(this.current.server || server));
            // The gateway's retries did not ride out a silent token refresh; ask the server whether sign-in expired.
            const verdict = await this.probe(server);
            if (verdict === "expired" || (verdict === "unknown" && /re-?authenticat/i.test(error.message))) {
                this.set("signin", { reason: `The ${serverLabel(this.server(server))} sign-in has expired.`, server }, "token");
                return signInError(this.server(server));
            }
            return error;
        }
        if (error.kind === "transient" && state !== "signin") this.set("down", { reason: error.message, server });
        else if ((error.kind === "gone" || error.kind === "unavailable") && state === "ready") this.set("connecting", { reason: error.message, server });
        return error;
    }
    reached() {
        // A working Jira read is the only thing that restores the restart budget, so a server that flaps between
        // connected and failed cannot restart forever.
        this.restarts.clear();
        this.resetVerify();
        // The server that answered, which after a failover is not necessarily the one the check picked.
        const server = this.gateway.answered || this.current.server;
        if (this.current.state !== "ready") this.set("ready", { reason: null, server });
        else this.current.server = server;
    }

    onEvent(type) {
        if (this.stopped) return;
        this.changed();
        this.kick(type === "mcp.oauth_completed" ? "signedIn" : "event");
    }
    // An immediate check, debounced so a burst of triggers costs one: MCP events, a panel attaching or failing, Sign in.
    kick(trigger = "check") {
        if (this.stopped) return;
        this.due.add(trigger);
        this.kickAt ??= Date.now() + this.debounceMs;
        this.schedule();
    }
    // The single timer: the next debounced check, keepalive, poll or restart, whichever is due first.
    schedule() {
        clearTimeout(this.timer);
        this.timer = null;
        this.nextAt = null;
        if (this.stopped || !this.panels.size) return;
        // A check is running now; it schedules the next one when it ends.
        if (this.ticking) { this.nextAt = Date.now(); return; }
        const ready = this.current.state === "ready";
        const times = [
            this.due.size ? this.kickAt : null,
            ready ? (this.keepaliveMs ? this.keepaliveAt : null) : this.checkAt,
            this.restartAt?.at,
        ].filter(Number.isFinite);
        if (!times.length) return;
        this.nextAt = Math.min(...times);
        this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, Math.max(0, this.nextAt - Date.now()));
        this.timer.unref?.();
    }
    async tick() {
        if (this.stopped || this.ticking) return;
        this.ticking = true;
        const due = new Set(this.due);
        this.due.clear();
        this.kickAt = null;
        const event = due.has("event") || due.has("signedIn");
        try {
            if (!this.panels.size) return;
            // The tool snapshot and shared reads may predate the event.
            if (event) this.gateway.invalidate();
            await this.check(due);
        } catch { /* every step is bounded; the next check tries again */ }
        finally {
            this.ticking = false;
            this.checkAt = Date.now() + this.cadence();
            // An MCP event is news to a panel whose last startup did not complete, whatever the state now.
            if (event && !this.stopped) this.emit(this.current, true);
            this.schedule();
        }
    }
    async check(due) {
        const state = this.current.state;
        if (state === "ready" && !due.size) {
            if (Date.now() >= this.keepaliveAt) await this.keepalive();
            return;
        }
        const jira = await this.jira();
        if (jira === undefined) return;
        const signature = jira ? `${jira.name}:${jira.status}` : "";
        if (signature !== this.seen) { this.seen = signature; this.resetVerify(); }
        if (due.has("event") || due.has("signedIn")) this.resetVerify();
        if (jira?.status !== "failed") this.restartAt = null;
        if (!jira) return this.set("down", { reason: "No Atlassian connection is set up. Connect the Atlassian Rovo connector in the Copilot app or add an Atlassian MCP server; the Workbench connects on its own.", server: null });
        const { name, status } = jira, label = serverLabel(jira);
        if (status === "connected") {
            if (state === "ready") return;
            if (state === "signin") return this.checkSignIn(name, due);
            return this.verify(name);
        }
        if (status === "needs-auth") return this.set("signin", { reason: `MCP server ${label} needs sign-in.`, server: name }, "status");
        if (status === "failed") {
            this.set("down", { reason: `MCP server ${label} failed to connect${jira.error ? ` (${jira.error})` : ""}.`, server: name });
            return this.restart(name);
        }
        if (status === "stopped" || status === "disabled") return this.set("down", { reason: `MCP server ${label} is ${status}.`, server: name });
        return this.set("connecting", { reason: `MCP server ${label} is still connecting.`, server: name });
    }
    // The Jira MCP server's status. null: none configured; undefined: the server list did not answer.
    // Hosts without mcp.list leave a read as the only check.
    async jira() {
        if (!this.session.rpc.mcp?.list) return { name: this.current.server || "atlassian", status: "connected" };
        const servers = await this.gateway.servers();
        if (!servers) return undefined;
        for (const server of servers) this.listed.set(server.name, server);
        if (!this.gateway.jiraServers(servers).some(s => s.status === "connected")) await this.learn();
        return preferred(this.gateway.jiraServers(servers));
    }
    // Only the tool list identifies the app's Atlassian connector (its name is opaque). That list can stall for
    // minutes while a server waits for sign-in, so a check waits only briefly; a late answer naming a new Jira
    // server triggers another check.
    async learn() {
        const known = this.gateway.jiraKnown.size;
        let waiting = true, timer;
        const listed = this.gateway.metadata().catch(() => {}).then(() => {
            if (!waiting && !this.stopped && this.gateway.jiraKnown.size > known) this.kick();
        });
        await Promise.race([listed, new Promise(resolve => { timer = setTimeout(resolve, this.learnMs); timer.unref?.(); })]);
        waiting = false;
        clearTimeout(timer);
    }
    // A connected server is confirmed with one real read; one that just changed at once, otherwise with backoff.
    async verify(server) {
        if (Date.now() < this.verifyAt) return;
        try { await this.gateway.call(...VERIFY, { fresh: true }); this.reached(); }
        catch (error) {
            this.verifyAt = Date.now() + this.verifyDelay;
            this.verifyDelay = Math.min(this.verifyDelay * 2, this.backoffMs[1]);
            const reported = await this.failed(Object.assign(error, { server: error.server || server }));
            if (this.current.state !== "signin") this.current = { ...this.current, reason: reported.message };
        }
    }
    async checkSignIn(server, due) {
        // Sign-in finished (oauth_completed), or a server that asked for sign-in is connected again: verify at once.
        if (due.has("signedIn") || this.via === "status") return this.verifySignIn();
        // An expired token stays "connected"; only the passive probe can tell, and only a 401 is a clear answer.
        const verdict = await this.probe(server);
        if (verdict === "expired") return;
        if (verdict === "ok" || Date.now() >= this.readAt) return this.verifySignIn();
    }
    async verifySignIn() {
        try { await this.gateway.call(...VERIFY, { fresh: true, retries: 0 }); this.reached(); }
        catch (error) {
            this.via = "token";
            this.signInMissed();
            if (error.kind !== "auth") await this.failed(error);
        }
    }
    signInMissed() {
        this.readDelay = Math.min(this.readDelay * 2, this.signInReadMs[1]);
        this.readAt = Date.now() + this.readDelay;
    }
    async keepalive() {
        this.keepaliveAt = Date.now() + this.keepaliveMs;
        try { await this.gateway.call(...VERIFY, { fresh: true }); this.reached(); }
        catch (error) { await this.failed(error); }
    }
    restart(name) {
        if (!this.session.rpc.mcp?.restartServer) return;
        const attempt = this.restarts.get(name) || 0;
        if (attempt >= this.restartDelaysMs.length) return;
        if (!this.restartAt) { this.restartAt = { name, at: Date.now() + this.restartDelaysMs[attempt] }; return; }
        if (Date.now() < this.restartAt.at) return;
        this.restartAt = null;
        this.restarts.set(name, attempt + 1);
        this.changed();
        // The next check sees how it went; a restart is never verified in the same check, because a server that
        // flaps can look connected for a moment.
        return bounded(Promise.resolve().then(() => this.session.rpc.mcp.restartServer({ serverName: name })),
            this.gateway.timeouts.restart, "the MCP server restart").catch(() => {});
    }
    // Passive: mcp.oauth.probe never starts OAuth or emits a sign-in request. Observed live: an expired Atlassian
    // v1 sign-in answers HTTP 401 while mcp.list still says "connected"; a working one answers 400, and v2 answers
    // 400 for a dead token too. Only 401 and needs-auth mean "expired"; anything else is "unknown".
    async probe(server) {
        const probe = this.session.rpc.mcp?.oauth?.probe;
        if (!probe) return "unknown";
        try {
            const result = await bounded(Promise.resolve().then(() => probe({ serverName: server })), this.gateway.timeouts.probe, "the Atlassian sign-in check");
            if (result?.status === "authenticated" || result?.status === "no-auth-required") return "ok";
            if (result?.status === "needs-auth" || result?.httpResponse?.status === 401 || /\b401\b|unauthori[sz]ed/i.test(result?.error || "")) return "expired";
            return "unknown";
        } catch { return "unknown"; }
    }

    set(state, { reason = null, server = this.current.server } = {}, via) {
        const previous = this.current;
        if (state === "signin") {
            if (previous.state !== "signin") { this.readDelay = this.signInReadMs[0]; this.readAt = Date.now() + this.readDelay; }
            this.via = via || this.via;
        }
        if (state === "ready") this.keepaliveAt = Date.now() + this.keepaliveMs;
        this.current = { state, reason, server, since: previous.state === state ? previous.since : Date.now() };
        if (previous.state === state) return;
        this.changed();
        this.resetVerify();
        this.emit(previous, false);
        this.schedule();
    }
    changed() { this.changedAt = Date.now(); this.slow = 0; this.checkAt = Date.now() + this.watchMs; }
    resetVerify() { this.verifyAt = 0; this.verifyDelay = this.backoffMs[0]; }
    cadence() {
        if (Date.now() - this.changedAt < this.watchForMs) return this.watchMs;
        return Math.min(this.backoffMs[0] * 2 ** this.slow++, this.backoffMs[1]);
    }
    emit(previous, event) {
        const change = { status: this.status(), previous: { ...previous }, event };
        for (const listener of [...this.listeners]) {
            try { listener(change); } catch { /* one panel must not stop the others */ }
        }
    }
}

function openInBrowser(url) {
    const [command, args] = process.platform === "darwin" ? ["open", [url]]
        : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    return new Promise((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
}

// Helpers for talking to the Copilot runtime and its MCP servers.
export const JIRA_SERVER = /atlassian|jira/i;
// Atlassian's site lookup: a server that offers it serves Jira, whatever it is called.
export const SITE_TOOL = "getAccessibleAtlassianResources";
const RANK = ["connected", "pending", "needs-auth", "failed", "stopped", "disabled"];

// Observed live (Copilot 1.0.90): mcp.list shows the Copilot app's Atlassian Rovo connector as cc-_<id>, with no
// displayName or source. The app owns its sign-in, so /mcp auth and mcp.oauth.login do not apply to it.
export const isConnector = server => server?.source === "managed" || /^cc-_/.test(server?.name || "");
export const serverLabel = server => server?.displayName || (isConnector(server) ? "Atlassian connector" : server?.name);

// The most usable of several Jira servers. Between equals, the app's connector: Atlassian's official way into Copilot.
export function preferred(servers) {
    const rank = server => { const i = RANK.indexOf(server.status); return i < 0 ? RANK.length : i; };
    return [...servers].sort((a, b) => rank(a) - rank(b) || isConnector(b) - isConnector(a))[0] || null;
}

export function toolError(message, retryable) {
    return Object.assign(new Error(message), { retryable });
}

// Every gateway error says what kind of failure it is, so the connection supervisor can react to it:
// auth (sign-in), gone (an offered tool vanished), transient (worth retrying), unavailable (not offered), permanent.
// An error that already carries a kind keeps it.
export function classify(error, kind, server = null) {
    const target = error instanceof Error ? error : new Error(String(error));
    if (!target.kind) Object.assign(target, { kind, server: target.server ?? server, retryable: target.retryable ?? kind === "transient" });
    return target;
}

// server: the listed server (so a connector known only by source: "managed" is recognized), or just its name.
export function signInError(server = "atlassian") {
    const target = typeof server === "string" ? { name: server } : server;
    const action = isConnector(target)
        ? "Reconnect the Atlassian connector in the Copilot app"
        : `Press Sign in to Atlassian (or run /mcp auth ${target.name} in Copilot)`;
    return Object.assign(new Error(`Your ${serverLabel(target)} sign-in has expired. ${action}; the Workbench reloads on its own once you are signed in.`),
        { kind: "auth", retryable: false, needsSignIn: true, server: target.name });
}

export function bounded(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(toolError(`Copilot did not answer ${what} within ${Math.round(ms / 1000)}s. Retrying automatically.`, true)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runtime tool names may carry a server or namespace prefix, e.g. atlassian-getJiraIssue or github.navigate_to.
export function matchesTool(toolName, name) {
    return typeof toolName === "string" && (toolName === name
        || [".", "-", "__", ":"].some(separator => toolName.endsWith(`${separator}${name}`)));
}

// Every object nested in a tool result, whatever shape the runtime wrapped it in.
export function objects(value) {
    if (Array.isArray(value)) return value.flatMap(objects);
    if (!value || typeof value !== "object") return [];
    return [value, ...Object.values(value).filter(v => v && typeof v === "object").flatMap(objects)];
}

export const settle = promise => promise.then(value => ({ value }), error => ({ error }));

import { randomUUID } from "node:crypto";
import { bounded, matchesTool } from "./runtime.mjs";
import { assertRepo, assertSessionId } from "./validate.mjs";

const COMPLETED_RECEIPT_LIMIT = 100;
// Observed live (see gateway.mjs): getCurrentMetadata can stop answering for minutes. An unanswered navigation
// would stay pending and keep its target locked, so both calls are bounded and a timeout fails the receipt.
const TIMEOUTS_MS = { metadata: 8_000, execute: 30_000 };

// bounded() words its timeout for calls that retry on their own; navigation is retried only by the user.
async function answered(promise, ms) {
    let settled = false;
    const call = Promise.resolve(promise).finally(() => { settled = true; });
    try {
        return await bounded(call, ms, "the navigation request");
    } catch (error) {
        if (settled) throw error;
        throw new Error(`Copilot did not answer the navigation request within ${Math.round(ms / 1000)}s. Try again.`);
    }
}

function validToolName(value) {
    return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function isMcpTool(tool) {
    return tool !== null && typeof tool === "object" && ("mcpServerName" in tool || "mcpToolName" in tool);
}

function copyReceipt(receipt) {
    return { ...receipt, target: { ...receipt.target } };
}

function errorMessage(error) {
    const text = typeof error === "string" ? error : error?.message;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 2000) : "Unknown host navigation error.";
}

function navigationResult(result, name, args) {
    const text = typeof result === "string" ? result : result?.textResultForLlm;
    if (typeof result !== "string" && result?.resultType !== "success") {
        throw new Error(`Host navigation ${result?.resultType || "failed"}: ${errorMessage(result?.error || text)}`);
    }
    if (result?.error) throw new Error(errorMessage(result.error));
    const targetMessage = name === "navigate_to_github_item" ? `Opening ${args.repo_full_name}#${args.number}.` : "Navigating now.";
    if (typeof text !== "string" || !["Navigating now.", targetMessage].includes(text.trim())) {
        throw new Error(`Host did not confirm navigation: ${errorMessage(text)}`);
    }
    return text.trim();
}

// Requests are shared only when they navigate to the same place: a PR opened through its owning session
// and the same PR opened in the native view are different destinations.
function targetKey(target, name, args) {
    const base = target.kind === "session" ? `session:${target.sessionId}` : `pr:${target.repo.toLowerCase()}:${target.number}`;
    // GitHub repository names are case-insensitive, so the destination is too.
    return `${base}|${name}|${JSON.stringify(args).toLowerCase()}`;
}

function navigationPrompt(instanceId, requestId, name, args) {
    const callback = (ok, message) => JSON.stringify({
        instanceId, actionName: "record_navigation", input: { requestId, ok, message },
    });
    return [
        "The user selected navigation in Jira Workbench. This is a navigation-only user action.",
        "Use only the native Copilot App host tool, never an MCP tool with a matching name.",
        `Call ${name} with exactly ${JSON.stringify(args)}.`,
        "Do not create a new session (including create_session); do not write to Jira.",
        "Do not substitute another target or bypass a denial.",
        "Only after the host confirms navigation succeeded, call invoke_canvas_action with exactly:",
        callback(true, "Navigating now."),
        "If navigation fails, is denied, is unavailable, or is not confirmed, call invoke_canvas_action with:",
        callback(false, "Navigation failed."),
        "Replace the failure message with the actual error (non-empty text, at most 2000 characters).",
        "Do not report success merely because this request was queued.",
    ].join("\n");
}

/** Callers must verify selected-trace membership before requesting navigation. */
export class HostActions {
    #session;
    #instanceId;
    #timeouts;
    #requests = new Map();
    #active = new Map();
    #completed = [];

    constructor({ session, instanceId, timeouts = {} } = {}) {
        if (typeof session?.rpc?.tools?.getCurrentMetadata !== "function"
            || typeof session?.rpc?.tools?.execute !== "function" || typeof session?.send !== "function") {
            throw new Error("A session with host tool metadata, execution and send APIs is required.");
        }
        if (typeof instanceId !== "string" || !instanceId.trim()) throw new Error("A canvas instance ID is required.");
        this.#session = session;
        this.#instanceId = instanceId;
        this.#timeouts = { ...TIMEOUTS_MS, ...timeouts };
    }

    async openSession(sessionId) {
        assertSessionId(sessionId);
        return this.#open({ kind: "session", sessionId }, "navigate_to", { id: sessionId });
    }

    // When the session that created the PR is known, open that session: it is in the PR's own repository,
    // so the app shows its built-in PR tab there. Otherwise open the app's native PR view.
    async openPr(repo, number, { sessionId } = {}) {
        assertRepo(repo);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error("A positive safe-integer PR number is required.");
        if (sessionId !== undefined) {
            assertSessionId(sessionId);
            return this.#open({ kind: "pr", repo, number }, "navigate_to", { id: sessionId });
        }
        return this.#open({ kind: "pr", repo, number }, "navigate_to_github_item", {
            kind: "pull_request", repo_full_name: repo, number,
        });
    }

    acknowledge(input) {
        if (!input || typeof input.requestId !== "string") throw new Error("A navigation receipt request ID is required.");
        const request = this.#requests.get(input.requestId);
        if (!request) throw new Error("Unknown navigation request.");
        if (typeof input.ok !== "boolean") throw new Error("Navigation receipt ok must be a boolean.");
        if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) {
            throw new Error("A non-empty navigation receipt message of at most 2000 characters is required.");
        }
        const message = input.message.trim();
        if (request.acknowledgement) {
            if (request.acknowledgement.ok !== input.ok || request.acknowledgement.message !== message) {
                throw new Error("Conflicting navigation receipt.");
            }
        } else {
            if (!request.awaitingReceipt || request.receipt.status !== "queued") {
                throw new Error("This request is not awaiting a queued navigation receipt.");
            }
            request.acknowledgement = { ok: input.ok, message };
            request.awaitingReceipt = false;
            request.receipt.status = input.ok ? "acknowledged" : "failed";
            request.receipt.message = message;
            this.#release(request);
        }
        return copyReceipt(request.receipt);
    }

    /** Returns all queued/in-flight receipts plus the 100 most recently completed. */
    snapshot() {
        return [...this.#requests.values()].map(request => copyReceipt(request.receipt));
    }

    async #open(target, name, args) {
        const key = targetKey(target, name, args);
        let request = this.#active.get(key);
        if (!request) {
            const receipt = { requestId: randomUUID(), target, status: "queued", message: "Navigation pending; not yet acknowledged." };
            request = { key, receipt, inFlight: true, awaitingReceipt: false, acknowledgement: null };
            this.#requests.set(receipt.requestId, request);
            this.#active.set(key, request);
            // Reserve the target before invoking any external session method.
            request.promise = Promise.resolve().then(() => this.#navigate(request, name, args));
        }
        return copyReceipt(await request.promise);
    }

    async #navigate(request, name, args) {
        const { receipt } = request;
        let queuedReceipt;
        try {
            const metadata = await answered(this.#session.rpc.tools.getCurrentMetadata(), this.#timeouts.metadata);
            if (!metadata || (metadata.tools !== null && !Array.isArray(metadata.tools))) {
                throw new Error("Unsupported host tool metadata.");
            }
            const tools = (metadata.tools ?? []).filter(tool => !isMcpTool(tool));
            if (tools.some(tool => !validToolName(tool?.name))) {
                throw new Error("Invalid host tool metadata.");
            }
            const matches = tools.filter(tool => matchesTool(tool.name, name));
            if (matches.length > 1) throw new Error(`${name} is ambiguous in host tool metadata.`);
            if (matches.length === 1) {
                const result = await answered(this.#session.rpc.tools.execute({ name: matches[0].name, arguments: args }), this.#timeouts.execute);
                receipt.message = navigationResult(result, name, args);
                receipt.status = "acknowledged";
            } else {
                receipt.message = "Navigation queued; awaiting a host navigation receipt.";
                request.awaitingReceipt = true;
                queuedReceipt = copyReceipt(receipt);
                await this.#session.send({ prompt: navigationPrompt(this.#instanceId, receipt.requestId, name, args) });
            }
        } catch (error) {
            request.awaitingReceipt = false;
            if (request.acknowledgement) {
                // A callback can arrive before send settles; retain its known outcome.
                receipt.message = `Agent dispatch error after navigation receipt: ${errorMessage(error)} Receipt: ${request.acknowledgement.message}`.slice(0, 2000);
                queuedReceipt.message = receipt.message;
            } else {
                queuedReceipt = undefined;
                receipt.status = "failed";
                receipt.message = errorMessage(error);
            }
        } finally {
            request.inFlight = false;
            this.#release(request);
        }
        return queuedReceipt || receipt;
    }

    #release(request) {
        if (!request.inFlight && request.receipt.status !== "queued" && this.#active.get(request.key) === request) {
            this.#active.delete(request.key);
            this.#completed.push(request.receipt.requestId);
            if (this.#completed.length > COMPLETED_RECEIPT_LIMIT) {
                this.#requests.delete(this.#completed.shift());
            }
        }
    }
}

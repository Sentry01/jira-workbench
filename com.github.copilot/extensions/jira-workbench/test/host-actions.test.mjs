import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HostActions } from "../lib/host-actions.mjs";

const sessionId = randomUUID();
const repo = "example/demo";
const success = { resultType: "success", textResultForLlm: "Navigating now." };

function fixture(options = {}) {
    const calls = { metadata: 0, executed: [], sent: [] };
    const instanceId = randomUUID();
    const session = {
        rpc: {
            tools: {
                async getCurrentMetadata() {
                    calls.metadata++;
                    return options.metadata ? options.metadata() : {
                        tools: options.tools ?? [{ name: "navigate_to" }, { name: "navigate_to_github_item" }],
                    };
                },
                async execute(input) {
                    calls.executed.push(input);
                    return options.execute ? options.execute(input) : success;
                },
            },
        },
        async send(input) {
            calls.sent.push(input);
            return options.send ? options.send(input) : randomUUID();
        },
    };
    return { actions: new HostActions({ session, instanceId, timeouts: options.timeouts }), session, instanceId, calls };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test("direct session navigation uses the exact host arguments and a canonical string result", async () => {
    const { actions, calls } = fixture({ execute: async () => "Navigating now." });
    const receipt = await actions.openSession(sessionId);
    assert.deepEqual(calls.executed, [{ name: "navigate_to", arguments: { id: sessionId } }]);
    assert.deepEqual(calls.sent, []);
    assert.deepEqual(receipt, {
        requestId: receipt.requestId,
        target: { kind: "session", sessionId },
        status: "acknowledged",
        message: "Navigating now.",
    });
    assert.match(receipt.requestId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(actions.snapshot(), [receipt]);
});

test("direct PR navigation uses the native PR view, never a new session", async () => {
    const { actions, calls } = fixture();
    const receipt = await actions.openPr(repo, 17);
    assert.deepEqual(calls.executed, [{
        name: "navigate_to_github_item",
        arguments: { kind: "pull_request", repo_full_name: repo, number: 17 },
    }]);
    assert.deepEqual(receipt.target, { kind: "pr", repo, number: 17 });
    assert.equal(receipt.status, "acknowledged");
    assert.deepEqual(calls.sent, []);
});

test("bare and namespaced native tools execute their model-facing name", async t => {
    for (const tool of [
        { name: "navigate_to" },
        { name: "functions.navigate_to" },
        { name: "app-navigate_to" },
        { name: "functions__navigate_to" },
        { name: "app:navigate_to" },
    ]) {
        await t.test(tool.name, async () => {
            const { actions, calls } = fixture({ tools: [tool] });
            assert.equal((await actions.openSession(sessionId)).status, "acknowledged");
            assert.equal(calls.executed[0].name, tool.name);
            assert.equal(calls.sent.length, 0);
        });
    }
});

test("MCP descriptors cannot supply or obscure native app navigation capabilities", async t => {
    for (const name of ["navigate_to", "navigate_to_github_item"]) {
        const args = name === "navigate_to" ? { id: sessionId } : { kind: "pull_request", repo_full_name: repo, number: 17 };
        const descriptors = [
            { name: "remote-tool", mcpToolName: name },
            { name: `mcp__remote__${name}`, mcpServerName: "remote" },
            { name: `remote-${name}`, mcpServerName: "remote", mcpToolName: name },
            { name, mcpToolName: name },
            { name: `remote.${name}`, mcpServerName: "remote" },
            { name, mcpServerName: undefined },
            { name, mcpToolName: null },
        ];
        for (const [index, descriptor] of descriptors.entries()) {
            for (const nativePresent of [true, false]) {
                await t.test(`${name}, MCP descriptor ${index}, native present: ${nativePresent}`, async () => {
                    const native = { name: `functions.${name}` };
                    const { actions, calls } = fixture({ tools: [descriptor, ...(nativePresent ? [native] : [])] });
                    const receipt = name === "navigate_to" ? await actions.openSession(sessionId) : await actions.openPr(repo, 17);
                    if (nativePresent) {
                        assert.equal(receipt.status, "acknowledged");
                        assert.deepEqual(calls.executed, [{ name: native.name, arguments: args }]);
                        assert.deepEqual(calls.sent, []);
                    } else {
                        assert.equal(receipt.status, "queued");
                        assert.deepEqual(calls.executed, []);
                        assert.equal(calls.sent.length, 1);
                        const { prompt } = calls.sent[0];
                        assert.ok(prompt.includes(`Call ${name} with exactly ${JSON.stringify(args)}`));
                        assert.match(prompt, /native Copilot App host tool/);
                        assert.match(prompt, /never an MCP tool/);
                        assert.match(prompt, /record_navigation/);
                    }
                });
            }
        }
    }
});

test("ambiguous native capabilities fail without direct execution or agent fallback", async () => {
    const { actions, calls } = fixture({ tools: [
        { name: "navigate_to" }, { name: "app.navigate_to" },
    ] });
    const receipt = await actions.openSession(sessionId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.message, /ambiguous/i);
    assert.deepEqual(calls.executed, []);
    assert.deepEqual(calls.sent, []);
    assert.deepEqual(actions.snapshot(), [receipt]);
});

test("direct execution errors are recorded and never retried through the agent", async () => {
    const { actions, calls } = fixture({ execute: async () => { throw new Error("Host permission denied."); } });
    const receipt = await actions.openSession(sessionId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.message, /permission denied/i);
    assert.equal(calls.executed.length, 1);
    assert.equal(calls.sent.length, 0);
    assert.deepEqual(actions.snapshot(), [receipt]);
});

test("non-success result types override success-shaped navigation text", async t => {
    for (const resultType of ["failure", "rejected", "denied", "timeout"]) {
        await t.test(resultType, async () => {
            const { actions, calls } = fixture({ execute: async () => ({ ...success, resultType }) });
            const receipt = await actions.openPr(repo, 17);
            assert.equal(receipt.status, "failed");
            assert.match(receipt.message, new RegExp(resultType));
            assert.equal(calls.sent.length, 0);
        });
    }
});

test("unsuccessful or unsupported textual results never falsely acknowledge navigation", async t => {
    for (const text of [
        "Session not found.",
        "Navigating now. Session not found.",
        "Error: session does not exist.",
        "Navigation denied.",
        "Could not navigate to the pull request.",
        "Navigation queued.",
        "Success",
        "",
    ]) {
        await t.test(JSON.stringify(text), async () => {
            for (const result of [text, { ...success, textResultForLlm: text }]) {
                const { actions, calls } = fixture({ execute: async () => result });
                assert.equal((await actions.openSession(sessionId)).status, "failed");
                assert.equal(calls.sent.length, 0);
            }
        });
    }
});

test("a canonical result's explicit error overrides its success classification", async () => {
    const { actions, calls } = fixture({ execute: async () => ({ ...success, error: "Target not found." }) });
    const receipt = await actions.openSession(sessionId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.message, /not found/i);
    assert.equal(calls.sent.length, 0);
});

test("malformed native results fail closed without agent fallback", async () => {
    for (const result of [undefined, null, true, {}, { textResultForLlm: "Navigating now." },
        { resultType: "success" }, { ...success, textResultForLlm: 42 }]) {
        const { actions, calls } = fixture({ execute: async () => result });
        const receipt = await actions.openSession(sessionId);
        assert.equal(receipt.status, "failed");
        assert.ok(receipt.message.length > 0);
        assert.equal(calls.sent.length, 0);
    }
});

test("malformed session identifiers are rejected before any external call or receipt", async () => {
    const { actions, calls } = fixture();
    for (const value of [undefined, null, 1, {}, [], "", "-", "a".repeat(101),
        "../session", "session id", "id\n", "id\t", "id;command", "https://example.com/session"]) {
        await assert.rejects(actions.openSession(value), /session ID/i);
    }
    assert.deepEqual(calls, { metadata: 0, executed: [], sent: [] });
    assert.deepEqual(actions.snapshot(), []);
});

test("malformed repositories are rejected before any external call or receipt", async () => {
    const { actions, calls } = fixture();
    for (const value of [undefined, null, 1, {}, [], "", "owner", "/repo", "owner/",
        "a/b/c", "../repo", "owner/..", "owner/repo\n", "owner/repo?token=x",
        "https://github.com/owner/repo", "owner/repo;command"]) {
        await assert.rejects(actions.openPr(value, 17), /repository/i);
    }
    assert.deepEqual(calls, { metadata: 0, executed: [], sent: [] });
    assert.deepEqual(actions.snapshot(), []);
});

test("PR numbers must be positive safe integers, not coerced strings", async () => {
    const { actions, calls } = fixture();
    for (const number of [undefined, null, {}, [], "17", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(actions.openPr(repo, number), /PR number/i);
    }
    assert.deepEqual(calls, { metadata: 0, executed: [], sent: [] });
    assert.deepEqual(actions.snapshot(), []);
});

test("only missing capabilities queue precise navigation and canvas-receipt prompts", async t => {
    for (const kind of ["session", "pr"]) {
        await t.test(kind, async () => {
            const { actions, calls, instanceId } = fixture({ tools: [
                { name: "create_session" },
                { name: kind === "session" ? "navigate_to_github_item" : "navigate_to" },
                { name: kind === "session" ? "notnavigate_to" : "navigate_to_github_item_extra" },
            ] });
            const receipt = kind === "session" ? await actions.openSession(sessionId) : await actions.openPr(repo, 17);
            const name = kind === "session" ? "navigate_to" : "navigate_to_github_item";
            const args = kind === "session" ? { id: sessionId } : { kind: "pull_request", repo_full_name: repo, number: 17 };
            assert.equal(receipt.status, "queued");
            assert.match(receipt.message, /queued/i);
            assert.deepEqual(calls.executed, []);
            assert.equal(calls.sent.length, 1);
            assert.deepEqual(Object.keys(calls.sent[0]), ["prompt"]);
            const { prompt } = calls.sent[0];
            assert.ok(prompt.includes(`Call ${name} with exactly ${JSON.stringify(args)}`));
            assert.match(prompt, /Do not create a new session/);
            assert.match(prompt, /do not write to Jira/);
            assert.match(prompt, /Do not .*bypass a denial/);
            assert.match(prompt, /Only after the host confirms navigation succeeded/);
            assert.match(prompt, /invoke_canvas_action/);
            const callbacks = prompt.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
            assert.deepEqual(callbacks, [
                { instanceId, actionName: "record_navigation", input: { requestId: receipt.requestId, ok: true, message: "Navigating now." } },
                { instanceId, actionName: "record_navigation", input: { requestId: receipt.requestId, ok: false, message: "Navigation failed." } },
            ]);
            assert.match(prompt, /Replace the failure message with the actual error/);
            assert.deepEqual(actions.snapshot(), [receipt]);
        });
    }
});

test("an uninitialized tools snapshot queues navigation without initializing or executing tools", async () => {
    const { actions, calls } = fixture({ metadata: async () => ({ tools: null }) });
    assert.equal((await actions.openSession(sessionId)).status, "queued");
    assert.equal(calls.metadata, 1);
    assert.equal(calls.executed.length, 0);
    assert.equal(calls.sent.length, 1);
});

test("metadata errors or malformed metadata fail closed rather than queueing through the agent", async t => {
    for (const metadata of [
        async () => { throw new Error("Metadata permission denied."); },
        async () => undefined,
        async () => ({}),
        async () => ({ tools: {} }),
        async () => ({ tools: [null] }),
        async () => ({ tools: [{ name: 42 }] }),
        async () => ({ tools: [{ name: "" }] }),
        async () => ({ tools: [{ name: "navigate_to " }] }),
    ]) {
        await t.test(String(metadata), async () => {
            const { actions, calls } = fixture({ metadata });
            const receipt = await actions.openSession(sessionId);
            assert.equal(receipt.status, "failed");
            assert.match(receipt.message, /metadata/i);
            assert.deepEqual(calls.executed, []);
            assert.deepEqual(calls.sent, []);
        });
    }
});

test("duplicate clicks during metadata lookup issue one request and independent receipt copies", async () => {
    const gate = deferred();
    const { actions, calls } = fixture({ metadata: async () => {
        await gate.promise;
        return { tools: [{ name: "navigate_to" }] };
    } });
    const first = actions.openSession(sessionId);
    const second = actions.openSession(sessionId);
    gate.resolve();
    const receipts = await Promise.all([first, second]);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.notEqual(receipts[0], receipts[1]);
    assert.notEqual(receipts[0].target, receipts[1].target);
    assert.equal(calls.metadata, 1);
    assert.equal(calls.executed.length, 1);
    assert.equal(actions.snapshot().length, 1);
});

test("duplicate clicks while direct execution is pending execute once", async () => {
    const entered = deferred(), gate = deferred();
    const { actions, calls } = fixture({ execute: async () => {
        entered.resolve();
        await gate.promise;
        return success;
    } });
    const first = actions.openPr(repo, 17);
    await entered.promise;
    const second = actions.openPr(repo, 17);
    const third = actions.openPr(repo, 17);
    gate.resolve();
    const receipts = await Promise.all([first, second, third]);
    assert.equal(new Set(receipts.map(receipt => receipt.requestId)).size, 1);
    assert.equal(calls.executed.length, 1);
});

test("fallback clicks deduplicate while send is pending and after it has queued", async () => {
    const entered = deferred(), gate = deferred();
    const { actions, calls } = fixture({ tools: [], send: async () => {
        entered.resolve();
        await gate.promise;
    } });
    const first = actions.openSession(sessionId);
    await entered.promise;
    const second = actions.openSession(sessionId);
    gate.resolve();
    const receipts = await Promise.all([first, second]);
    const repeated = await actions.openSession(sessionId);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.deepEqual(repeated, receipts[0]);
    assert.equal(repeated.status, "queued");
    assert.equal(calls.metadata, 1);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.executed.length, 0);
});

test("case variants of a GitHub repository share the same queued target", async () => {
    const { actions, calls } = fixture({ tools: [] });
    const first = await actions.openPr(repo, 17);
    const second = await actions.openPr(repo.toUpperCase(), 17);
    assert.deepEqual(second, first);
    assert.equal(calls.sent.length, 1);
});

test("a blocked session navigation does not block a PR or another session", async () => {
    const entered = deferred(), gate = deferred();
    const { actions, calls } = fixture({ execute: async input => {
        if (input.arguments.id === sessionId) {
            entered.resolve();
            await gate.promise;
        }
        return success;
    } });
    const pending = actions.openSession(sessionId);
    await entered.promise;
    try {
        const pr = await actions.openPr(repo, 17);
        const anotherSession = await actions.openSession(randomUUID());
        assert.equal(pr.status, "acknowledged");
        assert.equal(anotherSession.status, "acknowledged");
        assert.equal(calls.executed.length, 3);
    } finally {
        gate.resolve();
        await pending;
    }
});

test("distinct queued PR targets do not globally block one another", async () => {
    const { actions, calls } = fixture({ tools: [] });
    const receipts = await Promise.all([actions.openPr(repo, 17), actions.openPr(repo, 18), actions.openPr("example/other", 17)]);
    assert.equal(new Set(receipts.map(receipt => receipt.requestId)).size, 3);
    assert.ok(receipts.every(receipt => receipt.status === "queued"));
    assert.equal(calls.sent.length, 3);
});

test("known queued success and failure receipts update polling metadata idempotently", async t => {
    for (const ok of [true, false]) {
        await t.test(String(ok), async () => {
            const { actions, calls } = fixture({ tools: [] });
            const queued = await actions.openSession(sessionId);
            const input = { requestId: queued.requestId, ok, message: ok ? "Navigation confirmed." : "Host denied navigation." };
            const receipt = actions.acknowledge(input);
            assert.deepEqual(receipt, { ...queued, status: ok ? "acknowledged" : "failed", message: input.message });
            assert.deepEqual(actions.acknowledge(input), receipt);
            assert.deepEqual(actions.snapshot(), [receipt]);
            assert.equal(calls.sent.length, 1);
            assert.equal(calls.executed.length, 0);
            assert.throws(() => actions.acknowledge({ ...input, ok: !ok }), /conflict/i);
            assert.throws(() => actions.acknowledge({ ...input, message: "Different outcome." }), /conflict/i);
            assert.deepEqual(actions.snapshot(), [receipt]);
        });
    }
});

test("unknown and malformed acknowledgements cannot modify queued receipts", async () => {
    const { actions } = fixture({ tools: [] });
    const queued = await actions.openPr(repo, 17);
    assert.throws(() => actions.acknowledge({ requestId: randomUUID(), ok: true, message: "Done." }), /unknown/i);
    for (const input of [
        undefined, null, {},
        { requestId: queued.requestId, ok: "true", message: "Done." },
        { requestId: queued.requestId, ok: 1, message: "Done." },
        { requestId: queued.requestId, ok: true },
        { requestId: queued.requestId, ok: true, message: {} },
        { requestId: queued.requestId, ok: true, message: "" },
        { requestId: queued.requestId, ok: true, message: "   " },
        { requestId: queued.requestId, ok: true, message: "x".repeat(2001) },
    ]) {
        assert.throws(() => actions.acknowledge(input), /receipt|request|message|boolean/i);
    }
    assert.deepEqual(actions.snapshot(), [queued]);
});

test("agent receipts cannot override pending or completed direct execution", async () => {
    const entered = deferred(), gate = deferred();
    const { actions } = fixture({ execute: async () => {
        entered.resolve();
        await gate.promise;
        return success;
    } });
    const pending = actions.openSession(sessionId);
    await entered.promise;
    const input = { requestId: actions.snapshot()[0].requestId, ok: true, message: "Done." };
    try {
        assert.throws(() => actions.acknowledge(input), /queued|awaiting/i);
    } finally {
        gate.resolve();
        await pending;
    }
    assert.throws(() => actions.acknowledge(input), /queued|awaiting/i);
});

test("send failures are recorded, reject later agent receipts, and permit deliberate retries", async () => {
    const { actions, calls } = fixture({ tools: [], send: async () => { throw new Error("Agent unavailable."); } });
    const receipt = await actions.openSession(sessionId);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.message, /Agent unavailable/);
    assert.throws(() => actions.acknowledge({ requestId: receipt.requestId, ok: true, message: "Done." }), /queued|awaiting/i);
    const retried = await actions.openSession(sessionId);
    assert.notEqual(retried.requestId, receipt.requestId);
    assert.equal(calls.sent.length, 2);
    assert.deepEqual(actions.snapshot(), [receipt, retried]);
});

test("deliberate subsequent direct navigation after success or failure gets a fresh request", async t => {
    for (const result of [success, { ...success, resultType: "denied" }]) {
        await t.test(result.resultType, async () => {
            const { actions, calls } = fixture({ execute: async () => result });
            const first = await actions.openSession(sessionId);
            const second = await actions.openSession(sessionId);
            assert.notEqual(second.requestId, first.requestId);
            assert.equal(calls.executed.length, 2);
            assert.deepEqual(actions.snapshot(), [first, second]);
        });
    }
});

test("deliberate navigation after an agent receipt issues a fresh request", async t => {
    for (const ok of [true, false]) {
        await t.test(String(ok), async () => {
            const { actions, calls } = fixture({ tools: [] });
            const first = await actions.openPr(repo, 17);
            const input = { requestId: first.requestId, ok, message: ok ? "Done." : "Denied." };
            actions.acknowledge(input);
            const second = await actions.openPr(repo, 17);
            assert.notEqual(second.requestId, first.requestId);
            actions.acknowledge(input);
            assert.deepEqual(await actions.openPr(repo, 17), second);
            assert.equal(calls.sent.length, 2);
        });
    }
});

test("snapshots and returned receipts are detached metadata with no raw tool payload", async () => {
    const { actions } = fixture({ execute: async () => ({
        ...success, sessionLog: "private log", toolTelemetry: { internal: true },
    }) });
    const returned = await actions.openSession(sessionId);
    const expected = structuredClone(returned);
    returned.target.sessionId = "mutated";
    returned.status = "failed";
    const snapshot = actions.snapshot();
    snapshot[0].target.sessionId = "also-mutated";
    snapshot[0].message = "Changed.";
    snapshot.push({});
    assert.deepEqual(actions.snapshot(), [expected]);
    assert.deepEqual(Object.keys(expected).sort(), ["message", "requestId", "status", "target"]);
    assert.deepEqual(fixture().actions.snapshot(), []);
});

test("constructor rejects an unusable session boundary or missing canvas instance", () => {
    const { session, instanceId } = fixture();
    assert.throws(() => new HostActions(), /session/i);
    for (const value of [undefined, null, {}, { rpc: { tools: {} } }, { ...session, send: null }]) {
        assert.throws(() => new HostActions({ session: value, instanceId }), /session/i);
    }
    for (const value of [undefined, null, 42, "", "   "]) {
        assert.throws(() => new HostActions({ session, instanceId: value }), /instance/i);
    }
});

test("the public API exposes only navigation, acknowledgement and receipt polling", () => {
    assert.deepEqual(Object.getOwnPropertyNames(HostActions.prototype).sort(),
        ["acknowledge", "constructor", "openPr", "openSession", "snapshot"]);
});

test("fallback returns queued even if a navigation receipt arrives before send settles", async t => {
    for (const ok of [true, false]) {
        await t.test(String(ok), async () => {
            const { actions } = fixture({ tools: [], send: async () => {
                actions.acknowledge({ requestId: actions.snapshot().at(-1).requestId, ok, message: ok ? "Done." : "Denied." });
            } });
            const queued = await actions.openSession(sessionId);
            assert.equal(queued.status, "queued");
            assert.deepEqual(actions.snapshot(), [{ ...queued, status: ok ? "acknowledged" : "failed", message: ok ? "Done." : "Denied." }]);
            assert.notEqual((await actions.openSession(sessionId)).requestId, queued.requestId);
        });
    }
});

test("a late dispatch error is surfaced without overwriting a known navigation outcome", async t => {
    for (const ok of [true, false]) {
        await t.test(String(ok), async () => {
            let input;
            const { actions, calls } = fixture({ tools: [], send: async () => {
                input = { requestId: actions.snapshot().at(-1).requestId, ok, message: ok ? "Done." : "Denied." };
                actions.acknowledge(input);
                throw new Error("Dispatch connection closed.");
            } });
            const queued = await actions.openSession(sessionId);
            assert.equal(queued.status, "queued");
            assert.match(queued.message, /Dispatch connection closed/);
            const [receipt] = actions.snapshot();
            assert.equal(receipt.status, ok ? "acknowledged" : "failed");
            assert.match(receipt.message, /Dispatch connection closed/);
            assert.deepEqual(actions.acknowledge(input), receipt);
            assert.equal(calls.sent.length, 1);
            assert.equal(calls.executed.length, 0);
        });
    }
});

test("completed transient receipts retain the latest 100 by completion, not request order", async () => {
    const { actions } = fixture({
        tools: [{ name: "navigate_to_github_item" }],
        execute: async ({ arguments: args }) => args.number % 2 ? success : { ...success, resultType: "denied" },
    });
    const delayed = await actions.openSession(sessionId);
    const completed = [];
    for (let number = 1; number <= 105; number++) completed.push(await actions.openPr(repo, number));
    assert.deepEqual(actions.snapshot(), [delayed, ...completed.slice(-100)]);

    const input = { requestId: delayed.requestId, ok: true, message: "Done." };
    const receipt = actions.acknowledge(input);
    assert.deepEqual(actions.snapshot(), [receipt, ...completed.slice(-99)]);
    assert.deepEqual(actions.acknowledge(input), receipt);
    assert.throws(() => actions.acknowledge({ ...input, requestId: completed[0].requestId }), /unknown/i);
});

test("queued receipts are never evicted even when they exceed the completed receipt cap", async () => {
    const { actions, calls } = fixture({ tools: [{ name: "navigate_to" }] });
    const queued = [], completed = [];
    for (let number = 1; number <= 120; number++) queued.push(await actions.openPr(repo, number));
    for (let index = 0; index < 105; index++) completed.push(await actions.openSession(sessionId));
    assert.deepEqual(actions.snapshot(), [...queued, ...completed.slice(-100)]);
    assert.deepEqual(await actions.openPr(repo, 1), queued[0]);
    assert.equal(calls.sent.length, 120);
    assert.equal(actions.acknowledge({ requestId: queued[0].requestId, ok: false, message: "Denied." }).status, "failed");
    assert.equal(actions.snapshot().filter(receipt => receipt.status === "queued").length, 119);
    assert.equal(actions.snapshot().length, 219);
});

test("retention protects in-flight execution and acknowledged receipts whose send is still pending", async () => {
    const executionEntered = deferred(), sendEntered = deferred(), executionGate = deferred(), sendGate = deferred();
    let input;
    const { actions, calls } = fixture({
        tools: [{ name: "navigate_to_github_item" }],
        execute: async ({ arguments: args }) => {
            if (args.number === 1) {
                executionEntered.resolve();
                await executionGate.promise;
            }
            return success;
        },
        send: async () => {
            input = { requestId: actions.snapshot().at(-1).requestId, ok: true, message: "Done." };
            actions.acknowledge(input);
            sendEntered.resolve();
            await sendGate.promise;
        },
    });
    const executing = actions.openPr(repo, 1);
    await executionEntered.promise;
    const sending = actions.openSession(sessionId);
    await sendEntered.promise;
    const original = actions.snapshot();
    const executingAgain = actions.openPr(repo, 1), sendingAgain = actions.openSession(sessionId);
    try {
        const completed = [];
        for (let number = 2; number <= 106; number++) completed.push(await actions.openPr(repo, number));
        assert.deepEqual(actions.snapshot(), [...original, ...completed.slice(-100)]);
        assert.equal(calls.executed.length, 106);
        assert.equal(calls.sent.length, 1);
    } finally {
        executionGate.resolve();
        sendGate.resolve();
        const [first, second, firstAgain, secondAgain] = await Promise.all([executing, sending, executingAgain, sendingAgain]);
        assert.deepEqual(first, firstAgain);
        assert.deepEqual(second, secondAgain);
    }
    assert.equal(actions.snapshot().length, 100);
    assert.equal(actions.acknowledge(input).status, "acknowledged");
});

test("a PR with a known owning session opens that session, where the app shows its PR tab", async () => {
    const { actions, session, calls } = fixture();
    let canvasOpens = 0;
    session.rpc.canvas = { open: async () => { canvasOpens++; return { instanceId: "x" }; } };
    const receipt = await actions.openPr(repo, 17, { sessionId });
    assert.equal(receipt.status, "acknowledged");
    assert.deepEqual(receipt.target, { kind: "pr", repo, number: 17 });
    assert.deepEqual(calls.executed, [{ name: "navigate_to", arguments: { id: sessionId } }]);
    assert.equal(canvasOpens, 0, "no custom or browser canvas");
    await assert.rejects(actions.openPr(repo, 17, { sessionId: "bad id" }), /session ID/);
});

test("a PR without an owning session opens the app's native PR view", async () => {
    const { actions, calls } = fixture({ execute: () => ({ resultType: "success", textResultForLlm: `Opening ${repo}#17.` }) });
    const receipt = await actions.openPr(repo, 17);
    assert.equal(receipt.status, "acknowledged");
    assert.deepEqual(calls.executed, [{ name: "navigate_to_github_item", arguments: { kind: "pull_request", repo_full_name: repo, number: 17 } }]);
});

test("native PR navigation accepts its observed target-specific acknowledgement, not another target", async () => {
    let message = `Opening ${repo}#18.`;
    const { actions, calls } = fixture({ execute: async () => ({ resultType: "success", textResultForLlm: message }) });
    assert.equal((await actions.openPr(repo, 18)).status, "acknowledged");
    message = `Opening ${repo}#19.`;
    assert.equal((await actions.openPr(repo, 18)).status, "failed");
    message = `Opening ${repo}#18.`;
    assert.equal((await actions.openSession(sessionId)).status, "failed");
    assert.equal(calls.sent.length, 0, "native navigation never falls back to the agent after executing");
});

test("a stalled tool list or navigation call fails in bounded time and frees the target for a retry", async t => {
    for (const stalled of ["metadata", "execute"]) {
        await t.test(stalled, async () => {
            const late = deferred();
            let stall = true;
            const { actions, calls } = fixture({
                timeouts: { metadata: 20, execute: 20 },
                metadata: async () => stall && stalled === "metadata" ? late.promise : { tools: [{ name: "navigate_to" }] },
                execute: async () => stall && stalled === "execute" ? late.promise : success,
            });
            const started = Date.now();
            const [first, duplicate] = await Promise.all([actions.openSession(sessionId), actions.openSession(sessionId)]);
            assert.ok(Date.now() - started < 2000, "the receipt settles once the call times out");
            assert.deepEqual(duplicate, first, "a click while the call is pending shares its request");
            assert.equal(first.status, "failed");
            assert.match(first.message, /^Copilot did not answer the navigation request within \d+s\. Try again\.$/);
            assert.deepEqual(calls.sent, [], "a timeout never falls back to the agent");
            assert.throws(() => actions.acknowledge({ requestId: first.requestId, ok: true, message: "Done." }), /queued|awaiting/i);

            stall = false;
            const retried = await actions.openSession(sessionId);
            assert.notEqual(retried.requestId, first.requestId, "the timed-out target is released");
            assert.equal(retried.status, "acknowledged");
            assert.equal(calls.metadata, 2);
            assert.equal(calls.executed.length, stalled === "execute" ? 2 : 1);

            // The runtime answering after the timeout does not rewrite the recorded outcome.
            late.resolve(stalled === "metadata" ? { tools: [{ name: "navigate_to" }] } : success);
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.deepEqual(actions.snapshot(), [first, retried]);
        });
    }
});

test("errors from a call that answers in time keep their own message", async () => {
    const { actions } = fixture({ timeouts: { metadata: 1000, execute: 1000 }, execute: async () => { throw new Error("Host permission denied."); } });
    const receipt = await actions.openSession(sessionId);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.message, "Host permission denied.");
});

test("a queued native PR view does not swallow a later request to open the PR's owning session, or the reverse", async () => {
    const { actions, calls } = fixture({ tools: [], send: () => new Promise(() => {}) }); // host tools unavailable: requests stay queued
    const native = actions.openPr(repo, 17);
    const owned = actions.openPr(repo, 17, { sessionId });
    const again = actions.openPr(repo, 17, { sessionId });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.sent.length, 2, "one queued request per destination");
    assert.match(calls.sent[0].prompt, /navigate_to_github_item/);
    assert.match(calls.sent[1].prompt, new RegExp(`Call navigate_to with exactly \\{"id":"${sessionId}"\\}`));
    void native; void owned; void again;
});

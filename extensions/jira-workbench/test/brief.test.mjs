import test from "node:test";
import assert from "node:assert/strict";
import { createBrief, acknowledgeBrief, criteriaFromDescription } from "../lib/brief.mjs";

const base = {
    node: { id: "2", key: "DEMO-2", summary: "Loading states", description: "Original reference", updated: "revision-one", dependencies: [] },
    parent: { id: "1", key: "DEMO-1", summary: "Epic", description: "Parent requirements", updated: "parent-revision" },
    children: [], mapping: { id: "app-project", repo: "example/demo" },
    siteUrl: "https://example.atlassian.net", mode: "autopilot",
};

test("brief contains edited fields, source provenance and stable content hash", () => {
    const brief = createBrief({ ...base, fields: { objective: "Handle errors", acceptanceCriteria: "Show loading\nShow actionable failure", constraints: "No backend changes" } });
    assert.equal(brief.objective, "Handle errors");
    assert.deepEqual(brief.acceptanceCriteria, ["Show loading", "Show actionable failure"]);
    assert.equal(brief.constraints, "No backend changes");
    assert.equal(brief.intent, "implement");
    assert.equal(brief.sources[0].description, "Original reference");
    assert.ok(brief.sources.some(s => s.key === "DEMO-1"));
    assert.ok(brief.sources.every(s => s.kind === "jira"));
    assert.match(brief.hash, /^[a-f0-9]{64}$/);
    assert.equal(brief.hash, createBrief({ ...base, fields: brief.fields }).hash);
    assert.equal(brief.warnings.length, 0);
});

test("criteria are extracted only from explicit acceptance sections, never invented from prose", () => {
    assert.deepEqual(criteriaFromDescription("A happy user should see results."), []);
    assert.deepEqual(criteriaFromDescription("## Acceptance criteria\n- [ ] Show loading\n- Show failure\n## Notes\n- not criteria"), ["Show loading", "Show failure"]);
});

test("planning is allowed with advisory gaps but implementation requires matching acknowledgements", () => {
    const brief = createBrief({ ...base, dependencyWarnings: [{ id: "dependency:DEMO-3", message: "Blocked by DEMO-3" }] });
    assert.deepEqual(brief.warnings.map(w => w.id), ["missing-criteria", "dependency:DEMO-3"]);
    assert.throws(() => acknowledgeBrief(brief, { contextHash: brief.hash, acknowledgedWarnings: [] }), /acknowledge/i);
    assert.deepEqual(acknowledgeBrief(brief, { contextHash: brief.hash, acknowledgedWarnings: brief.warnings.map(w => w.id) }), ["missing-criteria", "dependency:DEMO-3"]);
    const plan = createBrief({ ...base, mode: "plan" });
    assert.deepEqual(acknowledgeBrief(plan, { contextHash: plan.hash }), []);
});

test("changes to brief, repository or warning set invalidate prior acknowledgement", () => {
    const original = createBrief(base);
    for (const changed of [
        { ...base, fields: { objective: "Different outcome" } },
        { ...base, mapping: { id: "other-app", repo: "example/other" } },
        { ...base, node: { ...base.node, updated: "new-revision" } },
        { ...base, dependencyWarnings: [{ id: "dependency:DEMO-9", message: "New blocker" }] },
    ]) {
        const brief = createBrief(changed);
        assert.notEqual(brief.hash, original.hash);
        assert.throws(() => acknowledgeBrief(brief, { contextHash: original.hash, acknowledgedWarnings: original.warnings.map(w => w.id) }), /changed|hash|review/i);
    }
});

test("brief validates fields and does not mutate source references", () => {
    const before = JSON.stringify(base);
    assert.throws(() => createBrief({ ...base, fields: { objective: "" } }), /objective/i);
    assert.throws(() => createBrief({ ...base, fields: { constraints: {} } }), /constraints/i);
    assert.throws(() => createBrief({ ...base, fields: { acceptanceCriteria: "x".repeat(10001) } }), /criteria/i);
    createBrief(base);
    assert.equal(JSON.stringify(base), before);
});

test("oversized source criteria remain in references and warn instead of preventing planning", () => {
    const description = "## Acceptance criteria\n" + Array.from({ length: 55 }, (_, index) => `- Criterion ${index}`).join("\n");
    const brief = createBrief({ ...base, mode: "plan", node: { ...base.node, description } });
    assert.deepEqual(brief.acceptanceCriteria, []);
    assert.ok(brief.warnings.some(w => w.id === "source-criteria-limit"));
    assert.equal(brief.sources[0].description, description);
    assert.deepEqual(acknowledgeBrief(brief, { contextHash: brief.hash }), []);
});

test("unavailable parent requirements are an explicit context warning", () => {
    const brief = createBrief({ ...base, parent: undefined, node: { ...base.node, parentKey: "OTHER-1" } });
    assert.ok(brief.warnings.some(w => w.id === "parent-context"));
});

test("valid textarea criteria round-trip through their normalized array without changing the brief", () => {
    const brief = createBrief({ ...base, fields: { acceptanceCriteria: "x".repeat(2500) } });
    assert.equal(createBrief({ ...base, fields: brief.fields }).hash, brief.hash);
});

import { createHash } from "node:crypto";

function text(value, label, max, required = false) {
    if (typeof value !== "string" || value.length > max || (required && !value.trim()))
        throw new Error(`${label} must be ${required ? "non-empty " : ""}text of at most ${max} characters.`);
    return value.trim();
}

export function criteriaFromDescription(description = "") {
    const lines = description.split(/\r?\n/);
    const start = lines.findIndex(line => /^(?:#{1,6}\s*)?(?:\*\*)?acceptance criteria(?:\*\*)?:?\s*$/i.test(line.trim()));
    if (start < 0) return [];
    const output = [];
    for (const line of lines.slice(start + 1)) {
        if (/^#{1,6}\s/.test(line.trim())) break;
        const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
        if (match) output.push(match[1].trim());
    }
    return output;
}

export function createBrief({ node, parent, children = [], mapping, siteUrl, mode, fields = {}, dependencyWarnings = [] }) {
    if (!["plan", "autopilot"].includes(mode)) throw new Error("A valid brief intent is required.");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
        || Object.keys(fields).some(key => !["objective", "acceptanceCriteria", "constraints"].includes(key)))
        throw new Error("Brief fields must contain only objective, acceptance criteria and constraints.");
    const objective = text(fields.objective ?? node.summary, "Objective", 2000, true);
    const extracted = criteriaFromDescription(node.description);
    const sourceCriteriaLimit = extracted.length > 50 || extracted.join("\n").length > 10000;
    const inputCriteria = fields.acceptanceCriteria ?? (sourceCriteriaLimit ? [] : extracted);
    if (!Array.isArray(inputCriteria) && typeof inputCriteria !== "string") throw new Error("Acceptance criteria must be a list or text.");
    const joined = Array.isArray(inputCriteria) ? inputCriteria.map(value => text(value, "Acceptance criteria", 10000)).join("\n") : inputCriteria;
    text(joined, "Acceptance criteria", 10000);
    const acceptanceCriteria = joined.split(/\r?\n/).map(line => line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, "").trim()).filter(Boolean);
    if (acceptanceCriteria.length > 50) throw new Error("Acceptance criteria must contain at most 50 items.");
    const constraints = text(fields.constraints ?? "", "Constraints", 4000);
    const warnings = [];
    if (!acceptanceCriteria.length) warnings.push({ id: "missing-criteria", message: "No explicit acceptance criteria. Planning is available; acknowledge this gap before implementing." });
    if (sourceCriteriaLimit) warnings.push({ id: "source-criteria-limit", message: "The source criteria exceed this brief's editing limits. Original requirements remain in references; enter a scoped checklist or plan first." });
    if (node.parentKey && !parent) warnings.push({ id: "parent-context", message: `Parent ${node.parentKey} is not loaded; its requirements have not been included.` });
    warnings.push(...dependencyWarnings.map(w => ({ id: w.id, message: w.message })));
    const jiraRef = (issue, role) => ({
        kind: "jira", role, id: issue.id, key: issue.key, revision: issue.updated || null,
        summary: issue.summary, description: issue.description || "",
        url: issue.id === "project" ? `${siteUrl}/jira/projects` : `${siteUrl}/browse/${encodeURIComponent(issue.key)}`,
    });
    const sources = [jiraRef(node, "selected")];
    if (parent) sources.push(jiraRef(parent, "parent"));
    const content = {
        version: 1, intent: mode === "plan" ? "plan" : "implement", objective, acceptanceCriteria, constraints,
        repository: { projectId: mapping.id, repo: mapping.repo }, nodeId: node.id,
        sources, children: children.map(child => ({ id: child.id, key: child.key, summary: child.summary, status: child.status })),
        dependencies: node.dependencies || [], warnings,
    };
    return {
        ...content, fields: { objective, acceptanceCriteria, constraints },
        hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    };
}

export function acknowledgeBrief(brief, { contextHash, acknowledgedWarnings = [] }) {
    if (contextHash !== brief.hash) throw new Error("The brief changed or its hash is missing. Review the current preview.");
    if (!Array.isArray(acknowledgedWarnings) || !acknowledgedWarnings.every(id => typeof id === "string"))
        throw new Error("Warning acknowledgements must be a list of IDs.");
    const valid = new Set(brief.warnings.map(w => w.id));
    if (acknowledgedWarnings.some(id => !valid.has(id))) throw new Error("The warning set changed. Review the preview again.");
    if (brief.intent === "implement" && brief.warnings.some(w => !acknowledgedWarnings.includes(w.id)))
        throw new Error("Acknowledge the context and dependency warnings before implementing, or choose Plan.");
    return brief.warnings.filter(w => acknowledgedWarnings.includes(w.id)).map(w => w.id);
}

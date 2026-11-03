import { createHash } from "node:crypto";
import { HIDDEN, hasHidden } from "./validate.mjs";

function text(value, label, max, required = false) {
    if (typeof value !== "string" || value.length > max || (required && !value.trim()))
        throw new Error(`${label} must be ${required ? "non-empty " : ""}text of at most ${max} characters.`);
    return value.trim();
}

// A Markdown or Jira wiki heading, or a bold or italic label, optionally "(AC)" and a trailing colon. Matched against a
// whitespace-collapsed line, so each optional space matches at most one character and a long line cannot backtrack.
const CRITERIA_HEADER = /^(?:#{1,6} ?|h[1-6]\. ?)?([*_]{1,2})? ?acceptance criteria(?: ?\(ac\))? ?:? ?\1? ?:?$/i;
const CRITERIA_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;
const SECTION_HEADING = /^(?:#{1,6}|h[1-6]\.)\s/;
const SECTION_LABEL = /^([*_]{1,2})\S.*\1:?$/;
// A plain "Label:" line: a common section name, or any label of at most three words. Longer lines such as
// "The following must hold:" are introductory prose and keep the section open.
const PLAIN_LABEL = /^(?:(?:out of scope|not in scope|non-goals?|notes?|open questions|questions|assumptions|dependencies|risks|background|context|references|links|definition of done|technical notes|implementation notes|design)\b[^:]{0,60}|[^\s:]+(?: [^\s:]+){0,2}):$/i;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
// A Markdown setext underline directly below the header line belongs to the heading, not a section break.
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;

// Only the explicit criteria section counts. It ends at the next heading, label line or horizontal rule (even before
// its first item, so an empty section never collects the next one), or at the first unindented prose line after its
// items, so later sections are never collected as criteria.
export function criteriaFromDescription(description = "") {
    const lines = description.split(/\r?\n/);
    const start = lines.findIndex(line => CRITERIA_HEADER.test(line.trim().replace(/\s+/g, " ")));
    if (start < 0) return [];
    const output = [];
    const first = start + (SETEXT_UNDERLINE.test(lines[start + 1] || "") ? 2 : 1);
    for (const line of lines.slice(first)) {
        const trimmed = line.trim();
        if (SECTION_HEADING.test(trimmed) || RULE.test(line)) break;
        const match = CRITERIA_ITEM.exec(line);
        if (match) { output.push(match[1].trim()); continue; }
        if (SECTION_LABEL.test(trimmed) || PLAIN_LABEL.test(trimmed.replace(/\s+/g, " "))
            || (output.length && trimmed && !/^\s/.test(line))) break;
    }
    return output;
}

const strip = value => typeof value === "string" ? value.replace(HIDDEN, "") : value;

// criteriaText: the full description when node.description was shortened to fit the kickoff budget, so the default
// acceptance criteria still come from the whole source.
export function createBrief({ node, parent, children = [], mapping, siteUrl, mode, fields = {}, dependencyWarnings = [], smartCommitComment = false, criteriaText = node.description }) {
    if (!["plan", "autopilot"].includes(mode)) throw new Error("A valid brief intent is required.");
    if (typeof smartCommitComment !== "boolean") throw new Error("The Smart Commit comment choice must be true or false.");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
        || Object.keys(fields).some(key => !["objective", "acceptanceCriteria", "constraints"].includes(key)))
        throw new Error("Brief fields must contain only objective, acceptance criteria and constraints.");
    const objective = text(strip(fields.objective ?? node.summary), "Objective", 2000, true);
    const extracted = criteriaFromDescription(criteriaText);
    const sourceCriteriaLimit = extracted.length > 50 || extracted.join("\n").length > 10000;
    const inputCriteria = fields.acceptanceCriteria ?? (sourceCriteriaLimit ? [] : extracted);
    if (!Array.isArray(inputCriteria) && typeof inputCriteria !== "string") throw new Error("Acceptance criteria must be a list or text.");
    const joined = text(Array.isArray(inputCriteria)
        ? inputCriteria.map(value => text(strip(value), "Acceptance criteria", 10000)).join("\n")
        : strip(inputCriteria), "Acceptance criteria", 10000);
    // Strip every leading marker at once, so a stored criterion such as "- X" (reviewed as "- - X") is not stripped again on launch.
    const acceptanceCriteria = joined.split(/\r?\n/).map(line => line.replace(/^(?:\s*[-*]\s+(?:\[[ xX]\]\s*)?)+/, "").trim()).filter(Boolean);
    if (acceptanceCriteria.length > 50) throw new Error("Acceptance criteria must contain at most 50 items.");
    const constraints = text(strip(fields.constraints ?? ""), "Constraints", 4000);
    const warnings = [];
    // Derived from the Jira source, not the fields: the fields are already stripped, so the re-derivation at launch keeps the hash.
    if ([node, parent, ...children].some(issue => hasHidden(issue?.summary) || hasHidden(issue?.description)))
        warnings.push({ id: "hidden-characters", message: "The Jira text contains hidden characters (Unicode tag or text-direction controls) that can carry instructions you cannot see. They were removed from these fields; check the issue in Jira before implementing." });
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
        dependencies: node.dependencies || [], warnings, smartCommitComment,
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

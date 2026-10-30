export const DEFAULT_SCOPE = Object.freeze({ kind: "project", value: "" });
// The first bounded page should be current work, not the oldest keys; the tree sorts its own display order.
export const DEFAULT_ORDER = "updated DESC, key DESC";

export function validateScope(input = DEFAULT_SCOPE) {
    if (!input || !["project", "jql", "filter"].includes(input.kind))
        throw new Error("Choose Project, JQL or Saved filter scope.");
    const value = typeof input.value === "string" ? input.value.trim() : "";
    if (value.length > 4000) throw new Error("Scope must be at most 4,000 characters.");
    if (input.kind === "jql" && !value) throw new Error("Enter a JQL expression.");
    if (input.kind === "filter" && !/^\d+$/.test(value)) throw new Error("Enter a numeric saved Jira filter ID.");
    return { kind: input.kind, value: input.kind === "project" ? "" : value };
}

// ORDER BY is only a clause outside quoted JQL strings, including escaped quotes.
function splitOrder(jql) {
    let quote = null, depth = 0;
    for (let index = 0; index < jql.length; index++) {
        const char = jql[index];
        if (char === "\\") { index++; continue; }
        if (quote) { if (char === quote) quote = null; continue; }
        if (char === "'" || char === '"') { quote = char; continue; }
        if (char === "(") depth++;
        if (char === ")" && --depth < 0) throw new Error("JQL has an unmatched closing parenthesis.");
        const order = depth === 0 && !/\w/.test(jql[index - 1] || "") && /^ORDER\s+BY\b/i.exec(jql.slice(index));
        if (order) return [jql.slice(0, index).trim(), jql.slice(index + order[0].length).trim()];
    }
    if (quote || depth) throw new Error("JQL has an unclosed quote or parenthesis.");
    return [jql, DEFAULT_ORDER];
}

export function scopeJql(projectId, definition = DEFAULT_SCOPE) {
    if (!/^\d+$/.test(projectId)) throw new Error("A numeric Jira project ID is required.");
    const scope = validateScope(definition);
    if (scope.kind === "project") return `project = ${projectId} ORDER BY ${DEFAULT_ORDER}`;
    const [clause, order] = scope.kind === "filter" ? [`filter = ${scope.value}`, DEFAULT_ORDER] : splitOrder(scope.value);
    if (!clause || !order) throw new Error("JQL needs an expression and a nonempty sort clause.");
    return `project = ${projectId} AND (${clause}) ORDER BY ${order}`;
}

export const workingSetKey = (projectScope, definition) => `${projectScope}/working-set/${encodeURIComponent(JSON.stringify(validateScope(definition)))}`;

export function mergeIssues(existing, incoming) {
    const rows = new Map(existing.map(issue => [issue.id, issue]));
    for (const issue of incoming) {
        const previous = rows.get(issue.id);
        rows.set(issue.id, previous && !previous.contextOnly && issue.contextOnly ? previous : issue);
    }
    return [...rows.values()];
}

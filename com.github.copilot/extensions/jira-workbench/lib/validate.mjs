// Identifier rules shared by the extension and the panel. Browser-safe (no node: imports):
// model.mjs imports this and is also served to the panel.
export const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,49}-\d{1,12}$/;
export const CLOUD_ID = /^[\w-]{1,100}$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;
export const PROJECT_ID = /^\d{1,18}$/;

const valid = (pattern, value) => typeof value === "string" && pattern.test(value);
const enforce = (pattern, value, message) => {
    if (!valid(pattern, value)) throw new Error(message);
    return value;
};

export const isRepo = value => valid(REPO, value);
export const isSessionId = value => valid(SESSION_ID, value);
export const isIssueKey = value => valid(ISSUE_KEY, value);
export const isCloudId = value => valid(CLOUD_ID, value);
export const isProjectKey = value => valid(PROJECT_KEY, value);
export const isProjectId = value => valid(PROJECT_ID, value);

export const assertRepo = (value, message = "A valid GitHub repository in owner/repo form is required.") => enforce(REPO, value, message);
export const assertSessionId = (value, message = "A valid app session ID is required.") => enforce(SESSION_ID, value, message);
export const assertIssueKey = (value, message = "A valid Jira issue key is required.") => enforce(ISSUE_KEY, value, message);
export const assertCloudId = (value, message = "A valid Jira site ID is required.") => enforce(CLOUD_ID, value, message);
export const assertProjectKey = (value, message = "A valid Jira project key is required.") => enforce(PROJECT_KEY, value, message);
export const assertProjectId = (value, message = "A valid Jira project ID is required.") => enforce(PROJECT_ID, value, message);

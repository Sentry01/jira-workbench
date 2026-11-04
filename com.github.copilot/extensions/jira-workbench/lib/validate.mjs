// Identifier rules shared by the extension and the panel. Browser-safe (no node: imports):
// model.mjs imports this and is also served to the panel.
export const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,49}-\d{1,12}$/;
export const CLOUD_ID = /^[\w-]{1,100}$/;
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;
export const PROJECT_ID = /^\d{1,18}$/;

// Code points that render as nothing: default-ignorables (zero-width, tag characters, variation selectors), bidi
// controls and the line and paragraph separators. Escaped wherever Jira text reaches a prompt.
export const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2028\u2029]/gu;
// Unicode tag characters and bidi controls have no place in issue text; they can hide or reorder instructions.
// Narrow on purpose, so emoji variation selectors, ZWJ sequences and ZWNJ in Persian or Indic text stay intact.
export const HIDDEN = /[\u{E0000}-\u{E007F}\p{Bidi_Control}]/gu;
export const hasHidden = value => typeof value === "string" && value.search(HIDDEN) >= 0;

const valid = (pattern, value) => typeof value === "string" && pattern.test(value);
const enforce = (pattern, value, message) => {
    if (!valid(pattern, value)) throw new Error(message);
    return value;
};

export const isRepo = value => valid(REPO, value);
export const isSessionId = value => valid(SESSION_ID, value);
export const isCloudId = value => valid(CLOUD_ID, value);

export const assertRepo = (value, message = "A valid GitHub repository in owner/repo form is required.") => enforce(REPO, value, message);
export const assertSessionId = (value, message = "A valid app session ID is required.") => enforce(SESSION_ID, value, message);

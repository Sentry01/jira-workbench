// Stands in for @github/copilot-sdk/extension so extension.mjs can be loaded without a host: joinSession hands it
// the session a test put on globalThis and captures the canvas definition for the test to drive.
export class CanvasError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export const createCanvas = definition => definition;
export async function joinSession({ canvases }) {
    globalThis.__workbenchCanvas = canvases[0];
    return globalThis.__workbenchSession;
}

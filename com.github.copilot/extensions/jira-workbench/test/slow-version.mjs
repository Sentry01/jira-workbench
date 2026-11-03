// lib/version.mjs as a cold extension process sees it: the first open waits on git to identify the build.
import { version as loaded } from "../lib/version.mjs";
export * from "../lib/version.mjs";
export const version = () => new Promise(resolve => setTimeout(resolve, 20)).then(loaded);

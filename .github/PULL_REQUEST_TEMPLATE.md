<!-- Thanks for sending this. Keep it focused; one behavior per pull request. -->

## What changed

<!-- One or two sentences. -->

## Why

<!-- The reasoning the code cannot show. Link the issue it closes: Closes #123 -->

## How it was verified

<!-- Paste the output, not just the claim. -->

```text
node --test extensions/jira-workbench/test/*.test.mjs
<output>

WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node verification/verify-canvas.mjs
<output>
```

## Screenshots

<!-- For UI changes. Regenerate with: WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node docs/screenshots.mjs -->

## Checklist

- [ ] Unit tests pass, and new behavior has a test
- [ ] The isolated browser harness passes
- [ ] No new runtime dependencies (or justified above)
- [ ] The canvas stays Jira read-only; delegated session writes (issue to In Progress, Update Jira status-only sync) are not widened
- [ ] No private data in code, tests, docs, or screenshots
- [ ] Docs updated (`docs/guide.md` for users, the extension README for semantics)
- [ ] Changes to the shipped canvas raise the version in both plugin manifests, or the pull request has the `no-release` label

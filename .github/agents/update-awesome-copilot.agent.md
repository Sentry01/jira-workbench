---
name: update-awesome-copilot
description: Manually update the existing Jira Workbench listing in Awesome Copilot to a published release.
---

# Update the Awesome Copilot listing

Run only when the user asks to update Jira Workbench's Awesome Copilot listing.
This is an on-demand contribution, not a release step or CI workflow. Do not
add Actions workflows, schedules, repository secrets or tokens. Use the user's
existing `gh` login; upstream write access is not needed to submit a fork PR.

## 1. Resolve the published release

Check `gh auth status`. If authentication or fork access is unavailable, report
the blocker without requesting credentials in chat.

Use the latest published, non-draft, non-prerelease release unless the user
names a tag:

```sh
gh release view --repo Sentry01/jira-workbench --json tagName,isDraft,isPrerelease,url
```

For an explicit tag, pass it to `gh release view` and verify it is published.
Validate the tag as `vMAJOR.MINOR.PATCH` before using it in commands. Do not
substitute this checkout's version, an unreleased commit or `main`.
Resolve the tag to its full commit SHA with
`gh api repos/Sentry01/jira-workbench/commits/<tag> --jq .sha`.
Read `plugin.json` at that SHA and require its version to equal the tag without
the `v`. Record the release URL, tag, version and SHA.

## 2. Check upstream before editing

Read the current `github/awesome-copilot` contribution guide, especially
**Updating listed external plugins via PR**, and its PR template. Existing
listing updates use that route, not the intake process for new plugins.
If the current policy no longer permits it, stop and explain.

Read `plugins/external.json` and `.github/plugin/marketplace.json` on upstream
`main`. Require exactly one external entry named `jira-workbench` with
`source.source` equal to `github` and `source.repo` equal to
`Sentry01/jira-workbench`. Do not create a missing listing or guess an ambiguous
match. If both files already pin the target version, tag and SHA, report
"already up to date" and stop without a commit or PR. Do not downgrade a newer
listing unless the user explicitly requested that older release.

Search open upstream PRs for Jira Workbench listing updates. Inspect their
actual diffs and head repositories, not just titles. Reuse an applicable PR
from the authenticated user's fork; do not duplicate it. If somebody else's
PR already proposes the update, report its URL instead of editing it.
If an existing PR already pins the target in both files, report its checks
and review state without an empty commit.

## 3. Prepare an isolated fork branch

Use an existing fork of `github/awesome-copilot` owned by the authenticated
user, or create one only when authorized. Verify its parent repository.
Use a separate checkout or worktree; do not switch this Jira Workbench
checkout to another repository or disturb existing user work.

For a new update, fetch upstream and create a fresh, uniquely named branch
from upstream `main`, such as `jira-workbench-v<version>`. Never commit to a
default branch or reuse the branch of a merged/closed PR blindly.
For an existing open PR, fetch and inspect its actual head branch and diff,
preserve unrelated changes, and update that branch without force-pushing,
resetting or rewriting history. Stop if the ownership or scope is unclear.

## 4. Change only the release pin

In the matched `plugins/external.json` entry, change only:

- `version`: the published version without `v`.
- `source.ref`: the published tag.
- `source.sha`: the full commit SHA resolved from that tag.

Preserve the description, keywords, author, source path and every other entry.
Do not bump this repository's release or edit its plugin manifests.

## 5. Generate and verify

Inspect upstream's current package scripts and documented validation
requirements. Install its locked development dependencies if needed, regenerate
the marketplace with `npm run build`, and run `npm run plugin:validate`
(or their documented replacements). Record exact commands and results.
Never mark an unperformed check as passed.

Inspect the diff. The intended changes are only the matched entry's three pin
fields in `plugins/external.json` and generated `.github/plugin/marketplace.json`.
Require both to match the verified release tuple exactly. Investigate unrelated
generated changes rather than including them or discarding user edits.
Do not push when validation fails or the diff cannot be explained.

## 6. Submit or update the upstream PR

Commit the two listing files and push to the user's fork using a normal push.
Recheck for an existing open update PR before creating one. Target
`github/awesome-copilot` `main`; follow its current template, retain unrelated
PR text, and include the release URL, version, tag, SHA, and validation evidence.
Do not claim template checklist steps were performed when they were not.

## 7. Report status without merging

Return the PR URL and observed checks/review state. An open PR is not a
completed listing update: completion means the upstream PR merged.
Maintainer approval and upstream quality gates still apply. Distinguish an
infrastructure timeout from a plugin defect, and report checks you cannot rerun
rather than closing and recreating a correct PR. Do not merge, post rerun
comments, request reviews, or create monitoring schedules unless asked.

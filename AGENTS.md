# Instructions for agents

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing code; its review rules
are not negotiable. These steps apply to every pull request.

## Release the change

Plugin users install tagged releases, not `main`. A change to the shipped canvas
reaches them only when the version rises.

The shipped canvas is every file under `extensions/jira-workbench/` except
`test/` and Markdown files. If the pull request changes any of them:

1. Raise `version` in `.github/plugin/plugin.json` using Semantic Versioning: a
   patch for fixes, a minor version for new behavior, a major version for
   changes that need users to act. Compare against the version on `main`, not a
   previous commit on the branch, and raise it once per pull request.
2. In `.github/plugin/marketplace.json`, set the entry's `version` to the same
   value and its source `ref` to `v<version>`.
3. Commit, then run both checks; both must pass:

   ```sh
   node .github/scripts/check-release.mjs
   node .github/scripts/check-version-bump.mjs "$(git merge-base origin/main HEAD)"
   ```

The `version` in `extensions/jira-workbench/copilot-extension.json` is the
extension manifest's schema version, not the release version. Leave it alone.

If the change should not publish a release on its own, do not raise the version.
Say so in the pull request body so a maintainer can add the `no-release` label.

Full details are in [Releasing](CONTRIBUTING.md#releasing).

## Update the docs

Update the docs the change makes wrong, in the same pull request:

- `docs/guide.md` for user-facing behavior.
- `extensions/jira-workbench/README.md` for semantics and boundaries.
- `README.md` when what users see or install changes.
- Guide screenshots after UI changes:
  `WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node docs/screenshots.mjs`.

## Open the pull request

Fill in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), including
the commands you ran and their output.

Write docs in a plain, professional tone: no emojis, no em dashes, no Unicode
arrows or ellipses.

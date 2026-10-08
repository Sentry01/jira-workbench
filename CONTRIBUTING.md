# Contributing

This is a small project with no dependencies. To contribute, clone it, run the
tests, and open a focused pull request.

**Not sure where to start?** Open an issue and describe what you were trying to
do. Reports about confusing behavior are as useful as code.

## Set up

```sh
git clone https://github.com/Sentry01/jira-workbench.git
cd jira-workbench
node --version   # 20 or newer
```

There is nothing to install. The extension and its test suite have no runtime
dependencies.

To run your working copy inside Copilot instead of the installed one, link it
into your Copilot home:

```sh
ln -s "$PWD/extensions/jira-workbench" ~/.copilot/extensions/jira-workbench
```

Before you create the link:

1. Uninstall the plugin (`copilot plugin uninstall jira-workbench@jira-workbench`)
   so only one install registers the canvas.
2. If `~/.copilot/extensions/jira-workbench` exists as a real folder, it holds
   your saved data. Move its `artifacts/` folder into your clone's
   `extensions/jira-workbench/`, then delete the folder. Otherwise `ln -s` puts
   the link inside it.

Then ask Copilot to reload extensions.

## Verify your change

Run these from the repository root. Steps 1 and 2 must pass before you open a
pull request. Step 3 is only for UI changes.

```sh
# 1. Unit tests (fast, no browser, no network)
node --test extensions/jira-workbench/test/*.test.mjs

# 2. Isolated browser workflow and MCP reconnect UX, against fake services
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node verification/verify-canvas.mjs
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node verification/verify-reconnect.mjs

# 3. Only if you changed the UI: regenerate the guide screenshots
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node docs/screenshots.mjs
```

The browser steps need the `playwright-core` driver and a Chromium-based browser.
The repository has no `package.json`, so install the driver without saving it,
at the version CI uses:

```sh
npm install --no-save --no-package-lock --no-audit --no-fund playwright-core@1.63.0
```

`node_modules/` is git-ignored. If a parent directory of your clone has its own
`package.json`, npm installs there instead; [`verification/README.md`](verification/README.md)
shows how to use a scratch directory, and documents the `BROWSER_EXECUTABLE` and
`HEADED` options.

CI runs on every pull request and on every push to `main`:

- **Unit tests**: step 1, on Node 20, 22 and 24.
- **Browser harnesses**: both harnesses from step 2, on Linux with Google
  Chrome. Their screenshots are uploaded as an artifact when one fails.
- **No private data**: rejects a committed `artifacts/` directory or an absolute
  home path.
- **Release manifests**: tests the scripts in `.github/scripts/`, then runs
  `check-release.mjs` to check that `plugin.json` and `marketplace.json` name the
  same release. On a pull request it also runs `check-version-bump.mjs`, which
  fails when the shipped canvas changes but the version does not rise (see
  [Releasing](#releasing)).

All four are required: a pull request cannot merge until they pass. Pull
requests are squash-merged, and the branch is deleted after the merge.

## Review rules

Reviewers check these first. A change that breaks one will not be merged.

1. **The canvas stays Jira read-only.** The extension must not edit, transition,
   comment on or create issues, or change sprints. The gateway allows only Jira
   reads; keep it that way. Jira writes are delegated only through launched
   sessions' kickoff prompts: one In Progress transition of the selected issue,
   or the confirmed Update Jira status-only sync within the selected project. Do
   not widen either. These limits exist only as kickoff wording, so review any
   change to that wording as a security change.
2. **No new runtime dependencies.** The extension must keep running from a plain
   `cp -R` with no install step. Development-only tools are negotiable; explain
   why in the pull request.
3. **Never commit private data.** No Jira domains, project keys, cloud IDs,
   repository names, tokens or absolute user paths, in code, tests, docs or
   screenshots. `artifacts/` is git-ignored for this reason; leave it that way.
4. **Screenshots come from the fixture, never from real work.** Regenerate them
   with `docs/screenshots.mjs`, which builds a synthetic `DEMO` project.
5. **Evidence over inference.** Links between an issue, a session and a pull
   request must be verified, and their evidence shown. Never infer them from
   similar titles or branch names.
6. **A pending action is never shown as completed.** If a request is pending,
   the UI must say so.

## Tests

New behavior needs a test. The suite is plain `node:test` with no framework:

- Unit tests live in `extensions/jira-workbench/test/`.
- Prefer a focused test per behavior, including the edge case that made you write it.
- Panel display rules (freshness labels, search, launch state, default modes,
  banners) belong in `lib/view-model.mjs` with a unit test; `ui/app.mjs` only wires
  them to the DOM.
- If a bug survived the unit tests, add the case to `verification/verify-canvas.mjs`
  so the real UI proves it too.

## Pull requests

- Keep it focused. Several small pull requests are better than one large one.
- Explain *why* in the description. The code already shows *what*.
- Paste the output of the verification commands you ran.
- Copilot code review runs on every push and follows [`REVIEW.md`](REVIEW.md);
  its comments are advisory and do not block merging.
- Update the docs you invalidated: [`docs/guide.md`](docs/guide.md) for user-facing
  behavior, [`extensions/jira-workbench/README.md`](extensions/jira-workbench/README.md)
  for semantics and boundaries.

Commit messages: a short imperative subject line, then a paragraph on the reasoning.

## Releasing

Plugin users install releases, not `main`. Merging a pull request does not change
what they get; publishing a release does. The marketplace entry in
`.github/plugin/marketplace.json` pins the current release by tag, and
`copilot plugin update` (or **Update** in the app, or **Update & reload** in the
panel) installs exactly that tag.

To publish a release, change these two files in a pull request, either on their
own or together with the change you are releasing:

1. In `.github/plugin/plugin.json`, raise `version`, for example from `1.1.0` to
   `1.2.0`. This is the version users see in `copilot plugin list` and in the
   app. Use [Semantic Versioning](https://semver.org/): a patch for fixes, a
   minor version for new behavior, a major version for changes that need users
   to act.
2. In `.github/plugin/marketplace.json`, set the entry's `version` to the same
   value and its source `ref` to the new tag:

   ```json
   "version": "1.2.0",
   "source": { "source": "github", "repo": "Sentry01/jira-workbench", "ref": "v1.2.0" },
   ```

Check the pair before you push:

```sh
node .github/scripts/check-release.mjs
```

CI runs the same check on every pull request.

A pull request that changes the shipped canvas must also raise the version. The
shipped canvas is every file under `extensions/jira-workbench/` except `test/`
and Markdown files. CI compares `plugin.json` with the base branch and fails
when the version does not rise. To check a committed branch before you push:

```sh
node .github/scripts/check-version-bump.mjs "$(git merge-base origin/main HEAD)"
```

If a change should wait for a later release, say so in the pull request; a
maintainer adds the `no-release` label, which skips this check. The `version` in
`extensions/jira-workbench/copilot-extension.json` is the extension manifest's
schema version, not the release version.

When the pull request merges, the
`release` workflow creates the `v1.2.0` tag on the merge commit and publishes a
GitHub release with notes generated from the merged pull requests. Until the tag
exists, about a minute, an update fails and the panel does not offer the
release. If the workflow fails, fix the cause and run it again from the Actions
tab; a version that is already tagged is skipped. Release tags are protected:
once created, they cannot be moved or deleted, so a broken release is fixed by
publishing a new version.

## Where things live

```text
extensions/jira-workbench/   The installable canvas; this is the product
  lib/                       Gateway, model, execution classifier, briefs, store, server, build identity and updater, plus:
    connection.mjs           The one supervisor of the Atlassian MCP connection (connecting / ready / signin / down)
    workbench.mjs            Panel state; hands launches and traces to the two modules below
    launches.mjs             Launch briefs, requests, receipts, and their expiry
    trace.mjs                Session and pull request evidence for each work item
    view-model.mjs           The panel's pure display rules, served as /view-model.mjs
    validate.mjs             Shared identifier rules (repository, session ID, issue key, ...)
    runtime.mjs              Shared, time-bounded helpers for Copilot runtime calls
  ui/                        Canvas renderer
  test/                      Node test suite, split along module ownership
docs/                        Install guide, user guide, screenshots, and their generator
.github/plugin/              Plugin and marketplace manifests; the marketplace pins the released version
.github/scripts/             Release checks: the two manifests name one release, and a shipped change raises it
.github/workflows/           CI (unit tests, browser harnesses, private-data and release-manifest checks) and the release workflow
verification/                Browser harnesses and the shared synthetic fixture
AGENTS.md                    Release and docs steps for coding agents working on a pull request
```

Start with [`extensions/jira-workbench/README.md`](extensions/jira-workbench/README.md).
It documents the execution semantics, freshness rules, the read-only boundary,
and the known prototype limits, which reviewers will expect you to know.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

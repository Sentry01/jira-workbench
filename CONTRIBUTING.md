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
ln -s "$PWD/com.github.copilot/extensions/jira-workbench" ~/.copilot/extensions/jira-workbench
```

Before you create the link:

1. Uninstall the plugin (`copilot plugin uninstall jira-workbench@jira-workbench`)
   so only one install registers the canvas.
2. If `~/.copilot/extensions/jira-workbench` exists as a real folder, it holds
   your saved data. Move its `artifacts/` folder into your clone's
   `com.github.copilot/extensions/jira-workbench/`, then delete the folder. Otherwise `ln -s` puts
   the link inside it.

Then ask Copilot to reload extensions.

## Verify your change

Run these from the repository root. Steps 1 and 2 must pass before you open a
pull request. Step 3 is only for UI changes.

```sh
# 1. Unit tests (fast, no browser, no network)
node --test com.github.copilot/extensions/jira-workbench/test/*.test.mjs

# 2. Isolated browser workflow and MCP reconnect UX, against fake services
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-canvas.mjs
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-reconnect.mjs
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-scope.mjs
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-poll.mjs

# 3. Only if you changed the UI: regenerate the guide screenshots
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node docs/screenshots.mjs
```

The browser steps need the `playwright-core` driver and a Chromium-based browser.
Install the driver from the lockfile in `verification/`, as CI does:

```sh
npm ci --prefix verification
```

`node_modules/` is git-ignored. [`verification/README.md`](verification/README.md)
explains how the driver is pinned and updated, and documents the
`BROWSER_EXECUTABLE` and `HEADED` options.

CI runs on every pull request and on every push to `main`:

- **Unit tests**: step 1, on Node 20, 22 and 24.
- **Browser harnesses**: all four harnesses from step 2, on Linux with Google
  Chrome. Their screenshots are uploaded as an artifact when one fails.
- **No private data**: rejects a committed `artifacts/` directory or an absolute
  home path.
- **Dependency review**: on pull requests, checks newly introduced dependencies
  in all scopes, including development dependencies, and fails on high or
  critical vulnerabilities.
- **Release manifests**: tests the scripts in `.github/scripts/`, then runs
  `check-release.mjs` to check that `plugin.json` and `marketplace.json` name the
  same release. On a pull request it also runs `check-version-bump.mjs`, which
  fails when the shipped canvas changes but the version does not rise (see
  [Releasing](#releasing)), and fails if dependency review did not pass.

Unit tests, browser harnesses, no private data and release manifests are
required: a pull request cannot merge until they pass. Dependency review is
enforced through the required Release manifests check. The branch must also be
up to date with `main`, so the checks run against the latest release; otherwise
two pull requests could both raise the version to the same number and the
second would merge unreleased. Pull requests are squash-merged, and the branch
is deleted after the merge.

### Stacked pull requests

A stack merges whole or not at all. GitHub already blocks merging a pull request
while one below it is not ready, but on its own it would let a lower part of a
stack merge and leave the rest behind. The `stack gate` workflow closes that gap
with a commit status named **Stack gate** on the head commit of every open pull
request in the stack:

- It is success only when every open member of the stack is ready: not a draft,
  every check `main` requires passing, no reviewer whose latest review
  requests changes, and no unresolved review thread (`main` requires
  conversation resolution). Otherwise it fails on every member, and its
  description names the pull requests that are not ready and why, for example
  `#19 (2 unresolved threads)`.
- A pull request outside a stack always gets success.
- It reads the required checks from the protection and rulesets of the stack's
  base branch, and ignores **Stack gate** itself when it judges the members.
- Any change in the stack re-evaluates all of it: a member is opened, pushed,
  edited, closed, marked draft or ready, reviewed or commented on, or a run of
  the `tests` workflow starts or finishes. A re-run that leaves the head commit
  unchanged therefore blocks the stack while its checks are pending.
- A schedule also sweeps every open pull request every 15 minutes (GitHub can
  delay scheduled runs). It picks up resolved and reopened review threads,
  which trigger no workflow, and review events on stacked pull requests, which
  run the workflow file from the pull request's merge ref and so miss it until
  the base branch contains it. A status is posted only when it changes.
- To re-evaluate by hand, run the workflow from the Actions tab with a pull
  request number, or with no number to sweep every open pull request.

Required on `main`, the status blocks merging any part of a stack until the
whole stack could merge. The workflow runs with a write token, so it never
checks out or runs pull request code: it runs `.github/scripts/stack-gate.mjs`
from the default branch and reads everything else through the API.

### Copilot code review

No pull request merges, by a person or an agent, until Copilot code review has
found it clean. The `ccr gate` workflow posts a commit status named **CCR gate**
on the head commit of every open pull request:

- It is success only when the latest Copilot code review is of the current head
  commit, its verdict is "Approval recommended", and it lists no open issues.
  "Changes recommended", "Needs a closer look", a review of an older commit, or
  no review at all is a failure, and the description says which. If several
  open pull requests share a head commit, each of them needs that clean review.
- If the gate cannot read a pull request's reviews, it marks the head commit as
  failed rather than leave an earlier success, and checks the others.
- A new push has no **CCR gate** status until the gate posts one, so a required
  gate blocks the new head commit until Copilot reviews it. The workflow checks
  pushes at once, and a schedule checks every open pull request every 15
  minutes to pick up new reviews: Copilot's own review events start no
  workflow. GitHub can delay or skip scheduled runs for hours, so once
  Copilot's review of the head commit is posted, run the workflow by hand
  (`gh workflow run ccr-gate.yml`) to count it at once. A status is posted
  only when it changes.
- Copilot can report a finding only in its review summary, for example a
  "previously missed issue" in code the pull request did not change. Such a
  finding has no review thread, so resolving every thread does not clear it;
  the gate still fails until a later review recommends approval.
- Unresolved review threads, including Copilot's, are blocked separately by
  `main`'s conversation resolution rule.
- Every run checks every open pull request, one run at a time, so two runs
  cannot post conflicting statuses for the same commit. To check by hand, run
  the workflow from the Actions tab.
- A run that changes a status starts a stack gate sweep, because a member's
  **CCR gate** can change without a push.

If Copilot code review does not review a pull request, request a review from
Copilot on it. Like the stack gate, this workflow never checks out or runs pull
request code.

Limits of both gates:

- They share the `GITHUB_TOKEN` budget of 1,000 API requests an hour for this
  repository. They read as little as they can and sweep every 15 minutes; do
  not make the schedules more frequent without checking that budget.
- The required checks trust statuses from `github-actions[bot]`, and any
  workflow in this repository can post as that account, including one that a
  pull request adds or edits. The gates stop a merge that comes too early, not
  a change to `.github/` itself, so review such changes by hand.

## Review rules

Reviewers check these first. A change that breaks one will not be merged.

1. **The canvas stays Jira read-only.** The extension must not edit, transition,
   comment on or create issues, or change sprints. The gateway allows only Jira
   reads; keep it that way. Jira writes are delegated only through launched
   sessions' kickoff prompts: one In Progress transition of the selected issue,
   one opt-in Smart Commit `#comment` on the selected issue, or the confirmed
   Update Jira status-only sync within the selected project. Do
   not widen any of them. These limits exist only as kickoff wording, so review any
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

- Unit tests live in `com.github.copilot/extensions/jira-workbench/test/`.
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
- Copilot code review runs on every push and follows [`REVIEW.md`](REVIEW.md).
  A pull request merges only after it finds the head commit clean (see
  [Copilot code review](#copilot-code-review)), and its threads are resolved.
- Update the docs you invalidated: [`docs/guide.md`](docs/guide.md) for user-facing
  behavior, [`com.github.copilot/extensions/jira-workbench/README.md`](com.github.copilot/extensions/jira-workbench/README.md)
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

1. In `plugin.json` at the repository root, raise `version`, for example from `1.1.0` to
   `1.2.0`. This is the version users see in `copilot plugin list` and in the
   app. Use [Semantic Versioning](https://semver.org/): a patch for fixes, a
   minor version for new behavior, a major version for changes that need users
   to act.
2. In `.github/plugin/marketplace.json`, set the entry's `version` to the same
   value and its source `ref` to the new tag:

   ```json
   "version": "<version>",
   "source": { "source": "github", "repo": "Sentry01/jira-workbench", "ref": "v<version>" },
   ```

Check the pair before you push:

```sh
node .github/scripts/check-release.mjs
```

CI runs the same check on every pull request.

A pull request that changes the shipped canvas must also raise the version. The
shipped canvas is every file under `com.github.copilot/extensions/jira-workbench/` except `test/`
and Markdown files. CI compares `plugin.json` with the base branch and fails
when the version does not rise. To check a committed branch before you push:

```sh
node .github/scripts/check-version-bump.mjs "$(git merge-base origin/main HEAD)"
```

If a change should wait for a later release, say so in the pull request; a
maintainer adds the `no-release` label, which skips this check. The `version` in
`com.github.copilot/extensions/jira-workbench/copilot-extension.json` is the extension manifest's
schema version, not the release version.

`plugin.json` follows the [Agent Plugins](https://agent-plugins.org/) format,
which requires exactly one manifest, at the plugin root: here, the repository
root. Do not add another `plugin.json` under `.github/plugin/`; tools that look
there first would read it instead, and `check-release.mjs` fails if one exists.
The Copilot app loads the canvas from `com.github.copilot/extensions/`, and
`extensions.com.github.copilot.logo` names `assets/preview.png` as the listing
image. Keep these paths; the Awesome Copilot marketplace checks them when it
reviews a release. The image is the Jira mark centered on a transparent
1280x720 background. `extensions.com.github.copilot.icon` names
`assets/logo.svg`, the same mark cropped to a square, which the Copilot app
shows in the sidebar and on the canvas tab; without it the app shrinks the
16:9 logo into that small square.

When the pull request merges, the
`release` workflow creates the matching `v<version>` tag on the merge commit and
publishes a GitHub release with notes generated from the merged pull requests.
Until the tag exists, about a minute, an update fails and the panel does not
offer the release. If the workflow fails, fix the cause and run it again from
the Actions tab; a version that is already tagged is skipped. Release tags are protected:
once created, they cannot be moved or deleted, so a broken release is fixed by
publishing a new version.

### Awesome Copilot listing

[Awesome Copilot](https://github.com/github/awesome-copilot) lists Jira Workbench
as an external plugin in its `plugins/external.json`, pinned by `version`,
`source.ref` and `source.sha`. A release here does not change that pin; a pull
request to Awesome Copilot does, and its maintainers review it after its quality
gates pass.

Listing updates are manual, separate from release CI. Use the repository's
[`update-awesome-copilot` agent](.github/agents/update-awesome-copilot.agent.md)
after publishing a release. From this repository in Copilot CLI:

```sh
copilot --agent update-awesome-copilot
```

Then ask: "Update the Awesome Copilot listing to the latest published release."
To choose a release, name its tag instead, such as `v2.4.2`.
In the Copilot app, ask: "Follow
`.github/agents/update-awesome-copilot.agent.md` to update the Awesome Copilot
listing to the latest published release."

The agent verifies the published tag and commit, checks the upstream listing
and open PRs, changes only the release pin, regenerates and validates the
marketplace, and opens or updates a fork PR. It stops without changes when the
listing already matches. Use your existing `gh` login and fork; no Actions
secret or upstream write access is required.

The full procedure is in the agent file. It follows the
[upstream guide for existing listing updates](https://github.com/github/awesome-copilot/blob/main/CONTRIBUTING.md#updating-listed-external-plugins-via-pr),
which is separate from new-plugin intake. Maintainer approval and quality gates
are still required. The listing changes only when that upstream PR merges;
the agent does not merge it or set up monitoring.

## Where things live

```text
com.github.copilot/extensions/jira-workbench/   The installable canvas; this is the product
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
assets/preview.png           The plugin listing image; docs/screenshots.mjs regenerates it
assets/logo.svg              The sidebar and canvas tab icon: the panel's Jira mark, cropped square
docs/                        Install guide, user guide, screenshots, and their generator
plugin.json                  The plugin manifest (Agent Plugins format); its version is the release version
.github/plugin/              The marketplace manifest, which pins the released version
.github/agents/              On-demand Copilot procedures, including the Awesome Copilot listing update
.github/scripts/             Release checks (the two manifests name one release, and a shipped change raises it), the stack gate and the CCR gate
.github/workflows/           CI (unit tests, browser harnesses, dependency review, private-data and release-manifest checks), the stack and CCR gates, and the release workflow
verification/                Browser harnesses and the shared synthetic fixture
AGENTS.md                    Release and docs steps for coding agents working on a pull request
```

Start with [`com.github.copilot/extensions/jira-workbench/README.md`](com.github.copilot/extensions/jira-workbench/README.md).
It documents the execution semantics, freshness rules, the read-only boundary,
and the known prototype limits, which reviewers will expect you to know.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

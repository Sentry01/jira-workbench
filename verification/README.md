# Verification harnesses

Browser checks that run the real canvas UI. They are development tools and are not
installed with the extension. There are six harnesses:

| Harness | Runs against | In CI |
| --- | --- | --- |
| [`verify-canvas.mjs`](#verify-canvasmjs-isolated-workflow) | Fake Jira, Copilot and GitHub services | Yes |
| [`verify-reconnect.mjs`](#verify-reconnectmjs-mcp-connection-resilience) | A behavioral model of the MCP runtime | Yes |
| [`verify-scope.mjs`](#verify-scopemjs-bounded-scopes-and-context) | Synthetic scoped Jira pages and cross-project parents | Yes |
| [`verify-poll.mjs`](#verify-pollmjs-unchanged-polls) | 300 synthetic issues with linked sessions | Yes |
| [`verify-scale.mjs`](#verify-scalemjs-ui-budgets-at-1000-issues) | 1,000 synthetic issues | Yes |
| [`verify-live.mjs`](#verify-livemjs-read-only-live-check) | Your real, open canvas (read-only) | No |

CI's **Browser harnesses** job runs the five synthetic harnesses on every pull request, on Linux
with Google Chrome, and uploads their screenshots as an artifact when one fails.

Install the browser driver once, from the repository root. The repository has no
`package.json`, so install it without saving, at the version CI uses:

```sh
npm install --no-save --no-package-lock --no-audit --no-fund playwright-core@1.63.0
```

If a parent directory has its own `package.json`, npm installs there instead. In that
case, install into a scratch directory and link it in for the run (`node_modules` is
git-ignored only as a directory, so remove the link before you commit):

```sh
SCRATCH=$(mktemp -d) && echo '{"name":"pw","private":true}' > "$SCRATCH/package.json"
npm install --prefix "$SCRATCH" --no-audit --no-fund playwright-core@1.63.0
ln -s "$SCRATCH/node_modules" node_modules
# ... run the harnesses ...
rm node_modules
```

All six harnesses, and the screenshot generator, need a Chromium-based browser.
They default to Microsoft Edge on macOS; set `BROWSER_EXECUTABLE` to a Chrome,
Edge, or Chromium binary anywhere else. Set `HEADED=1` to watch a run, and
`SCREENSHOT_DIR` to keep the screenshots (they go to a temporary directory by
default).

## Shared fixture

Both `verify-canvas.mjs` and [`docs/screenshots.mjs`](../docs/screenshots.mjs) build
their synthetic `DEMO` project from `fixture.mjs`, so the guide screenshots always
show the same workflow the harness proves. Change the fixture once and both follow.

## `verify-canvas.mjs`: isolated workflow

Starts the extension's own server against fake Jira, Copilot, and GitHub services in
a temporary state directory, then drives the full workflow: the execution queue,
native navigation acknowledgement, planning with warnings, implementation
acknowledgement, edit invalidation, the immutable launch snapshot, lost-response
reconciliation, the Update Jira confirmation, an expired launch request (it never
blocks Start, and clears only on a confirming second click), the default mode of
the inspector's Start button, one Jira freshness label in the bar and the
inspector, parent-key search in the hierarchy, project-scoped restoration,
keyboard focus, the freshness dots, and the narrow layout.

It then runs the WCAG 2.2 AA checks in [`accessibility.mjs`](accessibility.mjs): no
change to the `role="alert"` banner over 5 seconds while reconnecting, text contrast
of at least 4.5:1 for status badges, type icons and unverified progress steps
with the panel's own fallback colors and with the GitHub Copilot app's default
light and dark theme values (see the comment in `accessibility.mjs` for their
source), input borders of at least 3:1 and a non-color
pressed state, 24 by 24 px targets in the list, one tab stop for the list and a
skip link, ArrowLeft keeping the parent row in view, freshness details that can be
hovered and dismissed with Escape, notices added without rebuilding the others,
and keyboard focus kept (never on the page body) through pending actions, Dismiss
and a launch confirmation.

No real sessions are created and no real service is contacted.

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-canvas.mjs
```

Without `WORKBENCH_ROOT`, it loads the extension from
`$COPILOT_HOME/extensions/jira-workbench`. That folder holds the code only for a
git-clone link or a copied install; with a plugin install, set `WORKBENCH_ROOT`.

## `verify-reconnect.mjs`: MCP connection resilience

Runs the real canvas UI against the behavioral MCP runtime model in
[`test/fake-runtime.mjs`](../com.github.copilot/extensions/jira-workbench/test/fake-runtime.mjs) and
proves, with no clicks: a stopped Atlassian server is named with an
automatic-retry hint, the project loads within seconds of the server starting, a
silent token refresh never reaches the user, and a drop keeps the last good data
on screen and heals. It also proves that an expired sign-in shows one **Sign in**
action with no request storm and reloads after sign-in, and that a `needs-auth`
server shows **Sign in** and reloads once it is connected again. Nothing real is
contacted.

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-reconnect.mjs
```

It caught a real usability bug: the UI polled every 5s even while reconnecting, so a
recovery the server made in milliseconds took 5s to appear.

## `verify-scope.mjs`: bounded scopes and context

Exercises explicit JQL and saved-filter application, persisted scope, one-page
initial loading, real cursor continuation, failed-page retention and retry,
cross-project Feature and Portfolio Epic context and its accessible labels, scope
isolation, per-generation **Load more** (a background poll never drops a pending page), loaded-count labels and linked work kept
outside the loaded pages.
It writes `scoped-loading.png` from synthetic
data only. No real service is contacted.

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-scope.mjs
```

## `verify-poll.mjs`: unchanged polls

Loads 300 synthetic issues with linked sessions and proves that an unchanged
session poll is one request that carries no working set (`issues: null`) and no
tree, and that it records no DOM mutation at all in the list, the inspector or the
header's action controls (no rebuilt element and no same-value rewrite of a label
or attribute), even though every poll rewrites the sessions' observation times. It
then answers one poll with a revision the panel does not hold and checks that the
panel reads the full snapshot instead of applying it, and that a Jira change
reaches the panel on the next poll, including the row that has keyboard focus: that
row updates and keeps focus, and unchanged rows stay the same elements. No real
service is contacted.

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-poll.mjs
```

## `verify-scale.mjs`: UI budgets at 1,000 issues

Loads 1,000 synthetic issues (ten generated epics under the fixture project) and,
in both views, measures the main-thread time of a search keystroke (including the
debounced render), selecting a row, expanding a parent, ArrowDown and an unchanged
session poll. Each figure is a median after a warm-up round, checked against a
budget well above what a laptop measures. It also checks the structure on any
machine: a burst of keys renders the list once, after the pause; selecting a row
replaces only the old and the new selected row; and collapsing a parent removes its
rows without rebuilding the others. No real service is contacted.

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node verification/verify-scale.mjs
```

## `verify-live.mjs`: read-only live check

Drives your **real** canvas against real Jira and GitHub data: it verifies the project
loads, picks an issue that already has a verified PR, opens that PR natively, and
asserts the navigation was acknowledged without queuing any work.

Open the canvas first, take its URL (origin plus the `#token` fragment), and pass it:

```sh
WORKBENCH_URL='http://127.0.0.1:PORT/#TOKEN' node verification/verify-live.mjs
```

This harness exists because the isolated harness cannot see the host bridge. It
caught a real bug: the host acknowledges a PR navigation with
`Opening owner/repo#18.`, not the generic `Navigating now.`, so strict matching
marked successful navigations as failed. Fake services alone cannot catch that
kind of defect.

## `../docs/screenshots.mjs`: guide images

Regenerates every screenshot in [`docs/guide.md`](../docs/guide.md) from the same
synthetic fixture, so the guide can be republished without exposing real Jira,
session, or repository data. Run it after any UI change:

```sh
WORKBENCH_ROOT="$PWD/com.github.copilot/extensions/jira-workbench" node docs/screenshots.mjs
```

Images are written to `docs/images/`, and the plugin listing image to
`assets/preview.png`; `SCREENSHOT_DIR` overrides both destinations.

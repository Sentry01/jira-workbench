# Verification harnesses

Browser checks that run the real canvas UI. They are development tools and are not
installed with the extension. There are three harnesses:

| Harness | Runs against | In CI |
| --- | --- | --- |
| [`verify-canvas.mjs`](#verify-canvasmjs-isolated-workflow) | Fake Jira, Copilot and GitHub services | Yes |
| [`verify-reconnect.mjs`](#verify-reconnectmjs-mcp-connection-resilience) | A behavioral model of the MCP runtime | Yes |
| [`verify-live.mjs`](#verify-livemjs-read-only-live-check) | Your real, open canvas (read-only) | No |

CI's **Browser harnesses** job runs the first two on every pull request, on Linux
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

All three harnesses, and the screenshot generator, need a Chromium-based browser.
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

No real sessions are created and no real service is contacted.

```sh
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node verification/verify-canvas.mjs
```

Without `WORKBENCH_ROOT`, it loads the extension from
`$COPILOT_HOME/extensions/jira-workbench`. That folder holds the code only for a
git-clone link or a copied install; with a plugin install, set `WORKBENCH_ROOT`.

## `verify-reconnect.mjs`: MCP connection resilience

Runs the real canvas UI against the behavioral MCP runtime model in
[`test/fake-runtime.mjs`](../extensions/jira-workbench/test/fake-runtime.mjs) and
proves, with no clicks: a stopped Atlassian server is named with an
automatic-retry hint, the project loads within seconds of the server starting, a
silent token refresh never reaches the user, and a drop keeps the last good data
on screen and heals. It also proves that an expired sign-in shows one **Sign in**
action with no request storm and reloads after sign-in, and that a `needs-auth`
server shows **Sign in** and reloads once it is connected again. Nothing real is
contacted.

```sh
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node verification/verify-reconnect.mjs
```

It caught a real usability bug: the UI polled every 5s even while reconnecting, so a
recovery the server made in milliseconds took 5s to appear.

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
WORKBENCH_ROOT="$PWD/extensions/jira-workbench" node docs/screenshots.mjs
```

Images are written to `docs/images/`; `SCREENSHOT_DIR` overrides the destination.

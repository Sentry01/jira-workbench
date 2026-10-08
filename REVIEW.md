# Review instructions

Jira Workbench is a dependency-free Copilot app canvas: a Node loopback server
(`extensions/jira-workbench/lib/`) and a vanilla DOM UI (`extensions/jira-workbench/ui/`).
It reads Jira, launches Copilot sessions on explicit confirmation, and traces
issues to sessions and pull requests. Review changed lines for the six areas
below. Read `CONTRIBUTING.md` (review rules) and `SECURITY.md` (design
boundaries) for context.

## What counts as serious

Treat these as High: Jira write paths, injection or XSS, weakened server
guards, private data in the repo, a launch that can create more or fewer than
one session, a pending state shown as done, and WCAG 2.2 AA regressions.
Naming, refactors and wording are Low at most.

## Security

- The canvas is Jira read-only. Flag any new tool name or operation added to
  `READ_TOOLS` or `READ_OPERATIONS` in `lib/gateway.mjs` that can write.
- Any change to kickoff or prompt wording in `lib/model.mjs` is a security
  change. Flag text that widens delegated writes beyond moving the selected
  issue to In Progress, or a confirmed status-only Update Jira sync in one
  project.
- Jira-derived text in prompts must stay inside `<jira-context>` and go through
  the `untrusted()` encoder. Flag Jira text concatenated into instructions.
- In the UI, Jira text must be set with `textContent` or `el()`. Flag
  `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, or
  building `href`/`src` from Jira data without scheme checks.
- `lib/server.mjs` must keep: bind to `127.0.0.1`, Host check, constant-time
  token compare, Origin check, and per-route body caps. Flag any new route that
  skips them.
- Child processes use `execFile` with an argument array. Flag `exec`,
  `shell: true`, or arguments built from unvalidated input; validate with
  `lib/validate.mjs` first.
- State files stay `0700`/`0600` and are written via temp file plus `rename`.
- Flag Jira domains, project keys, cloud IDs, real repo names, tokens, emails
  or absolute user paths in code, tests, fixtures, docs or screenshots.
- Workflows: least-privilege `permissions`, `persist-credentials: false` where
  the job does not push, no `pull_request_target` with checkout of PR code.

## Functionality

- New behavior needs a focused `node:test` case in
  `extensions/jira-workbench/test/`. Panel display rules belong in
  `lib/view-model.mjs` with a unit test, not in `ui/app.mjs`.
- Every Copilot runtime call (tools, MCP servers, sign-in, Jira reads,
  navigation) must be wrapped in `bounded()` from `lib/runtime.mjs`.
- A confirmed launch creates exactly one session. Flag retries of uncertain
  creations, missing receipts, or a pending request rendered as completed.
- Links between an issue, a session and a PR need evidence. Flag matching by
  similar titles or branch names.
- No new runtime dependencies; the extension must run from a plain `cp -R`.
- If `.github/plugin/plugin.json` changes version, `marketplace.json` must
  change `version` and `ref` to the same `v<version>`.
- A change to `extensions/jira-workbench/` outside `test/` and Markdown must
  raise that version, unless the PR explains why it should not release. Check
  the size of the raise: patch for fixes, minor for new behavior, major when
  users must act.
- When behavior changes, `docs/guide.md` or `extensions/jira-workbench/README.md`
  must change with it. Flag docs that the diff makes wrong.

## Usability

- Every async action needs visible loading, empty, error and stale states.
  Error text says what happened and what the user can do next.
- Destructive or irreversible actions (clear, launch, Update Jira) need an
  explicit confirmation step. Keep the existing two-click clear pattern.
- Do not move or relabel controls without updating the guide screenshots
  (`docs/screenshots.mjs`) and `docs/guide.md`.
- Labels and messages use plain words and match terms already used in the UI
  and guide.

## Accessibility (WCAG 2.2 AA)

- Use native `button`, `input`, `select`. Flag clickable `div`/`span`, and
  `tabindex` greater than 0.
- Interactive elements need an accessible name. Icon-only buttons need
  `aria-label`.
- Keep ARIA state in sync with the UI: `aria-expanded`, `aria-selected`,
  `aria-pressed`, `aria-current`, and tree `aria-level`/`aria-posinset`/`aria-setsize`.
- After a re-render, focus must stay on or return to a sensible element. Flag
  `replaceChildren` on a focused container with no focus restore.
- Status changes go to the existing `role="status"`/`aria-live` regions; do
  not make them chatty (no announcements per poll).
- State is never conveyed by color alone. Text contrast 4.5:1, UI and focus
  indicators 3:1, in both light and dark themes.
- Targets at least 24 by 24 CSS px. Respect `prefers-reduced-motion`.

## Performance

- Projects can hold up to 10,000 issues. Flag per-item DOM writes in loops
  (build arrays, then one `replaceChildren`), O(n^2) lookups over issues, and
  full re-renders on every poll when nothing changed.
- Flag new timers or intervals without cleanup, polling while the document is
  hidden, and listeners added on every render.
- Server handlers must not use synchronous fs calls or unbounded reads.
- Cache and state writes stay debounced; flag writes on every keystroke or
  scroll event.

## Styling

- Use the tokens in `ui/style.css` `:root` (`--surface`, `--ink`, `--muted`,
  `--border`, `--tint`, `--accent`, `--soft-accent`). Flag new hard-coded
  colors outside `:root` fallbacks.
- New font sizes use host tokens or `rem`, not new px values.
- Changes must work in light and dark (`color-scheme: light dark`) and at the
  1000px and 620px breakpoints.
- Markdown: no emojis, no em dashes (use " - "), no Unicode arrows or ellipses,
  no marketing phrasing.

## Do not report

- Anything CI or settings already enforce: test pass/fail, manifest agreement,
  committed `artifacts/`, home paths, unpinned actions.
- Binary images in `docs/images/` and synthetic fixture data in
  `verification/fixture.mjs`.
- Pre-existing issues on lines this PR does not change, including the existing
  px font sizes.
- Formatting and import order.

## How to report

- Cite `file:line` for every finding and say why it breaks a rule above.
  Do not infer behavior from names alone.
- At most five Low findings per review; summarize the rest as a count.
- On re-reviews after a push, report only new Medium or High findings.

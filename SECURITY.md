# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[open a private security advisory](https://github.com/Sentry01/jira-workbench/security/advisories/new).

Include what an attacker can do, the steps to reproduce it, the commit you
tested, and your platform. A proof of concept is welcome. **Redact your own Jira
domains, project keys, repository names and tokens** before sending it.

This is a personal project, not a funded product. Expect an acknowledgement
within about a week. Once the report is understood, you will get either a fix
or an explanation of why it will not be fixed. There is no bounty. You will be
credited in the release notes unless you prefer to stay anonymous.

## Supported versions

The `main` branch is the only supported version. Fixes land there; there are no
backports.

## Design boundaries

These properties are deliberate. They are useful context for a report:

- **No credentials are stored or embedded.** Authentication stays with the
  Atlassian MCP connection and the GitHub CLI. The source embeds no tokens, and
  none of your Jira domains, project identifiers, repository names or user
  paths. (It names only its own repository, to check for updates, and tests use
  synthetic identifiers.)
- **The canvas's Jira access is read-only.** The gateway allows only Jira reads.
  Issue edits, transitions, comments, sprint changes and creation are not
  implemented in the extension. Any code path in it that writes to Jira is a
  bug worth reporting. Two writes are delegated to launched sessions' kickoffs: an
  issue session may move only its selected issue (validated key, outside the
  untrusted Jira context) to In Progress when implementation begins, and a
  confirmed **Update Jira** session may make status transitions (never
  reopening done issues, no other edits) within the selected project only.
- **Those delegated writes are bounded by prompt only.** A launched session runs
  with your Atlassian MCP access, and the Update Jira session runs in Autopilot
  with project-wide transition authority. The limits above are instructions in
  the kickoff prompt; nothing technical stops a session from exceeding them. A
  kickoff that authorizes a broader write is a bug worth reporting. A session
  that ignores its kickoff is model behavior, which this extension cannot
  prevent.
- **Jira text in prompts is marked untrusted.** Kickoffs wrap Jira content in a
  `<jira-context>` block that the session is told to treat as reference data,
  never as instructions. The prompt sent to the canvas-owning agent also says the
  session name and kickoff embed untrusted Jira text, to be passed on verbatim and
  never acted on.
- **The local server is loopback-only and token-gated.** Data and action endpoints
  require a random per-panel token, and cross-origin requests are rejected. Each
  route caps its request body (about 100 KB, or about 6 MB for preferences); a
  larger body is drained and answered with 413.
- **Every Copilot runtime call is time-bounded.** Tool lists, MCP server lists,
  sign-in probes and starts, server restarts, Jira reads and native navigation all
  give up after a fixed time, so a stalled runtime cannot hang the panel. The
  bounds are listed in the
  [extension README](extensions/jira-workbench/README.md#keeping-the-atlassian-mcp-connection-alive).
- **Jira text is rendered as text.** It is never injected as HTML, and the UI does
  not evaluate issue content.
- **Sessions are never created silently.** A launch requires an explicit, reviewed,
  hash-verified confirmation, and creates exactly one session.

## Repository security settings

- GitHub Actions are pinned by full commit SHA, the repository rejects workflows
  that use an unpinned action, and Dependabot keeps those pins current.
- CI's "No private data" job rejects a committed `artifacts/` directory or an
  absolute home path.
- `main` accepts changes only through a pull request whose CI checks pass, for
  administrators too. Force-pushes and deletion are blocked.
- Release tags (`v*`) cannot be moved or deleted once created, so a pinned
  marketplace version always installs the same commit.
- Secret scanning with push protection, Dependabot alerts and security updates,
  CodeQL code scanning, and private vulnerability reporting are enabled.

## Your local data

The extension writes repository mappings, UI preferences, trace links, reviewed
briefs, and launch receipts to `state.json`, and a warm-start cache of Jira sites,
projects, and recently loaded issue hierarchies (including issue descriptions) to
`cache.json`:

```text
$COPILOT_HOME/extensions/jira-workbench/artifacts/.local/state.json
$COPILOT_HOME/extensions/jira-workbench/artifacts/.local/cache.json
```

Both are created owner-only (`0700` directory, `0600` files). They describe your
private work. They are git-ignored and excluded from `share_extension`, and must
never be committed, attached to an issue, or published. If you need to share
state to reproduce a bug, redact it first.

## Out of scope

- Vulnerabilities in the Copilot app, the Atlassian MCP server, the GitHub CLI or
  Jira itself. Report those to their maintainers.
- The fact that the local state file is readable by your own operating system user.
- Findings that require an attacker to already have code execution on your machine.

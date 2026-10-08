# Install Jira Workbench

This guide takes you from nothing to a working Jira Workbench panel in about
five minutes. You install it once from the terminal, then use it in the GitHub
Copilot app.

Already installed? See the [user guide](guide.md).

---

## Before you start

| You need | Why | How to check |
| --- | --- | --- |
| The **GitHub Copilot app** | The Workbench is a canvas (a side panel) in the app | You can ask Copilot to open a canvas |
| The **Copilot CLI** (`copilot`) | It installs plugins and adds MCP servers | `copilot --version` ([install the CLI](https://docs.github.com/copilot/how-tos/copilot-cli)) |
| The **GitHub CLI** (`gh`), signed in | The Workbench reads pull requests and checks with it | `gh auth status` |
| A **Jira Cloud** site you can browse | The Workbench reads it through Atlassian's MCP server | You can open your projects at `https://<your-site>.atlassian.net` |
| Your code repository added as a **project in the Copilot app** | Launched sessions run in that repository | It appears in the app's project list |

---

## 1. Connect Atlassian to Copilot (once)

The Workbench reads Jira through Atlassian's Rovo MCP server. Connect it in
either of two ways, or both:

- **The Atlassian Rovo connector in the Copilot app.** This is Atlassian's
  official route. Turn the connector on in the app; the app signs it in.
- **An Atlassian MCP server in Copilot:**

  ```sh
  copilot mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp
  ```

  Check it with `copilot mcp get atlassian`. The output should show `Type: http`
  and the URL above. The server name must contain `atlassian` or `jira`: the
  Workbench uses the name to find the server, report its state, and offer
  sign-in.

With both on, every Jira tool is offered twice. The Workbench reads from the one
that is connected, prefers the app's connector when both are, and switches to
the other if one drops. If you also have the older v1 endpoint
(`https://mcp.atlassian.com/v1/mcp`), you can disable it with
`copilot mcp disable <its-name>`.

You sign in to an MCP server later with the panel's **Sign in to Atlassian**
button, or by running `/mcp auth atlassian` in any Copilot session. If the
connector needs sign-in, the panel asks you to reconnect it in the Copilot app.

## 2. Install the plugin

The repository is its own plugin marketplace. Register it, then install the
plugin:

```sh
copilot plugin marketplace add Sentry01/jira-workbench
copilot plugin install jira-workbench@jira-workbench
```

Expected output:

```text
Marketplace "jira-workbench" added successfully.
Plugin "jira-workbench" installed successfully.
```

## 3. Start a new Copilot session

Open a new session in the Copilot app. A session loads its plugins when it
starts, so the session you installed from will not see the canvas, even after
you ask it to reload extensions.

## 4. Open the panel

In the new session, ask:

> Open the jira-workbench canvas

Then:

1. **Sign in.** If the panel shows **Atlassian needs you to sign in**, press
   **Sign in to Atlassian** and finish in your browser. The panel reloads by
   itself.
2. **Pick your Jira site and project** in the first two pickers.
3. **Pick the Copilot repository** in the third picker. The Workbench remembers
   this mapping, so you set it once per Jira project.

The [user guide](guide.md#3-open-it-and-connect-three-things) shows this step
with screenshots.

---

## Check that it worked

- `copilot plugin list` includes `jira-workbench@jira-workbench` and its version,
  such as `(v1.2.1)`. The Copilot app's plugin list shows the same version.
- In the new session, ask Copilot to list loaded extensions. There is exactly
  one `jira-workbench` entry, with the ID `plugin:jira-workbench:jira-workbench`.
- The small label under the panel names the build. For a plugin install, it
  shows the version, commit and date when your copy matches the latest release,
  such as `v1.2.1 · 1a2b3c4 · 2026-10-08`, and the version and a tree hash
  otherwise, such as `v1.2.1 · tree 5d6e7f8`. (A git clone always shows its own
  commit and date, even when it is behind `main`.)
- The connection bar shows a green **Jira** dot, and your project's work appears.

---

## Updating

The plugin installs releases, not the latest `main`. Each release has a version
number, which `copilot plugin list` and the app's plugin list show, and release
notes on the repository's
[Releases page](https://github.com/Sentry01/jira-workbench/releases). A merged
pull request reaches you when the next release includes it.

While a panel is open, the Workbench checks for a new release every ten minutes.
When it finds one, a banner offers **Update & reload**, which updates the plugin
and restarts the panel on the new release.

To update from the terminal instead:

```sh
copilot plugin update jira-workbench@jira-workbench
```

The command reports the old and new version, or says `already at latest`. In the
Copilot app, open the plugin's **...** menu and choose **Update**.

Sessions that are already running keep the old build until they reload. New
sessions start on the new build.

## Switching from a git clone or a copied install

Earlier instructions linked a git clone into your Copilot home, usually at
`~/.copilot/extensions/jira-workbench`. Keep only one install, because two
register the `jira-workbench` canvas twice. Your saved mappings, trace links and
launch receipts are inside that link's `artifacts/.local`, so move them before
you switch.

From a macOS or Linux shell:

```sh
COPILOT_DIR="${COPILOT_HOME:-$HOME/.copilot}"
LINK="$COPILOT_DIR/extensions/jira-workbench"
CLONE=$(readlink "$LINK")      # the clone's extensions/jira-workbench folder
rm "$LINK"                      # removes only the link; the clone is untouched
mkdir -p "$LINK/artifacts"
cp -Rp "$CLONE/artifacts/.local" "$LINK/artifacts/"
```

Then install the plugin (step 2) and start a new session (step 3). The folder
you just created holds only your saved data. The plugin's code lives in the
`installed-plugins/` folder of your Copilot home.

For a copied install (a real folder, not a link), move its `artifacts/` folder
aside, delete the install folder, recreate it, and move `artifacts/` back in.

## Uninstalling

```sh
copilot plugin uninstall jira-workbench@jira-workbench
copilot plugin marketplace remove jira-workbench
```

Your saved data stays in your Copilot home's
`extensions/jira-workbench/artifacts/.local/` folder. Delete that folder to
remove it too.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `marketplace add` fails with "not found" | Check the name: `Sentry01/jira-workbench`. If it is right, check that git can reach GitHub: `git ls-remote https://github.com/Sentry01/jira-workbench` |
| Copilot cannot find the `jira-workbench` canvas | Start a new session (step 3). If it is still missing, check that `copilot plugin list` includes `jira-workbench@jira-workbench` |
| The canvas is missing from every session and repository, and the extension list shows `plugin:jira-workbench:jira-workbench` as disabled | Copilot keeps an extension disabled after the plugin is uninstalled and installed again. Remove `plugin:jira-workbench:jira-workbench` from `extensions.disabledExtensions` in `~/.copilot/settings.json` (or `$COPILOT_HOME/settings.json`), then start a new session. Reloading extensions in a running session does not pick up the change |
| The canvas appears twice, or behaves like an older build | An old git-clone link or copy is still in `~/.copilot/extensions/jira-workbench`. Follow [Switching from a git clone](#switching-from-a-git-clone-or-a-copied-install) |
| `copilot plugin update` fails just after a release is merged | The release's tag is created by a workflow a minute or two after the merge. Try again shortly. The panel does not offer the release until its tag exists |
| "Atlassian needs you to sign in" | Press **Sign in to Atlassian**, or run `/mcp auth <server-name>`. If the panel says to reconnect the Atlassian connector, reconnect it in the Copilot app |
| No Jira sites listed, or "... is not offered" | Check that the Atlassian Rovo connector is on in the Copilot app, or that an Atlassian MCP server is enabled and connected: `copilot mcp list`. An MCP server's name must contain `atlassian` or `jira` |
| "... is ambiguous ... Disable the duplicate Jira MCP server" | Copilot offered the same Jira tool from several servers without saying which server offers each one. Disable all but one Atlassian server (`copilot mcp disable <name>` for a CLI server), then start a new session |
| No repositories in the third picker | Add your code repository as a project in the Copilot app |
| Pull requests never appear in the trace | Run `gh auth status`. The Workbench reads pull requests with the GitHub CLI |

For problems after setup, see [When something looks wrong](guide.md#10-when-something-looks-wrong)
in the user guide.

---

## Where your data lives

The Workbench keeps repository mappings, view preferences, trace links, reviewed
briefs and launch receipts in
`~/.copilot/extensions/jira-workbench/artifacts/.local/state.json`. A disposable
warm-start cache sits next to it in `cache.json`. If you set `COPILOT_HOME`,
both live under that folder instead of `~/.copilot`.

Both files describe your private work. Never commit, share or attach them. The
canvas only reads Jira; status changes are made by the Copilot sessions you
launch. See [SECURITY.md](../SECURITY.md).

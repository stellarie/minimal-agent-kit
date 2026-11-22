# Install guide for agents

Follow these steps in order. Stop and report to the human when a step fails.
Do not skip a check.

## 1. Check requirements

Run each command. Each must print a version. Keep `PY` for later steps.

```bash
PY=$(command -v python3 || command -v python)
"$PY" --version
node --version
dot -V
git --version
```

- Python must be 3.9 or later.
- Node must be 22.18 or later. The guard hook and the lounge core run on Node. The core runs `node src/main.ts`, and only Node 22.18 or later strips types by default. If `node` is missing, ask the human before you install it.
- If `dot` is missing, ask the human before you install Graphviz:
  - Debian or Ubuntu: `sudo apt-get install -y graphviz`
  - macOS: `brew install graphviz`
  - Windows: `winget install Graphviz.Graphviz`, or install it in WSL.

## 2. Get the kit

Ask the human for the repository URL or local path. Then:

```bash
git clone <url> minimal-agent-kit
cd minimal-agent-kit
"$PY" tools/sync.py --check
```

The check must exit 0. If it fails, report it. Do not edit `claude/` or `codex/` by hand.

## 3a. Install for Claude Code

```bash
claude plugin marketplace add <path-to-minimal-agent-kit>
claude plugin install minimal-agent-kit@minimal-agent-kit
```

Tell the human to restart Claude Code. Hooks load at session start.

## 3b. Install for Codex

Back up existing files first. Never overwrite a file without a backup.

```bash
mkdir -p ~/.codex/skills
[ -f ~/.codex/AGENTS.md ] && cp ~/.codex/AGENTS.md ~/.codex/AGENTS.md.bak
cp codex/AGENTS.md ~/.codex/AGENTS.md
cp -r codex/skills/. ~/.codex/skills/
```

If `~/.codex/AGENTS.md` had content, show the human the backup. Ask whether to merge the old rules in.

Copy the guard, then add the hook. Back up `~/.codex/config.toml` first.

```bash
mkdir -p ~/.codex/kit
cp -r codex/guard codex/ste codex/verify ~/.codex/kit/
cp ~/.codex/config.toml ~/.codex/config.toml.bak
```

Append this block to `~/.codex/config.toml`. On Windows, replace `<home>` with the home path, with forward slashes:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = 'node "$HOME/.codex/kit/guard/guard.js"'
command_windows = 'node "<home>/.codex/kit/guard/guard.js"'
timeout = 10
statusMessage = "Checking command with guard"
```

Codex skips a new hook until the human trusts it. Tell the human to open `/hooks` in the CLI, or **Settings > Hooks** in the app. [codex/hooks.md](codex/hooks.md) describes the hook.

## 3c. Install agent-memory (optional)

Ask the human first. It needs Node 22.18 or later, and it stores memories in `~/.agent-memory`.

- Claude Code: `claude plugin install agent-memory@minimal-agent-kit`.
- Codex: add the kit as a local marketplace in `~/.codex/config.toml`, then enable the plugin:

```toml
[marketplaces.minimal-agent-kit]
source_type = "local"
source = '<path-to-minimal-agent-kit>'

[plugins."agent-memory@minimal-agent-kit"]
enabled = true
```

Tell the human to restart, then trust the plugin hooks in **Settings > Hooks** or `/hooks`.

## 3d. Install the lounge (optional, Windows only)

Ask the human first. The lounge is a desktop app. It runs Claude Code and Codex in chat threads. It needs Windows, Node 22.18 or later, and at least one of the two runtimes.

The release has two zips, built by `python tools/release.py` into `dist/`:

| Zip | Holds |
|---|---|
| `minimal-agent-kit-<ver>.zip` | The kit only. |
| `minimal-agent-kit-lounge-<ver>-windows.zip` | The kit and the lounge. |

The lounge zip has the same layout as the repo. Kit files sit at the zip root. The lounge sits under `lounge/`: `lounge/agent-lounge.exe`, `lounge/core/` with its production `node_modules`, `lounge/ui/dist/`, `lounge/plugins/`, and `lounge/skills/`.

To install the lounge:

1. Check that Node 22.18 or later is on `PATH`. The app starts the core with it.
2. Unzip `minimal-agent-kit-lounge-<ver>-windows.zip` into a new folder.
3. Run `lounge/agent-lounge.exe`. It starts the core from `lounge/core/` beside it.
4. The core keeps its data in `%USERPROFILE%\.agent-lounge`. Set `AGENT_LOUNGE_HOME` to use another folder.
5. For Codex, tell the human to click **Sign in to Codex** in the app. Never copy `~/.codex/auth.json`.

The lounge runs each runtime in isolation. It loads none of your own skills, plugins, `CLAUDE.md`, or `AGENTS.md`. It copies the skills `wiki` and `ste` to `<home>\skills` on the first start. It never overwrites a skill that you edited.

The bundled plugin `kit-workflow` adds the full kit workflow skill and its verify scripts. It stays off until you turn it on in the plugin list, and it needs Python 3 on the `PATH`.

To build the zips from source, you need the Rust toolchain. Build the three parts first:

```bash
(cd lounge/app && npm ci && npm run tauri build)
(cd lounge/core && npm ci)
(cd lounge/ui && npm ci && npm run build)
"$PY" tools/release.py
```

`release.py` always writes the kit zip. It stops with an error when `agent-lounge.exe`, `lounge/ui/dist`, or `lounge/core/node_modules` is missing, and then it writes no lounge zip. See [lounge/docs/architecture.md](lounge/docs/architecture.md).

The lounge zip also holds `lounge/update.pub`, the public key that checks updates. `python tools/release.py --publish --key <secret key path>` signs both zips with minisign and creates the GitHub release. It stops when `lounge/update.pub` is not tracked. Make the key once with `minisign -G -p lounge/update.pub -s <secret key path>` and commit the public key.

### Update the lounge

The lounge checks GitHub for a newer signed release at start and every 6 hours. An update never starts without a click.

1. A banner shows **Update <ver> available**. Click **Download**. The lounge verifies the signature with `lounge/update.pub`.
2. Click **Restart to update**. The app swaps the install and starts the new version.
3. If the swap fails, the app restores the old install. Your data in `%USERPROFILE%\.agent-lounge` stays as it was.

Set `update.check` to `false` in `config.json` to turn the check off. The key is `{"update": {"check": false}}`.

## 4. Verify

Run the guard on one destructive and one safe command:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node claude/guard/guard.js; echo
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | node claude/guard/guard.js; echo
```

Expected: the first line holds `"permissionDecision":"deny"`. The second line is empty, because the guard prints nothing for a safe command.

For Claude Code, after the restart:

- The session context shows the kit rules.
- Run the Bash call `git reset --hard --help`. It is harmless, but it matches a deny rule. Expect a `guard: git reset --hard discards work` message.
- Never test the hook with a real destructive command.

## 4b. Relax the guard for one session (optional)

Only the human does this. Never create the file yourself.

1. The human finds the session id. It is the `session_id` field of the hook event.
2. The human creates an empty file `%USERPROFILE%\.agent-kit\guard-relax\<session id>` by hand.
3. In that session, a guard ask prints nothing. The harness decides: in bypass mode the call runs, and in default mode the harness prompts.
4. A guard deny stays a deny.
5. To end the relax, the human deletes the file or starts a new session.

## 5. Set up a project (optional)

In a project that uses the kit, ignore the `.kit/` folder:

```bash
grep -qx '.kit/' .gitignore 2>/dev/null || echo '.kit/' >> .gitignore
```

If `WIKI_ROOT` is unset or blank, create the default wiki in the project:

```bash
mkdir -p docs/wiki
printf '# Wiki index\n' > docs/wiki/index.md
```

If `WIKI_ROOT` is set, skip that block. `WIKI_ROOT` is an absolute path or starts with `~`. The wiki is `$WIKI_ROOT/<name>/`. `<name>` is `WIKI_NAME`, or the name of the project directory when `WIKI_NAME` is unset or blank. `WIKI_NAME` is a plain folder name, not a path. Use the `wiki` skill to create `index.md` in that folder.

The session hook uses `WIKI_NAME` or the name of the directory where the session starts.

Then use the `wiki` skill to create `standards.md`, `architecture.md`, and `libraries.md`.

## 5b. Set up the spike sandbox (optional, once)

Ask the human first. It needs Node 22.18 or later and network access. Ask the human for the destination, outside every project:

```bash
"$PY" tools/sandbox.py <dest>
```

The command makes a git repo at `<dest>`, installs pytest and the jest packages, and runs the seed tests. Expect `sandbox ready: <dest>`.
It refuses a destination that is not empty. Reuse the sandbox for each task.

## 6. Report

Report to the human:

- each step: passed, failed, or skipped, with the reason
- which target you installed: Claude Code, Codex, or both
- whether you installed the lounge
- any backup file you created

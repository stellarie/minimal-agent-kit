# Install guide for agents

Follow these steps in order. Stop and report to the human when a step fails.
Do not skip a check.

## 1. Check requirements

Run each command. Each must print a version. Keep `PY` for later steps.

```bash
PY=$(command -v python3 || command -v python)
"$PY" --version
dot -V
git --version
```

- Python must be 3.9 or later.
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
command = 'python3 "$HOME/.codex/kit/guard/guard.py"'
command_windows = 'python "<home>/.codex/kit/guard/guard.py"'
timeout = 10
statusMessage = "Checking command with guard"
```

Codex skips a new hook until the human trusts it. Tell the human to open `/hooks` in the CLI, or **Settings > Hooks** in the app.

## 3c. Install agent-memory (optional)

Ask the human first. It needs Node 22.13 or later, and it stores memories in `~/.agent-memory`.

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

## 4. Verify

Run the guard on one destructive and one safe command:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | "$PY" claude/guard/guard.py; echo "exit=$?"
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | "$PY" claude/guard/guard.py; echo "exit=$?"
```

Expected: `exit=2` for the first command, `exit=0` for the second.

For Claude Code, after the restart:

- The session context shows the kit rules.
- Run the Bash call `mkfs --version`. It is harmless, but it matches a deny pattern. Expect a `guard: denied` message.
- Never test the hook with a real destructive command.

## 5. Set up a project (optional)

In a project that uses the kit:

```bash
wiki="${WIKI_ROOT:-$HOME/notes/wiki}/$(basename "$PWD")"
mkdir -p "$wiki"
printf '# Wiki index\n' > "$wiki/index.md"
grep -qx '.kit/' .gitignore 2>/dev/null || echo '.kit/' >> .gitignore
```

Then use the `wiki` skill to create `standards.md`, `architecture.md`, and `libraries.md`.

## 5b. Set up the spike sandbox (optional, once)

Ask the human first. It needs Node 22 or later and network access. Ask the human for the destination, outside every project:

```bash
"$PY" tools/sandbox.py <dest>
```

The command makes a git repo at `<dest>`, installs pytest and the jest packages, and runs the seed tests. Expect `sandbox ready: <dest>`.
It refuses a destination that is not empty. Reuse the sandbox for each task.

## 6. Report

Report to the human:

- each step: passed, failed, or skipped, with the reason
- which target you installed: Claude Code, Codex, or both
- any backup file you created

# Codex guard hook

The kit guard runs in Codex as a `PreToolUse` hook. The hook runs Node. It needs Node 22.18 or later.

## Command

The hook command is:

```text
node "<home>/.codex/kit/guard/guard.js"
```

- `<home>` is your home path, with forward slashes.
- [INSTALL.md](../INSTALL.md) step 3b copies `codex/guard/` to `~/.codex/kit/guard/`.
- `codex/guard/` is a copy of `core/guard/`. Edit `core/guard/`, then run `python tools/sync.py`.

## Config

Add this block to `~/.codex/config.toml`:

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

Codex skips a new hook until you trust it. Open `/hooks` in the CLI, or **Settings > Hooks** in the app.

## What the guard does

- The guard reads one hook event on stdin.
- Codex names its shell tools `shell`, `exec_command`, and `local_shell`. The guard reads each of them as a `Bash` call.
- The guard prints a JSON decision: `deny`, `ask`, or nothing for a safe command.
- The guard denies when it cannot read the event or judge the command.
- An `ask` in a mode that cannot prompt becomes a `deny`.

## In the lounge

The lounge does not use `~/.codex/config.toml`. Each Codex turn gets the hook through a `-c hooks.PreToolUse=...` override, and the flag `--dangerously-bypass-hook-trust`. The hook entry is:

```toml
matcher = "^Bash$"
command = 'node "<kit>/core/guard/guard.js"'
timeout = 600
```

- The timeout is 600 seconds. The guard waits up to 580 seconds for the owner to decide an approval card.
- `LOUNGE_GUARD_URL` and `LOUNGE_GUARD_TOKEN` are set in the turn. The guard then sends each call that the rules do not block to the lounge core. The core decides.
- A second entry, with the matcher `^collaboration`, denies Codex native subagents. The lounge starts child threads instead.
- The lounge runs Codex with `CODEX_HOME` set to `codex-home` in the lounge home (`%USERPROFILE%\.agent-lounge` by default). Your `~/.codex` files do not load.

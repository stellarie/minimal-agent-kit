<div align="center">

# minimal-agent-kit

**A small, token-cheap rule kit that keeps coding agents careful and honest**

English · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

`minimal-agent-kit` 

</div>

## What is this?

`minimal-agent-kit` gives Claude Code and Codex one workflow, one memory model, and one safety net.

- **Rules and skills**: a design, implement, review, and close workflow, with two human approval gates, BDD scenarios, and a Graphviz diagram.
- **Hooks**: a guard that denies or asks about destructive shell commands, also in bypass mode, and a check for Simplified Technical English (STE).
- **Checks**: scripts that test the JSON plan and the changed Python and JS code against it. A reusable sandbox tests risky assumptions before you write code.

You see the rules and your project wiki index at the start of each session. Then the agent asks you questions before it writes code.

Guiding question: *what is the minimal amount of code and impact that leads to the solution?*

<p align="center"><img src="docs/architecture.png" alt="The kit loads into Claude Code or Codex and reads and writes the project wiki and the memory store." width="860"></p>

## Requirements

- Python 3.9 or later, on `PATH` as `python3` or `python`.
- Graphviz (`dot`), for design diagrams.
- Node 22.13 or later, for the guard hook, the JS checks, the spike sandbox, and the optional `agent-memory` plugin.
- Claude Code, or the Codex app or CLI.

## Install (๑•̀ㅂ•́)و✧

### 1. Add the marketplace (Claude Code)

```bash
claude plugin marketplace add stellarie/minimal-agent-kit
```

Claude Code lists the `minimal-agent-kit` marketplace.

### 2. Install the kit (Claude Code)

```bash
claude plugin install minimal-agent-kit@minimal-agent-kit
```

Restart Claude Code. The session context then starts with `# Agent rules`.

### 3. Install the memory plugin (optional)

```bash
claude plugin install agent-memory@minimal-agent-kit
```

After a restart, the session context shows a memory index. The store is `~/.agent-memory`.

### 4. Install for Codex

Codex needs files copied and a hook added to `~/.codex/config.toml`. Follow [INSTALL.md](INSTALL.md). An agent can run it step by step.

### 5. Set up the spike sandbox (optional, once)

```bash
python tools/sandbox.py <empty-dir>
```

The command needs network access. It prints `sandbox ready: <empty-dir>`. Each task then uses a `spike/<task>` branch there.

## Skills and hooks

| Name | Kind | What it does |
|---|---|---|
| `workflow` | skill | Design, implement, review, close. Each phase has numbered substeps and an output template. |
| `wiki` | skill | Keeps long-term project memory in `$WIKI_ROOT/<name>/`, or in `docs/wiki/` when `WIKI_ROOT` is unset. Fixed page format. |
| `ste` | skill | The STE writing rules for chat and files. |
| `style` | skill | Grammar, punctuation, composition, and word-choice rules for docs, comments, and commit text. |
| `verify/` | scripts | Check the plan file, its proofs, and its design diagram, check the changed Python and JS code against the plan, run the project's own check tools, and prove each changed hunk is needed by a test. They also check a wiki folder against the wiki format. |
| `tools/sandbox.py` | script | Sets up a reusable spike sandbox (pytest, jest, Express, React) with fault mocks, once. |
| `SessionStart` | hook | Loads the rules and the wiki `index.md`. |
| `PreToolUse` | hook | Runs the guard on each `Bash` and `PowerShell` call. |
| `PostToolUse` | hook | Runs the STE check on each Markdown file the agent writes. |

A round trip with the guard:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node claude/guard/guard.js
```

The guard prints a JSON decision with `"permissionDecision":"deny"` and the reason. A safe command, such as `git status`, prints nothing, so the agent keeps its own permission prompts. A risky but common command, such as `git clean -fdx`, gets `"ask"`.

## Safety (｀ω´)ゞ

The kit does not give the agent new power. The guard only removes power. It does not sandbox the agent.

1. The guard reads the command as tokens and checks each part. It denies these:
   - `rm` on a root, home, or drive path.
   - `git reset --hard`, any force push, and a push to `main` or `master`.
   - `DROP DATABASE` sent to `psql`, `mysql`, `sqlite3`, or `sqlcmd`.
2. It asks about these:
   - `rm -r` outside a scratch folder, and `git clean -f`.
   - Disk tools such as `mkfs`, and `dd` to a device.
   - Encoded or piped shell text.
   - Reads of secret files such as `.env` and `.ssh`.
3. It checks commands inside `sh -c`, `bash -c`, `pwsh -Command`, and similar wrappers again.

An ask opens the normal approval prompt. In `-p`, `bypassPermissions`, and `dontAsk` mode no prompt can open, so the guard turns an ask into a deny.

The guard matches command text. A script that builds a command at run time can get past it. If Node is missing, the hook fails and Claude Code runs the command anyway.

The review phase sends the diff to a subagent. The author of a change never reviews its own work.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Guard rules | `core/guard/rules.js` | Deny, ask, and allow rules for shell commands |
| Review model | `core/skills/workflow/review.md` | Opus 5.5 at medium on Claude Code, Sol 6.1 at light on Codex |
| Project wiki | `WIKI_ROOT`, `WIKI_NAME` | `docs/wiki/` in your project. With `WIKI_ROOT` set, an absolute path or one that starts with `~`: `$WIKI_ROOT/<WIKI_NAME or project directory name>/`. The `wiki` skill creates it |
| Memory store | `AGENT_MEMORY_HOME` | `~/.agent-memory` |

`WIKI_NAME` is a plain folder name, not a path. The session hook uses `WIKI_NAME` or the name of the directory where the session starts.

## Develop

Edit only `core/`. Then copy it into the targets:

```bash
python tools/sync.py
```

```bash
python tools/sync.py --check
```

```bash
python -m unittest discover -s tests
```

`tools/vendor_memory.py` generates `memory/`. Do not edit it by hand.

```bash
cd memory && npm test
```

## License

MIT © stellarie. Made with ♡

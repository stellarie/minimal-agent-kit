<div align="center">

# ♡ minimal-agent-kit ♡

**一套小巧、省令牌的规则套件，让编程代理谨慎又诚实~**

[English](README.md) · 简体中文 · [繁體中文](README.zh-TW.md)

`minimal-agent-kit` (｡•̀ᴗ-)✧

</div>

## 这是什么？

`minimal-agent-kit` 为 Claude Code 和 Codex 提供一套工作流、一种记忆模型和一张安全网。

- **规则与技能**：设计、实现、审查、收尾的工作流，含两道人工批准关卡、BDD 场景和 Graphviz 图。
- **钩子**：一个拒绝破坏性 shell 命令的 guard（在绕过模式下也有效），以及简化技术英语（STE）检查。
- **检查**：用脚本对照 JSON 计划检查计划本身和改动的 Python、JS 代码。一个可复用的沙箱在写代码前测试有风险的假设。

每个会话开始时，你会看到规则和项目 wiki 索引。之后代理会先向你提问，再写代码。

指导问题：*用最少的代码和影响，怎样达成目标？*

<p align="center"><img src="docs/architecture.zh-CN.png" alt="套件加载到 Claude Code 或 Codex 中，并读写项目 wiki 和记忆存储。" width="860"></p>

## 环境要求

- Python 3.9 或更高版本，在 `PATH` 中名为 `python3` 或 `python`。
- Graphviz（`dot`），用于设计图。
- Node 22.13 或更高版本，用于 JS 检查、spike 沙箱和可选的 `agent-memory` 插件。
- Claude Code，或 Codex 应用或 CLI。

## 安装 (๑•̀ㅂ•́)و✧

### 1. 添加插件市场（Claude Code）

```bash
claude plugin marketplace add stellarie/minimal-agent-kit
```

Claude Code 会列出 `minimal-agent-kit` 插件市场。

### 2. 安装套件（Claude Code）

```bash
claude plugin install minimal-agent-kit@minimal-agent-kit
```

重启 Claude Code。会话上下文会以 `# Agent rules` 开头。

### 3. 安装记忆插件（可选）

```bash
claude plugin install agent-memory@minimal-agent-kit
```

重启后，会话上下文会显示记忆索引。存储位置为 `~/.agent-memory`。

### 4. 为 Codex 安装

Codex 需要复制文件，并在 `~/.codex/config.toml` 中添加钩子。请按照 [INSTALL.md](INSTALL.md) 操作。代理可以逐步执行它。

### 5. 设置 spike 沙箱（可选，一次）

```bash
python tools/sandbox.py <empty-dir>
```

该命令需要网络访问。它输出 `sandbox ready: <empty-dir>`。之后每个任务在其中使用 `spike/<task>` 分支。

## 技能与钩子

| 名称 | 类型 | 作用 |
|---|---|---|
| `workflow` | 技能 | 设计、实现、审查、收尾。每个阶段都有编号子步骤和输出模板。 |
| `wiki` | 技能 | 在 `$WIKI_ROOT/<name>/` 中保存长期项目记忆；未设置 `WIKI_ROOT` 时在 `docs/wiki/`。页面格式固定。 |
| `ste` | 技能 | 聊天和文件的 STE 写作规则。 |
| `verify/` | 脚本 | 检查计划文件，按计划检查改动的 Python 和 JS 代码，运行项目自己的检查工具，并证明每个改动块都被某个测试需要。这些脚本还会按 wiki 格式检查 wiki 文件夹。 |
| `tools/sandbox.py` | 脚本 | 一次性搭建可复用的试验沙盒（pytest、jest、Express、React），带故障模拟。 |
| `SessionStart` | 钩子 | 加载规则和 wiki 的 `index.md`。 |
| `PreToolUse` | 钩子 | 对每次 `Bash` 和 `PowerShell` 调用运行 guard。 |
| `PostToolUse` | 钩子 | 对代理写出的每个 Markdown 文件运行 STE 检查。 |

guard 的一次往返：

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | python claude/guard/guard.py; echo "exit=$?"
```

guard 会输出 `guard: denied` 消息，并以 `exit=2` 退出。安全命令（如 `git status`）以 `exit=0` 退出。

## 安全 (｀ω´)ゞ

套件不会给代理新的权限。guard 只会收回权限，它不是沙箱。

1. guard 把命令拆成词元。它拒绝对危险路径执行 `rm`、`git reset --hard`、`git clean -f`，以及强制推送到 `main`。
2. 它用 `rules.json` 中的拒绝模式匹配整条命令。
3. 它会再次检查 `sh -c`、`bash -c` 等包装中的命令。

guard 匹配的是命令文本。在运行时拼出命令的脚本可以绕过它。如果没有 Python，钩子会失败，Claude Code 仍会执行该命令。

审查阶段把 diff 交给子代理。变更的作者从不审查自己的工作。

## 配置

| 设置 | 位置 | 默认值 |
|---|---|---|
| 拒绝模式 | `core/guard/rules.json` | `mkfs`、写入设备的 `dd`、`drop database` 等 |
| 审查模型 | `core/skills/workflow/review.md` | Claude Code 上为 Opus 5.5（medium），Codex 上为 Sol 6.1（light） |
| 项目 wiki | `WIKI_ROOT`、`WIKI_NAME` | 你项目中的 `docs/wiki/`。设置 `WIKI_ROOT`（绝对路径，或以 `~` 开头）后：`$WIKI_ROOT/<WIKI_NAME 或项目目录名>/`。由 `wiki` 技能创建 |
| 记忆存储 | `AGENT_MEMORY_HOME` | `~/.agent-memory` |

`WIKI_NAME` 是纯文件夹名称，不是路径。会话钩子使用 `WIKI_NAME`，或会话启动时所在目录的名称。

## 开发

只编辑 `core/`。然后复制到各目标：

```bash
python tools/sync.py
```

```bash
python tools/sync.py --check
```

```bash
python -m unittest discover -s tests
```

`tools/vendor_memory.py` 生成 `memory/`。请勿手动编辑。

```bash
cd memory && npm test
```

## 许可证

MIT © stellarie. Made with ♡ (≧∀≦)

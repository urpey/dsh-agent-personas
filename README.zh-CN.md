# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件包，让 agent 拥有持久人格——三层人格档案（`PERSONA.md`)、分层整数状态系统（`STATE.md`)、`memory://` URI 记忆树（`memory/`)——全部以本地 markdown 存放在会话工作区的 `.persona/<name>/` 下。

装备一个人格，agent 就有了身份、声线、随回合漂移并沉淀的情绪系统，以及一棵可以生长、检索、压缩的记忆树——都是你能直接读和改的普通文件。

## 特性

- **装备与续接** — `/persona use <name>` 将人格装备到当前会话；`.persona/.bindings/` 台账让恢复的会话自动重新装备。`/persona spawn <name>` 以人格身份派生子 agent。
- **双进程回合** — 每个用户回合先过一道 `persona_gate` 裁决：routine 走回复指令，critical 走两段式路径（八行标签的 `<thinking>` 独白 → `inner_commit` → 变换）。字面 `<thinking>` 片段会成为真正的 reasoning block。
- **状态系统** — `base` 仪表每回合 tick 漂移，带符号 `juel` 在 settle 时结晶为 `param`，仅 settle 的 `param` 存量，用 `param` 升级的 `stats`/`marks` 等级，`relations` 全程立场带（hostile → bonded)，按回合计数的 `buffs`。
- **记忆树** — `memory://<path>` ↔ `memory/<path>.md` 节点，frontmatter 含 `title`/`priority`/`disclosure`/`triggers`/`aliasOf`。拉取走 `memory_read`/`memory_search`/`memory_list`；推送走触发匹配的 recall 注入。
- **压缩** — `/persona compact <name>` 通过一次进程内 `ctx.llm.stream` 调用生成结构化编辑计划并校验后落盘。
- **作者流程** — 内置 `persona-authoring` 技能固定走 收集 → 草稿 → 确认 → `persona_save` → 询问装备。`persona_save` 是 agent 写入 `.persona/**` 的唯一通道（已装备会话中文件工具被拒绝）。
- **界面** — host 命令 `/persona list|new|examples|use|off|spawn|compact|status`;web 客户端本地化 `/personas` 弹窗选择器；模型工具 `persona_list`、`persona_spawn`、`persona_save`、`persona_use`；以及 `persona` 子 agent provider。
- **范例人格** — `deepseek`，一个中文声线的鲸鱼少女人格，随包分发：`/persona new --from deepseek`。

## 要求

- DeepSeek Harness ≥ `0.2.0-rc.1`（声明为**可选** peer——由运行中的 harness 提供，pnpm 不会另外下载一份）
- pnpm 10 或更新——下面的 `path:` git 子目录 spec 需要它（已在 pnpm 11.7 实测；GUI 插件管理器自带的 pnpm 满足）
- `/personas` 选择器需要 **web** profile;host 侧人格能力在任何提供 `agents`、`commands`、`subagents`、`tools`、`systemPrompt`、`llm` 服务的 profile 下都能工作

## 安装

bundle 位于仓库的 `bundle/` 子目录，用 git 子目录 spec 安装：

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
```

要可复现的安装，钉一个 commit:

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#<commit-sha>&path:/bundle'
```

本包是纯 JavaScript、零依赖——安装时不跑任何构建脚本，也不需要 `allowBuilds` 条目。

然后验证 layer 组合成功：

```sh
dsh --profile web --dump-config | grep -A3 'dsh-agent-personas'
```

应该看到包含 `agent-personas` 行的 `# == dsh-agent-personas` 层。

## 快速开始

```text
/persona new --from deepseek      # 把内置范例复制为 .persona/deepseek/
/persona use deepseek             # 装备——下一回合开始入戏
/persona status                   # 查看装备状态与库
/persona off                      # 卸下
```

或者在 `/personas` 选择器里选 **从范例创建「deepseek」**。

想自创人格：`/personas` 选择器 → **新建人格档案…** 会发出 agent 引导的作者消息（`persona-authoring` 技能访谈你、起草档案、经 `persona_save` 落盘并询问是否装备）。

## 命令

| 命令 | 作用 |
|---|---|
| `/persona list` | 列出库中的人格档案 |
| `/persona new <name> [desc]` | 创建空骨架档案 |
| `/persona new <name> --from <example>` | 复制内置范例（含记忆树） |
| `/persona examples` | 列出随包分发的范例 |
| `/persona use <name>` | 在当前会话装备人格 |
| `/persona off` | 卸下并注销工具/段 |
| `/persona spawn <name> [task]` | 以该人格派生可续接子 agent |
| `/persona compact <name>` | 一次 LLM 调用压缩该人格的记忆树 |
| `/persona status` | 显示已装备人格与库统计 |

## 配置

bundle 的 `cordis.patch.yml` 提供了默认值，你可以在自己 profile 的 `cordis.patch.yml` 中覆盖（注意：patch 是整行替换 `config`，要重述你保留的每个键）:

| 键 | 默认 | 作用 |
|---|---|---|
| `libraryDir` | `.persona` | 库根目录，相对会话工作区 cwd 解析 |
| `groundingInterval` | `0` | 每隔多少步注入一次 grounding(0 = 关闭） |
| `closingReflection` | `one-shot` | 收尾家务回合：`one-shot` / `always` / `never` |
| `providerName` | `persona` | `ctx.subagents` provider 名 |
| `criticalGate` | `auto` | `auto`（模型裁决）/ `always` / `never` |
| `compactProvider` / `compactModel` / `compactReasoningEffort` / `compactMaxTokens` / `compactRetries` | 未设 | `/persona compact` 的路由与预算（reasoning effort 不从路由继承） |

## 人格文件格式

人格就是一个纯 markdown 目录：

```text
.persona/<name>/
├── PERSONA.md     # frontmatter（name、description、triggers、mbti、interests、reactions）
│                  # + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # frontmatter 数值层：base、juel、param、stats、marks、
│                  # relations、buffs —— 工具可写，schema 键人可改
├── MEMORY.md      # boot URI + 派生索引
└── memory/        # 每个 memory:// 节点一个 .md 文件
```

完整契约——数值模型、settle 代数、写通道规则、每回合机制、持久化陷阱——见 [docs/persona-format.md](docs/persona-format.md)。

运行时侧车 `.persona/.bindings/`（装备台账）与 `.persona/.routes/`（裁决 JSONL）是普通文件，不是 session event。

## 开发

```sh
cd bundle
node --test tests/*.test.js   # 160+ 个测试，node 内置 runner，零依赖
```

源码布局：`bundle/index.js`(host 插件入口）、`bundle/client.js`（浏览器选择器贡献）、`bundle/lib/`（纯逻辑——装备机制、状态存储、记忆存储/计划/压缩、命令、provider)、`bundle/prompts/`、`bundle/templates/`、`bundle/examples/`、`bundle/skills/`。

贡献约定（issue 跟踪、triage 标签、领域文档）见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE) © 2026 urpey

# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

专为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 设计的插件包，为 Agent 赋予跨会话存续的立体人格。系统包含三层人格设定（`PERSONA.md`）、分层整数状态机制（`STATE.md`）以及基于 `memory://` 协议的 URI 记忆树（`memory/`），全部以纯 Markdown 文件形式保存在工作区目录 `.persona/<name>/` 下。

它**完全覆盖并超越了原生 persona 的能力**：原版的 `personaPrefix` / `@deepseek-ai/dsh-persona` 仅能向提示词注入一段静态设定，而本插件将人格沉淀为工作区中真实流转的文件。角色的底层基调稳定贯穿于系统提示词中，心绪与数值随着每轮对话悄然漂移、沉淀，记忆亦能在交互中被唤醒、生长与提炼，即便会话中断重启，角色依然如初。

## 特性

- **设定即文件，清晰可见** — 三层人格架构、分层整数状态体系与 URI 记忆树，皆是 `.persona/<name>/` 目录下清晰易读、随时可手动调整的 Markdown 文档。
- **超越静态提示词** — 既保留了 `personaPrefix` 注入核心设定的能力，又补足了它无法实现的动态心境起伏、人际关系演变与长期记忆检索。
- **一次装配，无缝延续** — 借助本地化的 `/personas` 交互面板，即可完成人格的装配、卸下或派生子 Agent；历史会话恢复时自动重新装配，无需重复配置。
- **随取随用与辅助引导** — 内置开箱可用的 `deepseek` 人格范例；亦可通过 `persona-authoring` 技能展开对话访谈，量身定制专属的人格档案。

## 安装

运行环境需满足 DeepSeek Harness ≥ `0.2.1-alpha.1` 与 pnpm 10+；可视化面板 `/personas` 依赖 **web** profile。

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# 如需锁定版本以确保可复现性，可在末尾添加 commit hash：…#<sha>&path:/bundle
```

## 快速开始

```text
/personas                 # 打开交互选择器
  → 从范例创建「deepseek」 # 将内置范例复制到 .persona/deepseek/
  → deepseek              # 装配人格——下一轮对话起生效
  → 卸下当前人格           # 卸下当前装配的人格
```

如需自行创建新角色，在面板中选择 **新建人格档案…** 即可——`persona-authoring` 技能将通过互动访谈协助你梳理设定、生成档案草稿并完成落盘装配。

`/persona` 命令行指令（支持 `list|new|examples|use|off|spawn|compact|status`，底层与图形面板完全一致）**默认未注册**；如需在终端菜单中使用，请在配置中声明 `slashCommand: true`。默认配置见 [bundle/cordis.patch.yml](bundle/cordis.patch.yml)。请注意，profile patch 采取全量覆盖 `config` 的策略，覆写时请一并发保留所需的默认键值。

## 人格文件结构

每个人格归档都是一个规范的 Markdown 目录：

```text
.persona/<name>/
├── PERSONA.md     # 元数据 + 第一层核心内核 / 第二层语气表达 / 第三层认知世界观
├── STATE.md       # 数值状态层：base、jewel、param、stats、marks、relations、buffs
├── MEMORY.md      # 引导记忆 URI + 派生索引
└── memory/        # 每个 memory:// 节点对应的独立 .md 文件
```

关于数值状态模型、结算代数规则及单轮对话流转机制的完整规范，请参阅 [docs/persona-format.md](docs/persona-format.md)。

## 本地开发

```sh
cd bundle
node --test tests/*.test.js   # 包含 160+ 项测试，使用 Node 内置测试运行器，零额外依赖
```

参与贡献与协作规范请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 使用限制

禁止用于通过情感操纵等方式诱导用户作出不合理决策；禁止用于向未成年人提供虚拟亲属、虚拟伴侣等带有虚拟亲密关系属性的服务。

## 许可证

[MIT](LICENSE) © 2026 urpey

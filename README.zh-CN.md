# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件包，让 agent 拥有持久人格——三层人格档案（`PERSONA.md`)、分层整数状态系统（`STATE.md`)、`memory://` URI 记忆树（`memory/`)——全部以本地 markdown 存放在会话工作区的 `.persona/<name>/` 下。

它**覆盖了原生 persona**：自带的 `personaPrefix`/`@deepseek-ai/dsh-persona` 只能注入一段固定的散文，而这里的人格是活的文件——身份照常进入系统提示词，还多出随回合漂移沉淀的状态、能回忆能生长能压缩的记忆，并跨会话存续。

## 特性

- **活的档案，普通文件** — 三层身份、分层整数状态系统、URI 记忆树，全是 `.persona/<name>/` 下可直接读写的 markdown。
- **覆盖原生 persona** — `personaPrefix` 能做的（把身份散文注入系统提示词）都做，还多出它无法表达的逐回合演绎、状态与记忆。
- **装备一次** — 本地化的 `/personas` 选择器负责装备、卸下、以人格身份派生子 agent；恢复的会话自动重新装备。
- **开箱即玩** — 内置 `deepseek` 范例一键创建；`persona-authoring` 技能访谈你并写出自己的档案。

## 安装

需要 DeepSeek Harness ≥ `0.2.1-alpha.1` 与 pnpm 10+;`/personas` 选择器需要 **web** profile。

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# 要可复现，钉一个 commit：…#<sha>&path:/bundle
```

## 快速开始

```text
/personas                 # 打开选择器
  → 从范例创建「deepseek」 # 把内置范例复制为 .persona/deepseek/
  → deepseek              # 装备——下一回合开始入戏
  → 卸下当前人格           # 卸下
```

想自创人格：选择 **新建人格档案…**——`persona-authoring` 技能会访谈你、起草档案并询问是否装备。

`/persona` host 命令（`list|new|examples|use|off|spawn|compact|status`，驱动与选择器相同的操作）**默认不注册**，设 `slashCommand: true` 可恢复。默认值见 [bundle/cordis.patch.yml](bundle/cordis.patch.yml)——profile patch 是整行替换 `config`，要重述你保留的键。

## 人格文件格式

人格就是一个纯 markdown 目录：

```text
.persona/<name>/
├── PERSONA.md     # frontmatter + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # 数值层：base、jewel、param、stats、marks、relations、buffs
├── MEMORY.md      # boot URI + 派生索引
└── memory/        # 每个 memory:// 节点一个 .md 文件
```

完整契约——数值模型、settle 代数、每回合机制——见 [docs/persona-format.md](docs/persona-format.md)。

## 开发

```sh
cd bundle
node --test tests/*.test.js   # 160+ 个测试，node 内置 runner，零依赖
```

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 使用限制

禁止用于通过情感操纵等方式，诱导用户作出不合理决策；禁止用于向未成年人提供虚拟亲属、虚拟伴侣等带有虚拟亲密关系属性的服务。

## 许可证

[MIT](LICENSE) © 2026 urpey

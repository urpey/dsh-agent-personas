# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外掛套件，讓 agent 擁有持久人格——三層人格檔案（`PERSONA.md`）、分層整數狀態系統（`STATE.md`）、`memory://` URI 記憶樹（`memory/`）——全部以本地 markdown 存放在工作階段工作區的 `.persona/<name>/` 下。

它**覆蓋了原生 persona**：自帶的 `personaPrefix`/`@deepseek-ai/dsh-persona` 只能注入一段固定的散文，而這裡的人格是活的檔案——身分照常進入系統提示詞，還多出隨回合漂移沉澱的狀態、能回憶能生長能壓縮的記憶，並跨工作階段存續。

## 特性

- **活的檔案，普通檔案** — 三層身分、分層整數狀態系統、URI 記憶樹，全是 `.persona/<name>/` 下可直接讀寫的 markdown。
- **覆蓋原生 persona** — `personaPrefix` 能做的（把身分散文注入系統提示詞）都做，還多出它無法表達的逐回合演繹、狀態與記憶。
- **裝備一次** — 本地化的 `/personas` 選擇器負責裝備、卸下、以人格身分派生子 agent；恢復的工作階段自動重新裝備。
- **開箱即玩** — 內建 `deepseek` 範例一鍵建立；`persona-authoring` 技能訪談你並寫出自己的檔案。

## 安裝

需要 DeepSeek Harness ≥ `0.2.1-alpha.1` 與 pnpm 10+；`/personas` 選擇器需要 **web** profile。

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# 要可重現，釘一個 commit：…#<sha>&path:/bundle
```

## 快速開始

```text
/personas                 # 打開選擇器
  → 从范例创建「deepseek」 # 把內建範例複製為 .persona/deepseek/
  → deepseek              # 裝備——下一回合開始入戲
  → 卸下当前人格           # 卸下
```

想自創人格：選擇 **新建人格档案…**——`persona-authoring` 技能會訪談你、起草檔案並詢問是否裝備。

`/persona` host 指令（`list|new|examples|use|off|spawn|compact|status`，驅動與選擇器相同的操作）**預設不註冊**，設 `slashCommand: true` 可恢復。預設值見 [bundle/cordis.patch.yml](bundle/cordis.patch.yml)——profile patch 是整列替換 `config`，要重述你保留的鍵。

## 人格檔案格式

人格就是一個純 markdown 目錄：

```text
.persona/<name>/
├── PERSONA.md     # frontmatter + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # 數值層：base、jewel、param、stats、marks、relations、buffs
├── MEMORY.md      # boot URI + 派生索引
└── memory/        # 每個 memory:// 節點一個 .md 檔案
```

完整契約——數值模型、settle 代數、每回合機制——見 [docs/persona-format.md](docs/persona-format.md)。

## 開發

```sh
cd bundle
node --test tests/*.test.js   # 160+ 個測試，node 內建 runner，零相依
```

貢獻慣例見 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE) © 2026 urpey

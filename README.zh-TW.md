# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的外掛套件，讓 agent 擁有持久人格——三層人格檔案（`PERSONA.md`）、分層整數狀態系統（`STATE.md`）、`memory://` URI 記憶樹（`memory/`）——全部以本地 markdown 存放在工作階段工作區的 `.persona/<name>/` 下。

裝備一個人格，agent 就有了身分、聲線、隨回合漂移並沉澱的情緒系統，以及一棵可以生長、檢索、壓縮的記憶樹——都是你能直接讀和改的普通檔案。

## 特性

- **裝備與續接** — `/persona use <name>` 將人格裝備到目前工作階段；`.persona/.bindings/` 帳本讓恢復的工作階段自動重新裝備。`/persona spawn <name>` 以人格身分派生子 agent。
- **雙程序回合** — 每個使用者回合先過一道 `persona_gate` 裁決：routine 走回覆指令，critical 走兩段式路徑（八行標籤的 `<thinking>` 獨白 → `inner_commit` → 變換）。字面 `<thinking>` 片段會成為真正的 reasoning block。
- **狀態系統** — 七層整數：`base` 儀表每回合 tick 漂移，帶符號 `juel` 在 settle 時結晶為 `param`、僅 settle 的 `param`、`stats`/`marks` 等級、`relations` 立場帶（hostile → bonded）、按回合計數的 `buffs`。
- **記憶樹** — `memory://<path>` ↔ `memory/<path>.md` 節點，frontmatter 含 `title`/`priority`/`disclosure`/`triggers`/`aliasOf`。拉取走 `memory_read`/`memory_search`/`memory_list`；推送走觸發匹配的 recall 注入。
- **壓縮** — `/persona compact <name>` 透過一次程序內 `ctx.llm.stream` 呼叫產生結構化編輯計畫並驗證後落盤。
- **作者流程** — 內建 `persona-authoring` 技能固定走 蒐集 → 草稿 → 確認 → `persona_save` → 詢問裝備。`persona_save` 是 agent 寫入 `.persona/**` 的唯一通道（已裝備工作階段中檔案工具被拒絕）。
- **介面** — host 指令 `/persona list|new|examples|use|off|spawn|compact|status`；web 用戶端本地化 `/personas` 彈出選擇器；模型工具 `persona_list`、`persona_spawn`、`persona_save`、`persona_use`；以及 `persona` 子 agent provider。
- **範例人格** — `deepseek`，一個中文聲線的鯨魚少女人格，隨套件散佈：`/persona new --from deepseek`。

## 需求

- DeepSeek Harness ≥ `0.2.0-rc.1`
- pnpm ≥ 10.9（下面的 `#path:` git 子目錄安裝需要；GUI 外掛管理器自帶的 pnpm 已滿足）
- `/personas` 選擇器需要 **web** profile；host 側人格能力在任何提供 `agents`、`commands`、`subagents`、`tools`、`systemPrompt`、`llm` 服務的 profile 下都能運作

## 安裝

bundle 位於儲存庫的 `bundle/` 子目錄，用 git 子目錄 spec 安裝：

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:bundle'
```

要可重現的安裝，釘一個 commit：

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#<commit-sha>:bundle'
```

本套件是純 JavaScript、零相依——安裝時不跑任何建置腳本，也不需要 `allowBuilds` 條目。

然後驗證 layer 組合成功：

```sh
dsh --profile web --dump-config | grep -A3 'dsh-agent-personas'
```

應該看到包含 `agent-personas` 列的 `# == dsh-agent-personas` 層。

## 快速開始

```text
/persona new --from deepseek      # 把內建範例複製為 .persona/deepseek/
/persona use deepseek             # 裝備——下一回合開始入戲
/persona status                   # 查看裝備狀態與庫
/persona off                      # 卸下
```

或者在 `/personas` 選擇器裡選 **从范例创建「deepseek」**（選擇器字串為簡中，繁中環境亦適用）。

想自創人格：`/personas` 選擇器 → **Create a persona archive…** 會發出 agent 引導的作者訊息（`persona-authoring` 技能訪談你、起草檔案、經 `persona_save` 落盤並詢問是否裝備）。

## 指令

| 指令 | 作用 |
|---|---|
| `/persona list` | 列出庫中的人格檔案 |
| `/persona new <name> [desc]` | 建立空骨架檔案 |
| `/persona new <name> --from <example>` | 複製內建範例（含記憶樹） |
| `/persona examples` | 列出隨套件散佈的範例 |
| `/persona use <name>` | 在目前工作階段裝備人格 |
| `/persona off` | 卸下並登出工具/段 |
| `/persona spawn <name> [task]` | 以該人格派生可續接子 agent |
| `/persona compact <name>` | 一次 LLM 呼叫壓縮該人格的記憶樹 |
| `/persona status` | 顯示已裝備人格與庫統計 |

## 組態

bundle 的 `cordis.patch.yml` 提供了預設值，你可以在自己 profile 的 `cordis.patch.yml` 中覆寫（注意：patch 是整列替換 `config`，要重述你保留的每個鍵）：

| 鍵 | 預設 | 作用 |
|---|---|---|
| `libraryDir` | `.persona` | 庫根目錄，相對工作階段工作區 cwd 解析 |
| `groundingInterval` | `0` | 每隔多少步注入一次 grounding（0 = 關閉） |
| `closingReflection` | `one-shot` | 收尾家務回合：`one-shot` / `always` / `never` |
| `providerName` | `persona` | `ctx.subagents` provider 名 |
| `criticalGate` | `auto` | `auto`（模型裁決）/ `always` / `never` |
| `compactProvider` / `compactModel` / `compactReasoningEffort` / `compactMaxTokens` / `compactRetries` | 未設 | `/persona compact` 的路由與預算（reasoning effort 不從路由繼承） |

## 人格檔案格式

人格就是一個純 markdown 目錄：

```text
.persona/<name>/
├── PERSONA.md     # frontmatter（name、description、triggers、mbti、interests、reactions）
│                  # + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # frontmatter 數值層：base、juel、param、stats、marks、
│                  # relations、buffs —— 工具可寫，schema 鍵人可改
├── MEMORY.md      # boot URI + 派生索引
└── memory/        # 每個 memory:// 節點一個 .md 檔案
```

完整契約——數值模型、settle 代數、寫通道規則、每回合機制、持久化陷阱——見 [docs/persona-format.md](docs/persona-format.md)。

執行時側車 `.persona/.bindings/`（裝備帳本）與 `.persona/.routes/`（裁決 JSONL）是普通檔案，不是 session event。

## 開發

```sh
cd bundle
node --test tests/*.test.js   # 170 個測試，node 內建 runner，零相依
```

原始碼配置：`bundle/index.js`（host 外掛入口）、`bundle/client.js`（瀏覽器選擇器貢獻）、`bundle/lib/`（純邏輯——裝備機制、狀態儲存、記憶儲存/計畫/壓縮、指令、provider）、`bundle/prompts/`、`bundle/templates/`、`bundle/examples/`、`bundle/skills/`。

貢獻慣例（issue 追蹤、triage 標籤、領域文件）見 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE) © 2026 urpey

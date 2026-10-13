# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

專為 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 設計的外掛套件，為 Agent 賦予跨工作階段存續的立體人格。系統包含三層人格設定（`PERSONA.md`）、分層整數狀態機制（`STATE.md`）以及基於 `memory://` 協定的 URI 記憶樹（`memory/`），全部以純 Markdown 檔案形式儲存在工作區目錄 `.persona/<name>/` 下。

它**完全涵蓋並超越了原生 persona 的能力**：原版的 `personaPrefix` / `@deepseek-ai/dsh-persona` 僅能向提示詞注入一段靜態設定，而本外掛將人格沉澱為工作區中真實流轉的檔案。角色的底層基調穩定貫穿於系統提示詞中，心緒與數值隨著每輪對話悄然漂移、沉澱，記憶亦能在互動中被喚醒、生長與提煉，即便工作階段中斷重啟，角色依然如初。

## 特性

- **設定即檔案，清晰可見** — 三層人格架構、分層整數狀態體系與 URI 記憶樹，皆是 `.persona/<name>/` 目錄下清晰易讀、隨時可手動調整的 Markdown 文件。
- **超越靜態提示詞** — 既保留了 `personaPrefix` 注入核心設定的能力，又補足了它無法實現的動態心境起伏、人際關係演變與長期記憶檢索。
- **一次裝配，無縫延續** — 透過本地化的 `/personas` 互動面板，即可完成人格的裝配、卸下或派生子 Agent；歷史工作階段恢復時自動重新裝配，無需重複配置。
- **隨取隨用與輔助引導** — 內建開箱可用的 `deepseek` 人格範例；亦可透過 `persona-authoring` 技能展開對話訪談，量身訂做專屬的人格檔案。

## 安裝

執行環境需滿足 DeepSeek Harness ≥ `0.2.1-alpha.1` 與 pnpm 10+；視覺化面板 `/personas` 依賴 **web** profile。

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# 如需鎖定版本以確保可重現性，可在末尾加入 commit hash：…#<sha>&path:/bundle
```

## 快速開始

```text
/personas                 # 開啟互動選擇器
  → 從範例建立「deepseek」 # 將內建範例複製到 .persona/deepseek/
  → deepseek              # 裝配人格——下一輪對話起生效
  → 卸下目前人格           # 卸下目前裝配的人格
```

如需自行建立新角色，在面板中選擇 **新建人格檔案…** 即可——`persona-authoring` 技能將透過互動訪談協助你梳理設定、產生檔案草稿並完成儲存裝配。

`/persona` 命令列指令（支援 `list|new|examples|use|off|spawn|compact|status`，底層與圖形面板完全一致）**預設未註冊**；如需在終端機選單中使用，請在設定中宣告 `slashCommand: true`。預設設定見 [bundle/cordis.patch.yml](bundle/cordis.patch.yml)。請注意，profile patch 採取全量覆蓋 `config` 的策略，覆寫時請一併保留所需的預設鍵值。

## 人格檔案結構

每個人格歸檔都是一個規範的 Markdown 目錄：

```text
.persona/<name>/
├── PERSONA.md     # 中繼資料 + 第一層核心本質 / 第二層語氣表達 / 第三層認知世界觀
├── STATE.md       # 數值狀態層：base、jewel、param、stats、marks、relations、buffs
├── MEMORY.md      # 引導記憶 URI + 衍生索引
└── memory/        # 每個 memory:// 節點對應的獨立 .md 檔案
```

關於數值狀態模型、結算代數規則及單輪對話流轉機制的完整規範，請參閱 [docs/persona-format.md](docs/persona-format.md)。

## 本地開發

```sh
cd bundle
node --test tests/*.test.js   # 包含 160+ 項測試，使用 Node 內建測試執行器，零額外相依
```

參與貢獻與協作慣例請參閱 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE) © 2026 urpey

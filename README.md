# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

A plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that gives agents a persistent persona — a three-layer persona profile (`PERSONA.md`), a layered integer state system (`STATE.md`), and a `memory://` URI memory tree (`memory/`) — all stored as local markdown under `.persona/<name>/` in the session workspace.

Equip a persona and the agent gains an identity, a voice, a mood system that drifts and settles over turns, and a memory it can grow, search and compact — all as ordinary files you can read and edit.

## Features

- **Equip & resume** — `/persona use <name>` mounts the persona on the session; a `.persona/.bindings/` ledger re-equips resumed sessions automatically. `/persona spawn <name>` runs a child agent already in character.
- **Dual-process turns** — every user turn passes a `persona_gate` verdict: routine turns get a reply directive, critical turns get a two-stage path (labeled `<thinking>` monologue → `inner_commit` → transform). Literal `<thinking>` spans become real reasoning blocks.
- **State system** — seven integer layers: `base` gauges with per-turn tick drift, signed `juel` that crystallizes into `param` at settle, settle-only `param`, `stats`/`marks` levels, `relations` with stance bands (hostile → bonded), and turn-counted `buffs`.
- **Memory tree** — `memory://<path>` ↔ `memory/<path>.md` nodes with `title`/`priority`/`disclosure`/`triggers`/`aliasOf` frontmatter. Pull via `memory_read`/`memory_search`/`memory_list`; push via trigger-matched recall injections.
- **Compaction** — `/persona compact <name>` tidies the memory tree through one in-process `ctx.llm.stream` call and a validated structured-output edit plan.
- **Authoring** — the bundled `persona-authoring` skill runs a fixed collect → draft → confirm → `persona_save` → equip flow. `persona_save` is the only agent write channel into `.persona/**` (file tools are denied there in equipped sessions).
- **Surfaces** — host commands `/persona list|new|examples|use|off|spawn|compact|status`; a localized `/personas` popup picker on the web client; model tools `persona_list`, `persona_spawn`, `persona_save`, `persona_use`; a `persona` subagent provider.
- **Example persona** — `deepseek`, a whale-girl persona (Chinese voice), ships inside the bundle: `/persona new --from deepseek`.

## Requirements

- DeepSeek Harness ≥ `0.2.0-rc.1`
- pnpm ≥ 10.9 (needed for the `#path:` git-subdirectory install below; the GUI plugin manager bundles a compatible pnpm)
- The **web** profile for the `/personas` picker; host-side persona features work in any profile that provides `agents`, `commands`, `subagents`, `tools`, `systemPrompt` and `llm` services

## Install

The bundle lives in `bundle/` inside this repository, so install it with a git subdirectory spec:

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:bundle'
```

Pin a commit for a reproducible install:

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#<commit-sha>:bundle'
```

The package is pure JavaScript with zero dependencies — no build step runs on install and no `allowBuilds` entry is needed.

Then verify the layer composed:

```sh
dsh --profile web --dump-config | grep -A3 'dsh-agent-personas'
```

You should see a `# == dsh-agent-personas` layer containing the `agent-personas` row.

## Quick start

```text
/persona new --from deepseek      # copy the bundled example into .persona/deepseek/
/persona use deepseek             # equip it — next turn runs in character
/persona status                   # show the equip + library
/persona off                      # unequip
```

Or pick **从范例创建「deepseek」 / Create the "deepseek" example** in the `/personas` picker.

To author your own: `/personas` picker → **Create a persona archive…** sends an agent-guided authoring message (the `persona-authoring` skill interviews you, drafts the archive, saves it through `persona_save`, and offers to equip).

## Commands

| Command | Effect |
|---|---|
| `/persona list` | List persona archives in the library |
| `/persona new <name> [desc]` | Create an empty skeleton archive |
| `/persona new <name> --from <example>` | Copy a bundled example (memory tree included) |
| `/persona examples` | List the examples shipped in the bundle |
| `/persona use <name>` | Equip a persona on this session |
| `/persona off` | Unequip and unregister tools/sections |
| `/persona spawn <name> [task]` | Start a continuable child agent as that persona |
| `/persona compact <name>` | Compact the persona's memory tree via one LLM call |
| `/persona status` | Show the equipped persona and library counts |

## Configuration

The bundle's `cordis.patch.yml` sets defaults you can override in your profile's `cordis.patch.yml` (restate every key you keep — a patch replaces the row's whole `config`):

| Key | Default | Effect |
|---|---|---|
| `libraryDir` | `.persona` | library root, resolved against the session workspace cwd |
| `groundingInterval` | `0` | steps between grounding injections (0 = off) |
| `closingReflection` | `one-shot` | `one-shot` / `always` / `never` closing housekeeping turn |
| `providerName` | `persona` | `ctx.subagents` provider name |
| `criticalGate` | `auto` | `auto` (model rules) / `always` / `never` |
| `compactProvider` / `compactModel` / `compactReasoningEffort` / `compactMaxTokens` / `compactRetries` | unset | `/persona compact` routing and budget (reasoning effort is NOT inherited from the route) |

## Persona file format

A persona is a directory of plain markdown:

```text
.persona/<name>/
├── PERSONA.md     # frontmatter (name, description, triggers, mbti, interests, reactions)
│                  # + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # frontmatter numeric layers: base, juel, param, stats, marks,
│                  # relations, buffs — tool-writable, schema keys human-editable
├── MEMORY.md      # boot URIs + derived index
└── memory/        # one .md file per memory:// node
```

The full contract — numeric model, settle algebra, write-channel rules, per-turn mechanics, persistence hazards — lives in [docs/persona-format.md](docs/persona-format.md).

Runtime sidecars `.persona/.bindings/` (equip ledger) and `.persona/.routes/` (verdict JSONL) are files, not session events.

## Development

```sh
cd bundle
node --test tests/*.test.js   # 170 tests, node built-in runner, zero deps
```

Source layout: `bundle/index.js` (host plugin entry), `bundle/client.js` (browser picker contribution), `bundle/lib/` (pure logic — equip machinery, state store, memory store/plan/compact, commands, provider), `bundle/prompts/`, `bundle/templates/`, `bundle/examples/`, `bundle/skills/`.

Contributing conventions (issue tracker, triage labels, domain docs) are in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 urpey

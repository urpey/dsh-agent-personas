# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

A plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that gives agents a persistent persona — structured across a three-layer persona profile (`PERSONA.md`), a layered integer state system (`STATE.md`), and a `memory://` URI memory tree (`memory/`), all maintained as plain Markdown files under `.persona/<name>/` in the session workspace.

It **goes beyond the native persona mechanism**: while stock `personaPrefix` / `@deepseek-ai/dsh-persona` merely injects a static block of text into the prompt, this bundle anchors an agent's identity in the workspace as editable files. Identity remains anchored in the system prompt, while internal states shift and settle with every exchange, and memories are recalled, formed, and compacted over time across sessions.

## Features

- **Identity in plain text** — Three-tier character definitions, discrete integer states, and an addressable URI memory hierarchy, all stored as straightforward, inspectable Markdown under `.persona/<name>/`.
- **Beyond static prompts** — Preserves everything `personaPrefix` offers for foundational characterization, while unlocking turn-by-turn state drift, nuanced relationship tracking, and dynamic recall.
- **Equip once, stay in character** — Use the localized `/personas` picker to switch characters or spawn subagents in persona; resumed sessions automatically restore their bound state.
- **Ready out of the box** — Comes with a built-in `deepseek` template ready to clone, alongside the interactive `persona-authoring` skill that guides you through drafting custom personas from scratch.

## Install

Requires DeepSeek Harness ≥ `0.2.1-alpha.1` and pnpm 10+; the `/personas` picker requires the **web** profile.

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# To lock a specific revision for reproducibility: append &<commit-sha> …#<sha>&path:/bundle
```

## Quick start

```text
/personas                          # open the picker
  → Create the "deepseek" example  # copies the bundled example into .persona/deepseek/
  → deepseek                       # equip it — next turn runs in character
  → Unequip the current persona    # unequip
```

To create a custom persona, select **Create a persona archive…** — the `persona-authoring` skill will interview you, draft the files, and help you equip it.

The `/persona` host command (`list|new|examples|use|off|spawn|compact|status`, providing the same capabilities as the picker) is **disabled by default**; set `slashCommand: true` in your configuration to enable it. Defaults are defined in [bundle/cordis.patch.yml](bundle/cordis.patch.yml). Note that profile patches overwrite the entire `config` object, so be sure to re-declare any existing keys you wish to keep.

## Persona file format

Each persona archive is organized as a standard Markdown directory:

```text
.persona/<name>/
├── PERSONA.md     # frontmatter + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # numeric layers: base, jewel, param, stats, marks, relations, buffs
├── MEMORY.md      # boot URIs + derived index
└── memory/        # one .md file per memory:// node
```

For detailed specifications on the numeric state model, settle algebra, and turn lifecycles, see [docs/persona-format.md](docs/persona-format.md).

## Development

```sh
cd bundle
node --test tests/*.test.js   # 160+ tests, built-in Node runner, zero external dependencies
```

Development and contribution guidelines can be found in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 urpey

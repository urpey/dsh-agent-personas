# dsh-agent-personas

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

A plugin bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that gives agents a persistent persona — a three-layer persona profile (`PERSONA.md`), a layered integer state system (`STATE.md`), and a `memory://` URI memory tree (`memory/`) — all stored as local markdown under `.persona/<name>/` in the session workspace.

It **covers the built-in persona**: the stock `personaPrefix`/`@deepseek-ai/dsh-persona` row can only inject a fixed paragraph of prose. This bundle turns the persona into a living file — an identity that stays in the system prompt, a mood state that drifts and settles turn by turn, and a memory it can recall, grow, and compact — persisting across sessions.

## Features

- **Living profile, plain files** — a three-layer identity, a layered integer state system, and a URI memory tree, all readable and editable markdown under `.persona/<name>/`.
- **Covers the native persona** — everything `personaPrefix` does (identity prose in the system prompt), plus per-turn characterization, state, and memory it can't express.
- **Equip once** — the localized `/personas` picker equips, unequips, and spawns child agents already in character; resumed sessions re-equip automatically.
- **Ready to play** — a bundled `deepseek` example one click away, plus the `persona-authoring` skill that interviews you and writes your own archive.

## Install

Requires DeepSeek Harness ≥ `0.2.1-alpha.1` and pnpm 10+; the `/personas` picker needs the **web** profile.

```sh
dsh plugin --profile web add 'github:urpey/dsh-agent-personas#path:/bundle'
# pin a commit for reproducibility: append &<commit-sha> …#<sha>&path:/bundle
```

## Quick start

```text
/personas                          # open the picker
  → Create the "deepseek" example  # copies the bundled example into .persona/deepseek/
  → deepseek                       # equip it — next turn runs in character
  → Unequip the current persona    # unequip
```

To author your own, pick **Create a persona archive…** — the `persona-authoring` skill interviews you, drafts the archive, and offers to equip it.

The `/persona` host command (`list|new|examples|use|off|spawn|compact|status`, driving the same operations as the picker) is **not registered by default**; set `slashCommand: true` to bring it back. Defaults live in [bundle/cordis.patch.yml](bundle/cordis.patch.yml) — a profile patch replaces the whole `config`, so restate the keys you keep.

## Persona file format

A persona is a directory of plain markdown:

```text
.persona/<name>/
├── PERSONA.md     # frontmatter + Layer 1 Core Self / Layer 2 Voice / Layer 3 World
├── STATE.md       # numeric layers: base, jewel, param, stats, marks, relations, buffs
├── MEMORY.md      # boot URIs + derived index
└── memory/        # one .md file per memory:// node
```

The full contract — numeric model, settle algebra, per-turn mechanics — lives in [docs/persona-format.md](docs/persona-format.md).

## Development

```sh
cd bundle
node --test tests/*.test.js   # 160+ tests, node built-in runner, zero deps
```

Contributing conventions are in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © 2026 urpey

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-12

First public release.

### Added

- Host plugin `agent-personas`: mounts a persistent persona surface on any
  equipped agent — three-layer `PERSONA.md` profile, six-layer integer state
  system (`base`/`juel`/`param`/`stats`/`marks`/`relations`/`buffs`), and a
  `memory://` URI memory tree under `.persona/<name>/`.
- Dual-process turns: a `persona_gate` verdict every user turn routes to a
  routine reply directive or a two-stage critical path (labeled `<thinking>`
  monologue → `inner_commit` → transform); literal `<thinking>` spans become
  real reasoning blocks.
- `/persona` commands: `list`, `new <name> [--from <example>]`, `examples`,
  `use`, `off`, `spawn`, `compact`, `status`.
- `/personas` client picker (web) with per-persona actions, localized zh/en
  rows, and an equipped badge.
- Model-facing tools: `persona_list`, `persona_spawn`, `persona_save`,
  `persona_use`, plus the `persona` subagent provider wrapping `spawn`.
- `persona-authoring` skill: fixed collect → draft → confirm → `persona_save`
  → equip flow; `persona_save` is the only agent write channel into `.persona/`.
- In-process `/persona compact` memory-tree compaction via `ctx.llm.stream`
  with structured-output plan validation.
- Bundled example persona `deepseek` (whale girl, zh) installable with
  `/persona new --from deepseek`.
- `.persona/.bindings/` equip ledger and `.persona/.routes/` verdict log.

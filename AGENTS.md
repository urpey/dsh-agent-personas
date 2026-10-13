# dsh-agent-personas

A DeepSeek Harness plugin bundle that gives agents a persistent persona — a three-layer persona profile (`PERSONA.md`), a layered integer state system (`STATE.md`), and a URI memory tree (`memory/`) — all stored as local markdown under `.persona/<name>/` in the session workspace.

## Feature map

- **Equip & resume.** `/persona use <name>` (or the `persona_use` tool) mounts the persona surface on `agent.ctx`; the equip record lives **on the agent object** (`agent.personaEquip`), never in a module map. A spawn channel equips a child at construction. On every `agent/created` the plugin resolves the name in order — live-spawn pending maps → `.persona/.bindings/<sessionId>.json` — and re-equips, so a resumed session (root or child) comes back already equipped.
- **Dual-process turns.** Every turn carrying user text gets a `[persona gate]` instruction; the model answers with one `persona_gate` call carrying the verdict, a quick pass (`perceive`/`aim`/`reason`), and this turn's `delta` ledger. Routine → a reply directive; critical → a staged `<thinking>` monologue → `inner_commit` → transform → reply. Literal `<thinking>` spans become real reasoning blocks outbound and are stripped from request history inbound.
- **State system.** Six integer layers: `base` gauges with `tick`/`tick_every` per-turn drift; signed `jewel` that crystallizes into `param` at settle (a negative balance burns `param` back); settle-only `param`; `stats`/`marks` levels bought by `param`; `relations` with total stance bands (hostile → bonded); turn-counted `buffs`. Tool writes only; schema keys are human-edited.
- **Memory tree.** `memory://<path>` ↔ `memory/<path>.md`, node frontmatter = `title`/`priority`/`disclosure`/`triggers`/`aliasOf`. Pull via `memory_read`/`search`/`list` (+ `children`/`seeAlso` adjacency); push via trigger-matched `[persona recall]` injections; `MEMORY.md` holds authored Boot URIs plus a derived Index section.
- **Compaction.** `/persona compact <name>` is ONE in-process `ctx.llm.stream` call (`purpose: 'compaction'`) over the whole tree → `structured_output` edit plan → `validatePlan` → `applyPlan` → `syncIndex`. No child session, no binding row.
- **Authoring.** The `persona-authoring` skill (registered at startup, global scope) runs a fixed collect → draft → confirm → `persona_save` → equip-ask flow. `persona_save` is the **only** agent write channel into `.persona/**` — file tools are denied there in equipped sessions — and creates only, never overwrites.
- **Surfaces.** Client: the `/personas` popup picker (`client.js`) — localized rows, per-persona actions, an 已装备 badge read from the binding ledger — is the primary entry point. Host: the `/persona list|new [--from <example>]|examples|use|off|spawn|compact|status` command exists but is **not registered by default** (`slashCommand: false`): the Host command registry has no hidden flag, so unregistered is the only way to keep it off the `/` menu. Model: `persona_list`, `persona_spawn`, `persona_save`, `persona_use`, plus the `persona` subagent provider (wraps `spawn`).
- **One implementation, two faces.** `lib/commands.js` exposes `createPersonaOps()` — the operation bodies (`list`/`new`/`examples`/`use`/`off`/`spawn`/`compact`/`status`, each answering `{ ok, text }` and never throwing for a business refusal). The command is a thin raw-line parser over that table; `lib/remote.js` exposes the same table to the browser as the `personaInternals` Remote service, which the picker calls when the command is switched off. The two cannot drift — `tests/plugin.test.js` asserts identical refusals through both.
- **Persistence sidecars.** `.persona/.bindings/` (session→persona ledger) and `.persona/.routes/` (gate verdict JSONL) are files, deliberately **not** session events — an out-of-tree event type can't be marked `ignorable` and would break log restore.

## Bundle structure

```
bundle/
  index.js             host plugin 'agent-personas': config, agent/created equip watcher,
                       persona_* tool registration, skill registration, commands wiring
  client.js            browser half: '/personas' popup picker contribution (zh/en)
  cordis.patch.yml     plugin row + default config (see below)
  lib/
    equip.js           per-agent machinery: prompt sections, dynamic context block, write
                       guard, memory/state tool surface, gate + stage directives, turn hooks,
                       thinking-tag wiring, immersion/OOC watch, closing reflection
    persona.js         library paths, archive skeleton creation, persona_save validation
                       (savePersona), persona body/marker rendering
    provider.js        'persona' subagent provider + pending-name side channels
    commands.js        createPersonaOps() — the operation bodies shared by both faces —
                       plus the /persona raw-line parser and equipSession()
    remote.js          the picker's Host channel: a plain object provided as the
                       'personaInternals' Remote service, hand-carrying the two markers
                       the Gateway's SRC fallback reads (no harness imports possible)
    state-store.js     delta/buff/tick/settle/notes over STATE.md + renderStateSummary
    memory-store.js    URI tree CRUD, aliases, index sync, boot URIs, neighborhood, search
    critical-prompts.js gate instruction/directives, signals, stance bands, MBTI +
                       reaction-profile merge, standard-field meanings
    bindings.js        .persona/.bindings/<sessionId>.json ledger
    route-log.js       .persona/.routes/<sessionId>.jsonl verdict log
    memory-compact.js  the one llm.stream compaction call + retries/cap escalation
    memory-plan.js     snapshot render + validatePlan/applyPlan/describePlan
    thinking-tags.js   <thinking> ↔ reasoning blocks (stream transform + history strip)
    frontmatter.js     minimal YAML-subset frontmatter parser/dumper (the grammar contract)
  prompts/             injected assets: protocol.md, closing.md, compact.md, grounding.md
  templates/           PERSONA.md / STATE.md / MEMORY.md archive skeletons
  examples/            complete shipped archives (deepseek) copied into a workspace
                       library by `/persona new [--from <example>]` — see
                       listExamples/createPersonaFromExample in lib/persona.js
  skills/persona-authoring/  registered via ctx.inject(['skills']) at apply time
  locale/              zh.json / en.json dictionaries for the picker
  tests/               node --test tests/*.test.js — plugin, commands, picker,
                       thinking-tags, memory-plan/compact
```

Runtime directories inside `.persona/`: `.bindings/` (equip ledger, `{ name, boundAt }`) and `.routes/` (one verdict line per turn: `critical|routine|missed|no-delta` + reason/signals/quick pass/delta).

## Host command

`/persona` exists only when `slashCommand: true` (default in the shipped patch is `false`, so the picker is the only human entry point). Every subcommand is a thin raw-line parse over `createPersonaOps()` — the picker reaches the same table through `personaInternals`:

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

## Per-turn pipeline (equipped session)

1. **`agent/pre-step`, new turn** — `tickBuffs` + `tickBase` (one write), queued notices (buff expiry, malformed `reactions`).
2. **Context block** — `[persona context — internal state]` re-injected at the step tail when dirty (turn start or after any mutator): `## Current state`, boot nodes, capped memory index. Kept OUT of the system prompt to preserve prompt caching.
3. **Gate step** — gate instruction lands last in the input, carrying deterministic `## Signals` (speaker/stance, interests, jewel ≥ 30, carried param ≥ 20, buffs, truncated input). The model's only output is the `persona_gate` call; its `delta` is applied immediately through `applyDelta`.
4. **Directive step** — `REPLY_DIRECTIVE` (routine) or `stageOnePrompt` (critical). Critical: `<thinking>` monologue with eight labeled lines (`STATE PERCEIVE AIM WANT WEIGH EXPECT CHOICE REASON`) → `inner_commit` returns the stage-2 transform → reply.
5. **`agent/turn-stopping`** — recovers an owed directive, queues stage 2 for an uncommitted monologue, logs `missed`/`no-delta` verdicts to `.routes/`, fires the closing reflection when configured (`closingReflection`).

Riding the same step block, before the gate instruction: trigger-matched `[persona recall]` node bodies, a stored `[persona ooc]` immersion correction when the last reply leaked machinery, and `grounding.md` every `groundingInterval` steps when configured.

## Config (`cordis.patch.yml`, overridable by user patch)

| Key | Default | Effect |
|---|---|---|
| `libraryDir` | `.persona` | library root, resolved against the session workspace cwd |
| `groundingInterval` | `0` | steps between grounding injections (0 = off) |
| `closingReflection` | `one-shot` | `one-shot` / `always` / `never` closing housekeeping turn |
| `providerName` | `persona` | `ctx.subagents` provider name |
| `criticalGate` | `auto` | `auto` (model rules) / `always` / `never` |
| `slashCommand` | `true` in code; **`false` in the shipped patch** | register the `/persona` Host command. `false` removes its `/` menu row (the registry has no hidden flag) and leaves the `/personas` picker as the only human entry point — the picker reaches the same operations through the `personaInternals` Remote service, so nothing else changes. The code default is `!== false` → `true`, so a user patch that restates `config` but omits this key silently re-registers the command |
| `compactProvider`/`compactModel`/`compactReasoningEffort`/`compactMaxTokens`/`compactRetries` | unset | `/persona compact` routing and budget (reasoning effort is NOT inherited from the route) |

## Agent skills

### Issue tracker

Issues and specs are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-named label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Persona library

Persona archives (profiles, state files, memory trees) live under `.persona/<name>/`; the ledger/log sidecars live under `.persona/.bindings/` and `.persona/.routes/`. **`docs/persona-format.md` is the deep contract** — read it before touching `bundle/`: file formats, the numeric model (base/jewel→param/stats-marks/relations/buffs), write-channel rules, per-turn mechanics, settle algebra, persistence hazards, and known limitations. The authoring flow's authority is `bundle/skills/persona-authoring/SKILL.md`.

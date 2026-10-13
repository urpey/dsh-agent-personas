# Persona System: File Formats & Write Rules

The `dsh-persona-system` plugin bundle gives equipped agents a persistent persona whose files live under `.persona/<name>/` in the project workspace.

## Layout

```
.persona/
  <name>/
    PERSONA.md        # identity + voice (agent-read-only; only humans edit)
    STATE.md          # layered numeric state (tools only; see below)
    MEMORY.md         # boot URI list + memory index (tools only)
    memory/           # URI-addressed tree; one .md per node
      user/preferences.md      ↔ memory://user/preferences
      relationships/lead.md    ↔ memory://relationships/lead
```

## PERSONA.md (three layers, human-edited)

```markdown
---
name: <name>
description: one-line identity
triggers: [names, aliases]
---

## Layer 1 · Core Self
- **identity** / **values** / **thinking** / **emotion** / **boundaries**

## Layer 2 · Voice
- **tone** / **patterns** / **taboo** / **length**

## Layer 3 · Dynamic State
Declares which STATE.md fields exist and their meaning; values live in STATE.md.
```

## STATE.md (layered numeric system, integer percent scale)

Frontmatter-only data; free-text notes in the body.

```yaml
---
# Layer 0 · BASE — resource gauges, integer 0–max, replenishable
base:
  energy: { max: 100, value: 80 }
  focus:  { max: 100, value: 60 }

# Layer 1 · PALAM — in-session emotion accumulators (≥0, unbounded)
# emit → which juel it crystallizes into; per → points per gem;
# decay → % of remainder kept after settle (0–100)
palam:
  joy:     { emit: favor,  per: 100, decay: 20, value: 0 }
  anger:   { emit: grudge, per: 100, decay: 30, value: 0 }
  shame:   { emit: shame,  per: 50,  decay: 10, value: 0 }
  fatigue: { emit: fatigue, per: 100, decay: 0, value: 0 }

# Layer 2 · JUEL — crystallized gems (permanent, produced by settle only)
juel: { favor: 0, grudge: 0, shame: 0, desire: 0, fatigue: 0 }

# Layer 3 · permanent growth — tool-face READ-ONLY, raised only by juel
stats:              # ability levels 0–15
  candor: { level: 0, requires: { favor: 10 } }
marks:              # imprints 0–15 (incl. negative marks)
  humiliation: { level: 0, requires: { shame: 20 } }

# Relations — the only persistent layer allowing direct deltas, −100..+100
relations:
  lead: { value: 0 }

# Buffs — temporary deltas applied on top of base (or palam) values
buffs:
  - { name: caffeine, domain: physical, duration: 4,      # turns; null = persistent
      deltas: { energy: +15, focus: +10 } }
---
## Notes
Free-text notes for future selves. `state_update` may append here.
```

## Write-channel rules (enforced)

| Data | Who writes | How |
|---|---|---|
| PERSONA.md | humans only | hand edit; agents cannot modify it |
| STATE.md `base`/`palam`/`relations` values | `state_delta` tool | integer deltas, clamped |
| STATE.md `buffs` | `buff_apply` / `buff_clear` tools | same-name buff refreshes; `duration` decrements per turn |
| STATE.md `stats`/`marks`/`juel`/field schema | `state_settle` only | palam → juel → level-ups; no direct tool write |
| STATE.md body notes | `state_update` tool | append-only |
| memory/**.md | `memory_*` tools | URI tree + frontmatter |
| direct file tools on `.persona/**` | **denied** | scoped `tools/pre-execute` guard rejects `write`/`edit`/`bash` calls whose path touches the persona library |

## Settle algorithm (`state_settle` / turn-end when configured)

```
per palam field p:
  gain    = floor(p.value / p.per)
  juel[p.emit] += gain
  p.value  = (p.value % p.per) + floor(p.value / p.per * (p.decay / 100))
per stats/marks entry (in declared order, max +1 level per settle):
  if level < 15 and juel satisfies every requires key → deduct, level++
returns { palamDelta, juelGained, levelUps }
```

Delta magnitude guidance lives in `bundle/prompts/protocol.md`: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe.

## Runtime mechanics (implemented)

Prompt sections injected per equipped agent (agent-scoped, in assembly order):

| Section | Order | Kind | Content |
|---|---|---|---|
| `deployment:persona-prefix` | 0 | static | `persona-profile:<name>` marker + full PERSONA.md. Skipped when the spawn provider already mounted it via `request.persona`. |
| `persona:state` | 480 | dynamic fn | Rendered STATE summary — base/max, palam, relations, active buffs. Re-evaluated every assembly so `state_delta` results show next step. |
| `persona:boot` | 481 | dynamic fn | MEMORY.md `Boot URIs` expanded to full node bodies. |
| `persona:memory-index` | 482 | dynamic fn | Compact catalog: `- uri (pN [alias→x]) — disclosure [triggers: a, b]`. Lets the model `memory_read` on demand without holding all content. |
| `persona:protocol` | 483 | static | `prompts/protocol.md`: dual-process contract, state/memory/closing contracts. |

Turn hooks (`agent/pre-step`, `agent/turn-stopping`):

- **Buff tick** — first step of each new turn decrements `buffs[].duration`; expired names are injected as `[persona] buffs expired: …`.
- **Memory recall** — each step scans the newest user-visible message for node `triggers` (case-insensitive, ≤3 hits, once per URI per session). Hits arrive as `[persona recall] memory://path` + body in the step's input — already-read memory, not a tool call.
- **Grounding** — when `config.groundingInterval > 0`, `prompts/grounding.md` is injected every Nth step.
- **Closing reflection** — when `config.closingReflection` matches the mode (`one-shot` default), turn end queues `prompts/closing.md` as a followup turn: the agent `state_settle`s and `memory_create`s before stopping.
- **One-shot output rewind** — the reflection adds a housekeeping turn, which would make `readResult` return its chatter instead of the task answer. The `persona` provider wraps `run.result`: if a `[persona closing]` user message exists in the session log, `output` is replaced with the last assistant message BEFORE it.

Dual-process protocol (prompts/protocol.md): every reply runs an inner pass in the reasoning channel — `STATE:` verbatim copy, `TRIGGERS:`, `REFUSAL:`, `VOICE:` — then the outer persona voice. Runtimes without a reasoning channel emit an unmarked reflective paragraph instead. State deltas are recorded at the moment they happen, not batched.

Config (`cordis.patch.yml` row `persona-system`, user patch can override):

| Key | Default | Effect |
|---|---|---|
| `libraryDir` | `.persona` | Persona library root, resolved against workspace cwd |
| `groundingInterval` | `0` | Steps between grounding injections (0 = off) |
| `closingReflection` | `one-shot` | `one-shot` / `always` / `never` |
| `providerName` | `persona` | `ctx.subagents` provider name |

## Known limitations

- `.persona` write guard is a substring check on tool arguments, not a syscall-level jail.
- `spawn_teammate` does not forward a `persona` request field — persona-bound teammates must come from `persona_spawn` or `/persona spawn`.
- `install_bundle` on an already-linked directory reports `ambiguous-install`; `remove_bundle` first, or rely on HMR (watch root must include the bundle dir).

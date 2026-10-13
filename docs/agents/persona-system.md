# Persona System: File Formats & Write Rules

The `dsh-persona-system` plugin bundle gives equipped agents a persistent persona whose files live under `.persona/<name>/` in the project workspace.

## Layout

```
.persona/
  .bindings/            # session→persona ledger (runtime, gitignored)
    <sessionId>.json    # { name, boundAt } — written by /persona use, cleared by /persona off
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
  p.value  = floor((p.value % p.per) * (p.decay / 100))
per stats/marks entry (in declared order, max +1 level per settle):
  if level < 15 and juel satisfies every requires key → deduct, level++
returns { palamDelta, juelGained, levelUps }
```

`decay` is the percentage of the leftover remainder that survives the settle:
`0` clears it (fatigue), `100` carries it over whole. A settle never grows an
accumulator — the leftover only shrinks.

Delta magnitude guidance lives in `bundle/prompts/protocol.md`: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe.

## Runtime mechanics (implemented)

Prompt sections injected per equipped agent (agent-scoped, in assembly order):

| Section | Order | Kind | Content |
|---|---|---|---|
| `deployment:persona-prefix` | 0 | static | `persona-profile:<name>` marker + full PERSONA.md. Skipped when the spawn provider already mounted it via `request.persona`. |
| `persona:state` | 480 | dynamic fn | Rendered STATE summary — base/max, palam, relations, active buffs. Internal dashboard only: the protocol forbids speaking numbers/stat names in visible text; state shapes tone, not content. |
| `persona:boot` | 481 | dynamic fn | MEMORY.md `Boot URIs` expanded to full node bodies. |
| `persona:memory-index` | 482 | dynamic fn | Compact catalog: `- uri (pN [alias→x]) — disclosure [triggers: a, b]`. Capped at 30 rows by priority; overflow reachable via `memory_search`. |
| `persona:protocol` | 483 | static | `prompts/protocol.md`: dual-process contract, state/memory/closing contracts. |

Turn hooks (`agent/pre-step`, `agent/turn-stopping`):

- **Buff tick** — first step of each new turn decrements `buffs[].duration`; expired names are injected as `[persona] buffs expired: …`.
- **Memory recall** — each step scans the newest user-visible message for node `triggers` (case-insensitive, ≤3 hits, once per URI per session). Hits arrive as `[persona recall] memory://path` + body in the step's input — already-read memory, not a tool call.
- **Grounding** — when `config.groundingInterval > 0`, `prompts/grounding.md` is injected every Nth step.
- **Closing reflection** — when `config.closingReflection` matches the mode (`one-shot` default), turn end queues `prompts/closing.md` as a followup turn. `state_settle` is unconditional; `memory_create` is conditional — write only when something is worth keeping, never a filler note. The closing prompt also asks the agent to tidy a bloated index (merge/reprioritize/alias/delete).
- **One-shot output rewind** — the reflection adds a housekeeping turn, which would make `readResult` return its chatter instead of the task answer. The `persona` provider wraps `run.result`: if a `[persona closing]` user message exists in the session log, `output` is replaced with the last assistant message BEFORE it.

Dual-process protocol (prompts/protocol.md): every reply opens with a `<thinking>…</thinking>` block in the text (inner pass: `STATE:` verbatim copy, `TRIGGERS:`, `REFUSAL:`, `VOICE:`), then the outer persona voice. The tags are the canonical carrier — emitted on every runtime, including those with a native reasoning channel (which may additionally carry the same pass). The leak scanner strips `<thinking>` contents before matching, so state numbers/URIs inside the tags never trigger an OOC correction. State deltas are recorded at the moment they happen, not batched.

**Immersion boundary** — the persona never surfaces the plugin machinery in visible text: no `memory://` URIs, `.persona` paths, filenames, section names, tool names, or state numbers. Two-layer enforcement: (1) the protocol's Immersion boundary section forbids it; (2) a `session/event` listener scans each `assistant/message` for leak markers and injects a `[persona ooc]` correction into the next step when found — the leaked words are already said, but the next reply re-enters character. `<thinking>…</thinking>` contents are stripped before scanning — mechanism vocabulary is legal inside the tags.

Config (`cordis.patch.yml` row `persona-system`, user patch can override):

| Key | Default | Effect |
|---|---|---|
| `libraryDir` | `.persona` | Persona library root, resolved against workspace cwd |
| `groundingInterval` | `0` | Steps between grounding injections (0 = off) |
| `closingReflection` | `one-shot` | `one-shot` / `always` / `never` |
| `providerName` | `persona` | `ctx.subagents` provider name |

Binding persistence (resume after restart): `/persona use` writes `.persona/.bindings/<sessionId>.json`; on the next `agent/created` the plugin reads it back and re-equips as `mode: 'session'`. **Do not reintroduce a `persona/bound` session event** — live `Session.append` cannot mark an event `ignorable: true`, so an out-of-tree event type persists as a required unknown and `validateStoredEvents` refuses to restore the whole session (session becomes unopenable). Spawned children don't need the ledger: their `subagent/descriptor` carries the `persona-profile:` marker.

## Known limitations

- `/persona` command cards don't render in a brand-new session until the first message sends: DSH's chat shell hides the transcript while `conversationPhase === 'blank'` (`activeTargets` requires a non-command chat node; `promptAttempted` flips on first submit). Harness-side behavior, same for all host commands.
- `.persona` write guard is a substring check on tool arguments, not a syscall-level jail.
- `spawn_teammate` does not forward a `persona` request field — persona-bound teammates must come from `persona_spawn` or `/persona spawn`.
- Memory compaction is on-demand (`/persona compact <name>` maintenance one-shot + closing-time tidying), not scheduled — no automatic cadence yet.
- `install_bundle` on an already-linked directory reports `ambiguous-install`; `remove_bundle` first, or rely on HMR (watch root must include the bundle dir).

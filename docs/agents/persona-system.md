# Persona System: File Formats & Write Rules

The `dsh-persona-system` plugin bundle gives equipped agents a persistent persona whose files live under `.persona/<name>/` in the project workspace.

## Layout

```
.persona/
  .bindings/            # session→persona ledger (runtime, gitignored)
    <sessionId>.json    # { name, boundAt } — written by /persona use, cleared by /persona off
  .routes/              # gate verdict log (runtime, gitignored)
    <sessionId>.jsonl   # one line per verdict: { at, turn, step, verdict, reason, signals }
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
mbti: INFP          # tunes the inner monologue + seeds reaction defaults
interests: [数据库]
reactions:          # optional; overrides the MBTI defaults per event layer
  praise: { palam: { joy: 1.5 }, base: { satiety: 0.3 } }
  criticism: { palam: { shame: 1.8 } }
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
# tick = per-turn drift (the body's own clock); omit for a static gauge
base:
  energy: { max: 100, value: 80, tick: -1 }
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
# duration counts turns; null = persistent
buffs:
  - { name: caffeine, domain: physical, duration: 4, deltas: { energy: +15, focus: +10 } }
---
## Notes
Free-text notes for future selves. `state_update` may append here.
```

Grammar contract (enforced by `bundle/lib/frontmatter.js`, a minimal parser —
not general YAML):

- `#` comments are allowed on their own line and trailing a value; the parser
  strips them. **Tools do not write comments back** — the first `state_*` write
  reports `notice: "N comment line(s) dropped"`; keep field meaning in
  PERSONA.md/Notes if it must persist.
- A `#` inside a flow collection truncates it (`{ a: 1 # note }` is an error):
  put the comment after the closing bracket. `#` inside quotes is literal.
- Flow collections must stay on one line; a line that can't be parsed throws
  instead of degrading into a silent string. `loadState` also validates layer
  shapes (entries are maps, `palam.*.emit` non-empty, `juel`/numeric fields
  numeric, `buffs` an array) so a hand-edit that drifts fails at load, not
  mid-write after schema keys were already lost.

## Turn-level drift (`base.*.tick`)

Optional integer on a `base` entry. Once per turn — on the same `agent/pre-step`
hook that ages buffs, in one file write — every ticked field moves by `tick`,
clamped to `0..max`. It is the body's own clock, not an external condition:
`tick` mutates the real value and cannot be cleared, while `buffs` modify the
effective value and can be.

Pacing rule: `tick × expected turns ≈ total drift`. Keep `|tick| ≤ 3`; a 50-turn
session at `tick: -1` drains about half a gauge. A turn that drifts nothing does
not rewrite the file (so its comments survive). No floor above 0 — a linear drain
pins at empty rather than stopping at "exhausted but alive".

`tick_every` (optional integer, default `1`) spreads a tick over N turns:
`tick: -1, tick_every: 2` loses one point every second turn. The cadence is keyed
to the session's 1-based turn number, so it needs no stored phase and survives a
restart; the render shows it (`satiety: 67/100 (-1/2t)`). Called without a turn
number — direct tooling, tests — the tick applies immediately.

## Reactions — scenario → field → magnitude

`PERSONA.md` frontmatter declares how this persona converts an event into state:

```yaml
reactions:
  praise: { palam: { joy: 1.5 }, base: { satiety: 0.3 } }
```

- Shape: `event → { palam|base|relations: { field: multiplier } }`. Multiplier
  scales the magnitude band, not a fixed value; `0` and negatives are rejected.
- **MBTI seeds it**: each declared letter contributes field+multiplier defaults
  (`F` amplifies `joy`/`shame` and touches `relations`, `T` dampens affect).
  Letters compound when they reach the same field (INFP `praise.palam.joy` =
  I × N × F). A declared event *layer* replaces the merged layer wholesale — the
  declaration wins outright, so writing one field takes over that event.
- **Enforcement is advisory (L2)**: `state_delta` takes an optional `event`. After
  applying, the tool compares the delta with the profile and reports drift in its
  result — the same channel that reports dropped comments, read in the same turn,
  no extra request. It never rejects and never rewrites.
  - `|delta| > 50` → always noticed (the protocol's own ceiling).
  - with an `event`: `|delta| > max(30, round(15 × mult) × 2)` → noticed. The 30
    floor is the top of the *notable* band, so calibration speaks only once a
    delta reaches *significant*.
  - a field the event does not map to → noticed as a question, not an error.
  - an unknown event name → "no reaction profile", delta still applied.
- The merged table is rendered into every turn's `## Current state` block as one
  capped line (`reactions: praise→joy×1.5,satiety×0.3 · …`), so routine turns see
  it too. Full event semantics stay in PERSONA.md prose.
- A malformed `reactions` table never breaks the agent: it falls back to the MBTI
  letter defaults and injects `[persona] PERSONA.md reactions ignored — <reason>`
  once at the next turn.

## Write-channel rules (enforced)

| Data | Who writes | How |
|---|---|---|
| PERSONA.md | humans only | hand edit; agents cannot modify it |
| STATE.md `base`/`palam`/`relations` values | `state_delta` tool, or the `delta` field of the `persona_gate` call | integer deltas, clamped; optional `event` calibrates against the reaction profile |
| STATE.md `base.*.tick` | humans only | schema key; per-turn drift applied by the turn hook, never by tools |
| STATE.md `buffs` | `buff_apply` / `buff_clear` tools | same-name buff refreshes; `duration` decrements per turn |
| STATE.md `stats`/`marks`/`juel`/field schema | `state_settle` only | palam → juel → level-ups; no direct tool write |
| STATE.md body notes | `state_update` tool | append-only |
| PERSONA.md `reactions` | humans only | same human-only file as `mbti`; MBTI letters seed the defaults |
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

## Reading the bands (how a number becomes behaviour)

A number the model has no band for is a number it does not act on. Three surfaces
carry the interpretation, all rendered from one owner (`relationStance` /
`carriedJuel` in `bundle/lib/critical-prompts.js`):

| Layer | Band | Rendered as |
|---|---|---|
| `base.*` | `value/max ≤ 0.3` | "`energy` is low (20/100) — thoughts run shorter, flatter, tireder" (stage-1 tuning) |
| `base.*` | `value/max ≥ 0.8` | full — the ease that resource buys |
| `palam.*` | `≥ 15` | "`anger` is running high (40) — it colors every thought this turn" (stage-1 tuning) |
| `palam.*` | `≥ 30` | "`anger` = 40 — already hot" (gate signals) |
| `relations.*` | `≤ −30` | `hostile — suspicion first` |
| `relations.*` | `−29..−1` | `cold — cooling; no warmth volunteered` |
| `relations.*` | `0..+29` | `unbonded — no standing yet — do not presume closeness` |
| `relations.*` | `+30..+59` | `warm — ease and generosity by default` |
| `relations.*` | `≥ +60` | `bonded — long trust — generosity is the reflex` |
| `juel.*` | `≥ 20` | "carried (permanent, not this turn's mood): `grudge` = 60" |

The stance band is **total**: every relation value lands in a band, so a relation
at `0` speaks on all three surfaces. The old rule emitted a line only at
`|v| ≥ 30`, which left `0` silent — and silence is not neutral, because the
persona's own Layer-1 prose ("主人·几乎写死的高") then supplied the default and
the persona stayed intimate at `relations.user = 0`. Where a persona's prose and
its numbers disagree, the numbers win for the current turn; `protocol.md` states
that priority explicitly and tells the model to rule such a divergence critical.

### Voice precedence — who owns tone vs. truth

`protocol.md`'s "Voice precedence" section fixes the reference order for a reply.
**Tone** is sourced first from the persona's Layer 2 Voice as re-tuned by
`## Current state` (numbers win conflicts with baseline prose, per the bands
above). **Memory and conversation context** are the second reference for tone —
they set *content truthfulness* (facts, history, what happened) and may shade the
register, but never set or reverse it. Input changes how the persona sounds only
through the state ledger (`delta`/`state_delta`), never by borrowing a remembered
or implied mood. The same sentence rides `REPLY_DIRECTIVE`, `stageTwoPrompt`, the
stage-1 `VOICE:` label, and `prompts/grounding.md` so every reply surface carries
it — and `templates/PERSONA.md` anchors voice rules in Layer 2, not in memory
nodes.

`juel` is deliberately labelled permanent wherever it is rendered — in the state
block (`juel (permanent, spent only on growth): grudge×60`) and in the gate
signals. It is crystallized history, not a mood: a kept `grudge` outlives the
`palam.anger` that produced it and is spent only by `state_settle` level-ups, so
a large balance has to shape the baseline rather than the current temper. Before
this, `juel` was rendered in the state block and read by no rule anywhere.

## Runtime mechanics (implemented)

Prompt sections injected per equipped agent (agent-scoped, in assembly order):

| Section | Order | Kind | Content |
|---|---|---|---|
| `deployment:persona-prefix` | 0 | static | Persona body from PERSONA.md (frontmatter stripped). Skipped when the spawn provider already mounted it via `request.persona`. |
| `harness:identity` | `HARNESS_IDENTITY` | static | Shadowed with `You are an AI agent.` so the harness opener cannot contradict the persona. |
| `persona:protocol` | 483 | static | `prompts/protocol.md`: dual-process contract, voice precedence, state/memory/closing contracts. |

**The system prompt is deliberately static.** State, boot memory and the memory index live in an injected `[persona context — internal state, not user input]` message instead, appended at the END of the step input:

| Block | Content |
|---|---|
| `## Current state` | Rendered STATE summary — base/max, palam, relations, active buffs. Internal dashboard only: the protocol forbids speaking numbers/stat names in visible text; state shapes tone, not content. |
| boot nodes | MEMORY.md `Boot URIs` expanded to full node bodies. |
| `## Memory index` | Compact catalog: `- uri (pN · title [· alias→x]) — disclosure [triggers: a, b]`. Capped at 30 rows by priority; overflow reachable via `memory_search`. |

Why not prompt sections: editing the system prompt invalidates the provider's prompt cache for everything after it — the entire conversation included — so every `state_delta`, settle or memory write made the next request pay full price for the whole context. Measured on a real session: two consecutive steps cost 31,456 and 35,677 fresh input tokens (only 256 cached) right after a settle and a `memory_create`. As a trailing message, only the tail is new and the stable prefix stays cacheable.

Refresh rule: the block is injected when it could have gone stale — at the start of every turn, and immediately after any tool in `MUTATORS` (`memory_create/update/delete/alias`, `state_delta`, `state_settle`, `state_note`, `buff_apply`, `buff_clear`). So the state the model reads is never a turn-old snapshot.

Turn hooks (`agent/pre-step`, `agent/turn-stopping`):

- **Buff tick** — first step of each new turn decrements `buffs[].duration`; expired names are injected as `[persona] buffs expired: …`.
- **Memory recall** — each step scans the newest user-visible message for node `triggers` (case-insensitive, ≤3 hits, once per URI per session). Hits arrive as `[persona recall] memory://path` + body in the step's input — already-read memory, not a tool call. A URI the model pulled itself via `memory_read` in the same session is skipped — pull consumes push eligibility (an alias read marks the resolved target too).
- **Pull-chain neighborhood** — `memory_read` results also carry `children` (direct URI children, ≤10, aliases marked) and `seeAlso` (≤5 `{keyword, uri}` links: other nodes' trigger words found in this node's content — `triggers` serve double duty: input-side push + in-content graph navigation). `memory_search` hits carry `disclosure`/`triggers` so a card can be judged before reading. `memory_create` without `disclosure` still succeeds but returns a `no disclosure` notice — a bare URI row is invisible to the index reader.
- **Grounding** — when `config.groundingInterval > 0`, `prompts/grounding.md` is injected every Nth step.
- **Closing reflection** — when `config.closingReflection` matches the mode (`one-shot` default), turn end queues `prompts/closing.md` as a followup turn. `state_settle` is unconditional; `memory_create` is conditional — write only when something is worth keeping, never a filler note. The closing prompt also asks the agent to tidy a bloated index (merge/reprioritize/alias/delete).
- **One-shot output rewind** — the reflection adds a housekeeping turn, which would make `readResult` return its chatter instead of the task answer. The `persona` provider wraps `run.result`: for a staged (critical) turn it returns the first visible text AFTER the last `inner_commit` call — never the monologue; for a routine turn, the last assistant message before the `[persona closing]` injection.

Dual-process protocol (`prompts/protocol.md`): the gate is a verdict the model rules, and the turn gains a decision step to carry it.

- **Step 1 — the instruction.** `gateInstruction()` injects `[persona gate]`: the imperative, the forced-mode sentence when `criticalGate` is `always`/`never`, the ledger sentence for `delta`, and a `## Signals` block — speaker known (with relation values) or first contact, one stance line per relation, declared `interests`, palam fields at or above 30, carried `juel` at or above 20, active buffs, and the input truncated to 160 chars. It is the last thing in the step input, after the persona context block. The same signals string is what the route log records.
- **The verdict.** The model's only output on that step is `persona_gate({ critical, reason?, delta? })`. The tool holds no criteria and makes no judgment: it records the verdict and returns a one-line acknowledgement. `reason` is the model's own words for why the turn is loaded, quoted into the stage-1 directive. `delta` is the turn's ledger entry — applied through the same `applyDelta` channel as `state_delta` (calibration notice and all, appended to the acknowledgement), applied *before* the state is loaded for the directive so the monologue's pressure lines already include what just landed, and recorded in the route log as the `changed` list. A delta that names no field is not an entry (`hasDeltaFields`), so an empty object can never rewrite STATE.md to record nothing; a malformed one degrades to a `delta not applied — <reason>` notice instead of taking the verdict down with it.
- **Step 2 — the directive.** The directive the verdict owes is injected once, at the next step: `REPLY_DIRECTIVE` (`[persona reply]`) for routine, or `stageOnePrompt()` (`[persona stage 1 of 2]`) for critical. The critical path keeps the staged shape: step 2 emits only the `<thinking>…</thinking>` monologue (`STATE:` verbatim copy from the context block, `TRIGGERS:`, `REFUSAL:`, `VOICE:`, then free expansion) and calls `inner_commit`; the tool returns the stage-2 transform directive, and step 3 produces the reply. Staging is structural: the monologue cannot be skipped, and the transform gets its own directive. The monologue text itself rides the `inner_commit` result — request history strips synthetic reasoning before the next step, so without it the transform would have nothing to transform (see "thinking extraction" below).
- **Cost.** Routine 2 requests (gate step + reply), critical 3 (gate step, monologue step, reply step) — one more than before in both shapes. The gate step is small: its output is the call, ~15 tokens. The ledger rides the call, so per-turn state recording costs no request at all.

Degradation: a gate step that produced no call is re-asked once, at a later step of the same turn that carries new user input (`step <= 2`); after that the turn proceeds and the route log records `verdict: 'missed'` — a turn that was never offered the gate is not logged as a miss. A critical verdict whose `inner_commit` never arrived gets the stage-2 directive queued by `agent/turn-stopping` as a followup turn, so the reader never receives a bare monologue. A directive still pending when the turn stops is queued once on the step inbox (`agent.inject`), not as a followup: a non-empty next-step queue is itself what makes the loop re-enter, and the inbox rejects a second pending id-less message — so an inject+followup pair would either throw or deliver the directive twice. State deltas are recorded at the moment they happen, not batched.

**Turn-start notices** — buff expiry and a malformed `reactions` table both ride one `agent.inject` queue call (`notice()`), never two: the inbox rejects a second pending id-less message, and at the turn boundary that rejection aborted the whole turn before any model request, so the reader got nothing. `notice()` logs the failure instead of throwing.

**Identified injections** — every message the plugin injects carries its own `id` (a UUID, the same shape the harness mints for user messages). The inbox rejects a duplicate pending id across the step and turn lists, so an id-less injection collides with *any* other id-less message already queued — a foreign plugin's followup was enough to throw away an owed directive and, separately, to lose a closing reflection. Identified messages cannot collide.

**`<thinking>` extraction** (`lib/thinking-tags.js`) — the protocol writes the monologue as a literal `<thinking>…</thinking>` span inside reply text; the pipeline gives it a real block type both ways without touching the session log. Outbound, an `llm/stream` waterfall (`transformThinkingStream`, registered on `agent.ctx`, gated by `options.sessionId`) splits every tagged span out of text blocks into its own reasoning block — mid-text, repeatedly, across chunk boundaries — renumbers emitted blocks contiguously, and remaps `finish.replayState.blocks` to emitted order so real provider thinking keeps its signature while synthetic extractions get `{type}` entries. Inbound, the equipped session's `deriveMessages` is instance-wrapped (`stripThinkingFromMessages`, once per session): reasoning blocks keep only provider-signed thinking (positional `replayState.blocks[i]` signature check), literal-tag residue is removed from text, and `replayState.blocks` is filtered to stay aligned. Net effect: the UI folds the monologue into the thinking row, the reply text stays clean, and the monologue is never replayed to the provider — `inner_commit` re-reads it from the raw log (`snapshotEvents`) and hands it to stage 2 inside the tool result, the one channel that survives the strip.

**Immersion boundary** — the persona never surfaces the plugin machinery in visible text: no `memory://` URIs, `.persona` paths, filenames, section names, tool names, or state numbers. Two-layer enforcement: (1) the protocol's Immersion boundary section forbids it; (2) a `session/event` listener scans each `assistant/message` for leak markers and *stores* a `[persona ooc]` correction that the next pre-step delivers — the leaked words are already said, but the next reply re-enters character. It is stored rather than injected on the spot because the listener runs inside the session's own append publish, where a nested `inject` throws (`cannot reenter while another append is being published`) and the correction was silently lost. `<thinking>…</thinking>` contents are stripped before scanning — mechanism vocabulary is legal inside the tags.

Config (`cordis.patch.yml` row `persona-system`, user patch can override):

| Key | Default | Effect |
|---|---|---|
| `libraryDir` | `.persona` | Persona library root, resolved against workspace cwd |
| `groundingInterval` | `0` | Steps between grounding injections (0 = off) |
| `closingReflection` | `one-shot` | `one-shot` / `always` / `never` |
| `providerName` | `persona` | `ctx.subagents` provider name |
| `criticalGate` | `auto` | `auto` (the model rules each turn via `persona_gate`) / `always` (every turn critical) / `never` (every turn routine) |

Binding persistence (resume after restart): `.persona/.bindings/<sessionId>.json` is the **single durable owner** of "which persona is this session equipped with". Two writers, one row each: `/persona use` registers the session it equipped, and every spawn path (`/persona spawn`, `/persona compact`, the `persona_spawn` tool in both modes) registers the child session it created — the child is equipped by construction, so it must be registered too. On the next `agent/created` the plugin reads the row back and re-equips as `mode: 'session'`, and the `/personas` picker reads the same row to badge the equipped persona. **Do not reintroduce a `persona/bound` session event** — live `Session.append` cannot mark an event `ignorable: true`, so an out-of-tree event type persists as a required unknown and `validateStoredEvents` refuses to restore the whole session (session becomes unopenable). **Do not add a second binding channel either**: continuable spawns pass persona BODY text (`lib/provider.js` `personaBodyText`), so a `subagent/descriptor` carries no `persona-profile:` marker to parse — the descriptor-replay branch that used to read one was unreachable dead code and was removed.

Route log (gate audit): every verdict appends one JSON line to `.persona/.routes/<sessionId>.jsonl` — `{ at, turn, step, verdict, reason, signals }`, plus `delta` (the applied `changed` list) when the verdict carried a ledger entry. `at` is ISO-8601 and `verdict` is `critical | routine | missed | no-delta` (`missed` = the turn ended with no verdict; `no-delta` = the turn was ruled but wrote no ledger entry, neither a gate `delta` nor a `state_delta` call). `signals` is the rendered signal block the model ruled against, so a ruling can be reviewed after the fact. The `no-delta` verdict exists because "state is not updated every turn" used to be invisible: it is a count in the log now, and it never interrupts the turn. Appends are best-effort: an unwritable log never breaks a turn. **Do not turn it into a session event** — the same `ignorable` hazard as `.persona/.bindings/` above applies verbatim.

## Host/client pitfalls (both shipped as real bugs once)

- **A `remote.<namespace>` service key is FLAT.** The client half reads the workspace-files API as `ctx.remote.workspaceFiles`, so `inject` must name that exact string — `'remote.workspaceFiles'`. Injecting `'remote'` and reading `.workspaceFiles` off it throws `cannot get property "workspaceFiles" without inject`, and a client that swallows that error ships a popup reading 0 personas while the library is full. `bundle/tests/picker.test.js` mounts the real `client.js` against a stub service table that throws on an unknown key precisely so this cannot regress silently.
- **Never `new AbortSignal()`.** `AbortSignal` is an interface, not a constructible class: `new AbortSignal()` is a `TypeError: Illegal constructor`. Every subagent entry point calls `signal.throwIfAborted()`, so the failure surfaces as `command/done { kind: "error", text: "Illegal constructor" }` on 派生/压缩. Use `new AbortController().signal` (the `NEVER_ABORTS` constant in `bundle/lib/commands.js` / `bundle/index.js` is that shape).
- **The picker's badge is the binding ledger, read through `workspaceFiles.read`.** There is no dot-path filtering in that remote (it resolves any relative path under the session cwd), which is why `.persona/.bindings/<sessionId>.json` is readable from the client at all — but it is also why a session with no ledger row is invisible no matter how real its equip is. Equip and registration are one act: see the binding paragraph above.
- **The equip state lives ON the agent (`agent.personaEquip`), never in a module-level table.** A `const equipped = new Map()` at module scope used to be the authority for `/persona use|off|status`: the agent survives an HMR reload of this bundle but the module — and the map — does not, so the reloaded commands read an empty table and lied (`use` re-equipped an already-equipped scope and crashed on a duplicated `persona:protocol` section; `off` reported "no persona equipped" while the equip was live). `agent.id === session.id` is a registry invariant, so the agent object is exactly the session's place to carry `{ name, dispose }`; it dies with the agent, which is the session's lifetime. The `agent/created` listener's first line `if (agent.personaEquip) return` doubles as the idempotency guard for duplicate announcements. **Do not reintroduce any process-scoped equip bookkeeping** — commands/tests must read the agent.

## Known limitations

- The gate is model judgment with no deterministic floor: a loaded turn ruled routine is visible only in the route log, after the fact.
- Per-turn state recording is *carried*, not *enforced*: the gate call is the one output the turn structure forces, and `delta` rides it, but the model can still omit it. Omission is a real answer (a turn that moved nothing) and is logged as `verdict: 'no-delta'` — count it in `.persona/.routes/` rather than expecting a guarantee. A model that omits every turn is a prompt/calibration problem the log now makes visible; code never fabricates a delta.
- The stance bands and the carried-`juel` threshold are code-owned and identical for every persona (`bundle/lib/critical-prompts.js`). Per-persona band text was deliberately left out of the STATE.md schema, so a persona that wants different wording for its own relations edits prose, not bands. If per-persona bands become necessary, extend the schema — do not add a second band table beside `RELATION_BANDS`.
- `/persona` command cards don't render in a brand-new session until the first message sends: DSH's chat shell hides the transcript while `conversationPhase === 'blank'` (`activeTargets` requires a non-command chat node; `promptAttempted` flips on first submit). Harness-side behavior, same for all host commands.
- Reaction calibration is advisory by design: the model names the event and keeps
  final say, so a wrong event label produces a confidently calibrated wrong delta.
  There is no magnitude hard-cap; `|delta| > 50` is reported, not rejected.
- The comment-drop notice rides a *tool result*, so it fires only when a tool is the
  first writer after a hand edit. The per-turn tick (`tickBuffs`/`tickBase`) can write
  first and drop comments silently — comments are documentation, not data, and the
  structure (schema keys, values) survives either way.
- `.persona` write guard is a substring check on tool arguments, not a syscall-level jail.
- `spawn_teammate` does not forward a `persona` request field — persona-bound teammates must come from `persona_spawn` or `/persona spawn`.
- Memory compaction is on-demand (`/persona compact <name>` maintenance one-shot + closing-time tidying), not scheduled — no automatic cadence yet.
- `install_bundle` on an already-linked directory reports `ambiguous-install`; `remove_bundle` first, or rely on HMR (watch root must include the bundle dir).

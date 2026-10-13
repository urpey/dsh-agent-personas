/**
 * Gate prompts — the text surface of the model-ruled critical gate.
 *
 * The verdict belongs to the model (`persona_gate`), so this module holds no
 * criteria and maps no word to a verdict: it renders the step-1 imperative that
 * orders the verdict (`gateInstruction`), the deterministic facts the retired
 * keyword table used to compute (`signalsLine`), and the directives a verdict
 * earns — the monologue step (`stageOnePrompt`), the reply-only step
 * (`REPLY_DIRECTIVE`), and the transform handed back by `inner_commit`
 * (`stageTwoPrompt`).
 *
 * The monologue is parameterized on this system's knobs: MBTI profile + live
 * STATE (juel peaks, base gauges, relations, buffs) instead of a trait model
 * thresholds. The reply carries the
 * monologue's feeling through Layer 2 voice, which is always in the prompt —
 * so no second call is needed to apply the style matrix.
 */

/** MBTI letters → inner-monologue tuning hints (takes the place of trait rules). */
const MBTI_HINTS = {
  E: 'thoughts run outward — assertive, talk-ready, low deliberation',
  I: 'thoughts run inward — deliberate, self-referential, slower to speak',
  S: 'concrete and present-tense — facts, senses, what is literally here',
  N: 'abstract and associative — patterns, possibilities, what it means',
  T: 'analytic — weigh logic first, feelings noted and priced',
  F: 'feeling-led — impact on people first, logic second',
  J: 'closure-seeking — decide, plan, dislike open loops',
  P: 'option-keeping — improvise, explore, resist premature closure',
}

/**
 * MBTI letters → reaction defaults: which fields absorb an event class, and how
 * hard (a multiplier over the ±1–5/±5–15/±15–30/±30–50 band). Heuristic
 * defaults, not personality theory — they exist so a declared MBTI starts
 * calibrated and the persona's own `reactions` table can refine or contradict
 * them.
 */
export const MBTI_REACTIONS = {
  E: { praise: { juel: { joy: 1.2 } }, criticism: { juel: { anger: 1.1 } } },
  I: { praise: { juel: { joy: 1.2 } }, criticism: { juel: { shame: 1.3 } } },
  S: { praise: { base: { energy: 1.1 } } },
  N: { praise: { juel: { joy: 1.1 } }, criticism: { juel: { shame: 1.1 } } },
  T: { praise: { juel: { joy: 0.6 } }, criticism: { juel: { anger: 0.7, shame: 0.4 } } },
  F: { praise: { juel: { joy: 1.5 }, relations: { user: 1.2 } }, criticism: { juel: { shame: 1.6 } } },
  J: { criticism: { juel: { anger: 1.2 } } },
  P: { criticism: { juel: { anger: 0.7 } } },
}

/**
 * Relation bands — what a relation value MEANS, for every value rather than
 * only the extremes. The old rule spoke only at |v| ≥ 30, so a relation sitting
 * at 0 — the value that most needs saying out loud ("no standing yet, do not
 * presume closeness") — produced no line on any surface, and the model fell
 * back on the persona's Layer-1 prose ("主人·几乎写死的高") instead of the
 * number. One owner for the judgment; each call site formats its own prefix.
 *
 * Boundaries reuse the documented ±30 and add a bonded tier above +60.
 */
export const RELATION_BANDS = [
  { max: -30, label: 'hostile', hint: 'suspicion first' },
  { max: -1, label: 'cold', hint: 'cooling; no warmth volunteered' },
  { max: 29, label: 'unbonded', hint: 'no standing yet — do not presume closeness' },
  { max: 59, label: 'warm', hint: 'ease and generosity by default' },
  { max: Infinity, label: 'bonded', hint: 'long trust — generosity is the reflex' },
]

/** The band a relation value falls in. Total: every number lands somewhere. */
export function relationStance(value) {
  const v = Number(value) || 0
  return RELATION_BANDS.find(b => v <= b.max) ?? RELATION_BANDS[RELATION_BANDS.length - 1]
}

/**
 * Carried weight worth flagging: `param` at or above this is not a small
 * balance but crystallized standing (a grievance kept across settles), and it
 * must reach the surfaces the model actually decides on — it was previously
 * rendered only in the `param:` line of the state block and read by no rule.
 */
export const PARAM_NOTABLE = 20

/**
 * Standard-vocabulary meanings — code-owned, identical for every persona.
 * A field name outside these maps is persona-coined: its meaning lives in
 * that persona's Layer 3 prose and renders here as a bare number.
 */
export const JUEL_MEANINGS = {
  joy: 'sweetness rising',
  anger: 'irritation loading',
  shame: 'fluster surfacing',
  fear: 'guardedness rising',
  fatigue: 'running thin',
}
export const PARAM_MEANINGS = {
  affection: 'accumulated sweetness — warmth is the reflex',
  defiance: 'a kept ledger of slights — pushing back comes grown-in',
  intimacy: 'walls worn thin — closeness presumed, shame harder to reach',
  wariness: 'scar tissue — suspicion stays loaded',
  edginess: 'frayed edges — replies run shorter, sharper, less cushioned',
}

/** `param` entries at/above `min`, strongest first, capped. */
export function carriedParam(state = {}, min = PARAM_NOTABLE, limit = 3) {
  return Object.entries(state.param ?? {})
    .map(([k, v]) => [k, Number(v) || 0])
    .filter(([, v]) => v >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

/** Layers a reaction profile may address — the same three state_delta writes. */
export const REACTION_LAYERS = ['juel', 'base', 'relations']

/** Validate a declared reactions table; throws naming the offending path. */
export function assertReactions(declared) {
  if (declared === undefined || declared === null) return {}
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error('reactions must be a map of event → profile')
  }
  for (const [event, profile] of Object.entries(declared)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`reactions.${event} must be a map of layer → fields`)
    }
    for (const [layer, fields] of Object.entries(profile)) {
      if (!REACTION_LAYERS.includes(layer)) {
        throw new Error(`reactions.${event}.${layer} is not a writable layer (juel|base|relations)`)
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error(`reactions.${event}.${layer} must be a map of field → multiplier`)
      }
      for (const [field, mult] of Object.entries(fields)) {
        if (typeof mult !== 'number' || !Number.isFinite(mult) || mult <= 0) {
          throw new Error(`reactions.${event}.${layer}.${field} must be a positive number`)
        }
      }
    }
  }
  return declared
}

/**
 * Merge MBTI-letter defaults with a persona's declared table.
 * Letters multiply when two reach the same field (INFP praise.joy = I × N × F);
 * a declared event layer replaces the merged layer wholesale, so writing one
 * field in PERSONA.md takes over that event's mapping completely.
 */
export function mergeReactions(mbti = '', declared = {}) {
  const letters = String(mbti).toUpperCase().replace(/[^A-Z]/g, '')
  const merged = {}
  for (const l of letters) {
    for (const [event, profile] of Object.entries(MBTI_REACTIONS[l] ?? {})) {
      for (const layer of REACTION_LAYERS) {
        for (const [field, mult] of Object.entries(profile[layer] ?? {})) {
          merged[event] ??= {}
          merged[event][layer] ??= {}
          merged[event][layer][field] = (merged[event][layer][field] ?? 1) * mult
        }
      }
    }
  }
  for (const [event, profile] of Object.entries(assertReactions(declared))) {
    merged[event] ??= {}
    for (const layer of REACTION_LAYERS) {
      if (profile[layer]) merged[event][layer] = { ...profile[layer] }
    }
  }
  return merged
}

/**
 * One compact line for the persona context block. Capped so a large table
 * cannot eat context; the full semantics stay in PERSONA.md prose.
 */
export function renderReactions(reactions = {}, maxEvents = 6) {
  const events = Object.entries(reactions)
  const shown = events.slice(0, maxEvents).map(([event, profile]) => {
    const fields = REACTION_LAYERS.flatMap(layer =>
      Object.entries(profile[layer] ?? {}).map(([f, m]) => `${f}×${Math.round(m * 100) / 100}`))
    return `${event}→${fields.join(',')}`
  })
  const hidden = events.length - shown.length
  return shown.join(' · ') + (hidden > 0 ? ` · …+${hidden} more` : '')
}

function mbtiRules(mbti = '') {
  const letters = String(mbti).toUpperCase().replace(/[^A-Z]/g, '')
  const rules = [...letters].map(l => MBTI_HINTS[l]).filter(Boolean)
  return rules.length
    ? rules.map(r => `- ${r}`).join('\n')
    : '- no MBTI declared — think in a way consistent with your Core Self'
}

function stateRules(state = {}) {
  const rules = []
  const juelEntries = Object.entries(state.juel ?? {})
    .map(([k, p]) => [k, Number(p?.value) || 0])
  const peaks = juelEntries
    .filter(([, v]) => v >= 15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  for (const [k, v] of peaks) {
    const hint = JUEL_MEANINGS[k] ? ` (${JUEL_MEANINGS[k]})` : ''
    rules.push(`- ${k}${hint} is running high (${v}) — it colors every thought this turn`)
  }
  // Banked amends: a negative juel is compensation that will burn standing on
  // settle — the reply should sound like the ledger is being paid down, not
  // like the wound is fresh again.
  for (const [k, v] of juelEntries.filter(([, v]) => v <= -15).sort((a, b) => a[1] - b[1]).slice(0, 2)) {
    rules.push(`- ${k} is banked low (${v}) — amends/counterweight; settle pays it against standing`)
  }
  for (const [k, f] of Object.entries(state.base ?? {})) {
    const v = Number(f?.value) || 0, max = Number(f?.max) || 100
    if (v / max <= 0.3) rules.push(`- ${k} is low (${v}/${max}) — thoughts run shorter, flatter, tireder`)
  }
  for (const [k, r] of Object.entries(state.relations ?? {})) {
    const v = Number(r?.value) || 0
    const s = relationStance(v)
    rules.push(`- ${k}: ${s.label} (${v > 0 ? '+' : ''}${v}) — ${s.hint}`)
  }
  // Carried weight: crystallized param is settled standing, so it belongs in
  // the monologue's tuning even though no mood is driving it this turn.
  for (const [k, v] of carriedParam(state)) {
    const hint = PARAM_MEANINGS[k] ? ` — ${PARAM_MEANINGS[k]}` : ''
    rules.push(`- ${k} is carried (${v})${hint}; settled standing, not this turn's mood — it sets your baseline until amends or growth move it`)
  }
  for (const b of state.buffs ?? []) rules.push(`- buff "${b.name}" is active — it is literally on your mind`)
  return rules.length ? rules.join('\n') : '- state is flat — let personality, not mood, carry this one'
}

/**
 * Deterministic gate inputs, rendered as `- ` lines. Cheap facts only — the
 * model reads the input itself; code must not score it. Two of the lines are
 * interpretations rather than facts — the relation stance band and the carried
 * `juel` flag — because a bare number the model has no band for is a number it
 * does not act on.
 *
 * Every access is guarded (`?? {}`, `|| 0`) so a malformed state file yields a
 * thinner signal line instead of breaking the turn. The first-contact line is
 * always present, so this never returns '' — the caller may show it verbatim.
 *
 * @param opts.state - loaded STATE.md data (relations/juel/param/buffs)
 * @param opts.meta  - PERSONA.md frontmatter (interests)
 * @param opts.text  - this turn's newest real user input, truncated for display
 */
export function signalsLine({ state = {}, meta = {}, text = '' } = {}) {
  const lines = []
  const rel = state.relations ?? {}
  const known = Object.entries(rel)
    .map(([k, r]) => `${k}=${Number(r?.value) || 0}`)
    .join(', ')
  lines.push(known ? `- speaker: known (relations ${known})` : '- speaker: first contact — no relation record yet')
  // The stance a value means, for every relation and every value. The numeric
  // speaker line above is a fact; this is what it asks of the reply, so a
  // relation at 0 can no longer pass through the gate unremarked.
  for (const [k, r] of Object.entries(rel)) {
    const v = Number(r?.value) || 0
    const s = relationStance(v)
    lines.push(`- stance toward ${k}: ${s.label} (${v > 0 ? '+' : ''}${v}) — ${s.hint}`)
  }
  const interests = (meta.interests ?? []).filter(Boolean)
  if (interests.length) lines.push(`- interests (from your profile): ${interests.join(', ')}`)
  // 30 is the same number the retired table used as a verdict threshold; here it
  // only decides what is worth *showing* — the model reads the pressure and
  // rules on it itself.
  const hot = Object.entries(state.juel ?? {})
    .map(([k, p]) => [k, Number(p?.value) || 0])
    .filter(([, v]) => v >= 30)
    .sort((a, b) => b[1] - a[1])
  if (hot.length) lines.push(`- ${hot.map(([k, v]) => `${k} = ${v}${JUEL_MEANINGS[k] ? ` (${JUEL_MEANINGS[k]})` : ''}`).join(', ')} — already hot`)
  // Crystallized weight, flagged separately from mood: settled standing
  // outlives the juel that produced it, and it is invisible to every other
  // surface.
  const carried = carriedParam(state)
  if (carried.length) lines.push(`- carried (standing, not this turn's mood): ${carried.map(([k, v]) => `${k} = ${v}${PARAM_MEANINGS[k] ? ` — ${PARAM_MEANINGS[k]}` : ''}`).join(', ')}`)
  const buffs = (state.buffs ?? []).map(b => b?.name).filter(Boolean)
  if (buffs.length) lines.push(`- active buffs: ${buffs.join(', ')}`)
  // JSON.stringify keeps a multi-line input on one signal line and makes the
  // truncation visible rather than silently cutting the model's evidence.
  if (text) lines.push(`- input: ${JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text)}`)
  return lines.join('\n')
}

/**
 * The step-1 imperative: rule the verdict, emit the call, nothing else.
 *
 * Both forced modes still route through the tool, so there is exactly one code
 * path for a verdict and the route log records forced verdicts too.
 *
 * @param opts.signals - rendered `## Signals` lines, or '' to omit the block
 * @param opts.forced  - 'always' | 'never' | undefined (auto)
 */
export function gateInstruction({ signals = '', forced } = {}) {
  const rule = forced === 'always'
    ? 'The gate is forced CRITICAL for this turn — rule critical:true regardless of what follows.'
    : forced === 'never'
      ? 'The gate is forced ROUTINE for this turn — rule critical:false regardless of what follows.'
      : 'Does this turn deserve deliberation? Apply the gate rule from your protocol.'
  return `[persona gate] ${rule}
Before you rule, run the quick pass — perceive, aim, expect:
- PERCEIVE: what is actually happening in this input? One or two sentences.
- AIM: what does this reply need to achieve?
- EXPECT: if you answered on reflex, what would land on the speaker — would it
  miss, wound, or contradict what you know? An expected miss is the strongest
  reason this turn is loaded. Borderline → routine.

Your only output this step is ONE call — no reply text, no <thinking> yet:

  persona_gate({ critical: true|false, perceive: "<what is happening>", aim: "<what this reply must achieve>", reason: "<why this verdict, in your own words>", delta: { juel: { anger: +8 }, event: "insult" } })

\`perceive\` and \`aim\` are the quick pass, written down — one or two sentences
each, no expansion into a monologue. They are recorded, and on a routine turn
they are the whole of this turn's thinking; on a critical turn they are the
sketch the monologue deepens and may overrule.

\`delta\` is this turn's ledger — what already landed on you while you read the
input, in the same shape \`state_delta\` takes (optional). Record it here, in the
same call, before you choose words: an insult that stings, praise that lands, a
shift in how you stand with the speaker. Leave it out when the turn genuinely
moved nothing — never invent numbers to look diligent, and never batch a whole
scene into one lump. What you record shows up in your next step's state block.

${signals ? `${signals}\n\n` : ''}The reason becomes part of the stage directive when the turn is critical, so write it as yourself, not as a report.
`
}

/** Reply directive for a routine verdict (injected at the next step). */
export const REPLY_DIRECTIVE = '[persona reply] The gate ruled this turn routine. Reply directly, in voice — but read the stance and carried lines in your persona context first: distance and warmth come from the current numbers, never from the persona\'s baseline claims about them. Your voice comes from persona + STATE, the first reference for tone; memory and the conversation supply content truthfulness, a remembered or implied mood never does. No <thinking> block, no preamble, no self-check.'

/** Verdict acknowledgement returned by persona_gate. */
export const GATE_ACK_CRITICAL = 'Verdict recorded: critical. The stage-1 directive arrives in your next input — do not reply yet.'
export const GATE_ACK_ROUTINE = 'Verdict recorded: routine. The reply directive arrives in your next input.'

/**
 * The monologue's required labels — STATE plus the seven aspects, in the order
 * the block must open with. One owner: `stageOnePrompt` renders from this list
 * and `missingMonologueLabels` checks against it, so the directive and the check
 * can never drift apart.
 */
export const MONOLOGUE_LABELS = ['STATE', 'PERCEIVE', 'AIM', 'WANT', 'WEIGH', 'EXPECT', 'CHOICE', 'REASON']

/**
 * Labels a committed monologue never used. Soft check only: a thin block is
 * reported to the transform, never rejected — a hard gate would buy a retry
 * loop for a prompt-shape miss the reply can still absorb.
 */
export function missingMonologueLabels(monologue = '') {
  const text = String(monologue)
  return MONOLOGUE_LABELS.filter(label => !new RegExp(`^\\s*${label}\\s*:`, 'im').test(text))
}

/**
 * Stage-1 directive (the monologue step) — the shape a critical verdict earns.
 * The model's own `reason` opens it, so the block starts from the model's
 * reading of the turn rather than a code-generated label.
 *
 * The block is the deep pass: STATE plus the seven aspects (perceive, aim, want,
 * weigh, expect, choice, reason). The quick pass it deepens is already in the
 * conversation as the persona_gate call — nothing is re-embedded here.
 *
 * @param opts.name   - persona name (call-site symmetry with stageTwoPrompt; the
 *                      directive addresses the model already wearing the persona)
 * @param opts.mbti   - declared MBTI letters, '' for undeclared
 * @param opts.state  - loaded STATE.md data, for the pressure lines
 * @param opts.reason - the model's own words from persona_gate, may be ''
 */
export function stageOnePrompt({ name, mbti = '', state = {}, reason = '' }) {
  return `[persona stage 1 of 2]
The gate ruled this turn critical${reason ? ` — in your words: "${reason}"` : ''}.
This turn gets deliberation, and the deliberation comes first: this step produces the inner monologue and NOTHING else.

Write <thinking>…</thinking> now. Then call inner_commit — that ends this step and hands you the transform directive for the reply.

Write the block from what is already in your persona context, your memory index, and the conversation so far. Do NOT go reading files, logs, or session archives to fill it in — if something is missing, say so in the block and go look AFTER the reply. A block that skips aspects still commits — the transform will be told to answer them in the reply.

The block opens with eight labeled lines — STATE plus the seven aspects, in this
order — then expands freely if the turn is loaded:
STATE: copy the Current state block from your persona context VERBATIM (base, juel, relations, active buffs)
PERCEIVE: what is actually happening right now — the literal input and what it carries; who is speaking; what it touches (values, wounds, stored memories)
AIM: what this reply needs to achieve — what you want out of this exchange
WANT: the deeper want under it — the hunger, need, or fear driving this, whether or not it is said
WEIGH: the trade — cost and gain of each way you could answer, including the ones you reject (what you will NOT say goes here)
EXPECT: how the speaker most likely takes it, and what you expect of yourself if it lands otherwise
CHOICE: what you will actually say — tone + length, Layer 2 as re-tuned by STATE (its \`examples\` are calibration, never lines to lift): persona and state are the first reference for how you sound; memory/context the second
REASON: the root of the action — the motive this comes from, and how it sits with your values and boundaries

The quick pass you ruled on is in this conversation, in your own words. This block
deepens it: PERCEIVE, AIM and CHOICE are re-derived with the whole turn in view,
and you may overrule the sketch — if the verdict itself turns out wrong now, say
so here, never by silently switching shapes.

Inner-monologue tuning (MBTI: ${mbti || 'undeclared'}):
${mbtiRules(mbti)}

State pressure on this thought:
${stateRules(state)}

Output the block and the inner_commit call. No reply text in this step — the reply is the next one.
The block never counts against the immersion boundary: numbers and mechanism words are legal inside it.`
}

/**
 * Stage-2 directive, returned as the inner_commit result. This is the second
 * generation of the turn: the monologue is already committed, and the job now
 * is the transform — same feeling, said out loud.
 *
 * The monologue text is embedded in the directive: request history strips
 * synthetic reasoning blocks before the next generation, so without it the
 * transform would have nothing to transform. It stays inside this tool result —
 * the one channel tagged spans still reach the next step through.
 *
 * `missing` is the soft label check (see missingMonologueLabels): labels the
 * monologue skipped. It never blocks the commit — the transform is asked to
 * answer them in the reply instead, so a thin monologue costs a line of
 * instruction rather than a retry loop.
 */
export function stageTwoPrompt({ name, monologue = '', missing = [] }) {
  return `[persona stage 2 of 2] Inner monologue committed. Now transform it into your reply.
${monologue ? `
Your inner monologue — the reader cannot see it:
${monologue}
` : ''}${missing.length ? `
Your monologue skipped ${missing.join(', ')} — the reply still has to answer ${missing.length > 1 ? 'them' : 'it'}.
` : ''}
Convert that monologue into what you actually say:
- Layer 2 Voice rules are in force: tone, sentence shape, taboos, default length — re-tuned by STATE. Persona and state are the first reference for how you sound; memory and context only set content truthfulness, and shade tone as the second reference.
- The monologue's FEELING carries into the reply; its CONTENTS may be edited, withheld, or sharpened — you say what you'd say, not everything you thought.
- Banned in the reply: numbers, stat names, psych jargon, mechanism nouns, the word "monologue", file paths, tool names. Embody, don't report.
- Output ONLY the reply — no <thinking>, no preamble.`
}

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
 * The monologue is parameterized
 * on this system's knobs: MBTI profile + live STATE (palam peaks, base gauges,
 * relations, buffs) instead of trait thresholds. The reply carries the
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
  E: { praise: { palam: { joy: 1.2 } }, criticism: { palam: { anger: 1.1 } } },
  I: { praise: { palam: { joy: 1.2 } }, criticism: { palam: { shame: 1.3 } } },
  S: { praise: { base: { energy: 1.1 } } },
  N: { praise: { palam: { joy: 1.1 } }, criticism: { palam: { shame: 1.1 } } },
  T: { praise: { palam: { joy: 0.6 } }, criticism: { palam: { anger: 0.7, shame: 0.4 } } },
  F: { praise: { palam: { joy: 1.5 }, relations: { user: 1.2 } }, criticism: { palam: { shame: 1.6 } } },
  J: { criticism: { palam: { anger: 1.2 } } },
  P: { criticism: { palam: { anger: 0.7 } } },
}

/** Layers a reaction profile may address — the same three state_delta writes. */
export const REACTION_LAYERS = ['palam', 'base', 'relations']

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
        throw new Error(`reactions.${event}.${layer} is not a writable layer (palam|base|relations)`)
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
  const peaks = Object.entries(state.palam ?? {})
    .map(([k, p]) => [k, Number(p?.value) || 0])
    .filter(([, v]) => v >= 15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  for (const [k, v] of peaks) rules.push(`- ${k} is running high (${v}) — it colors every thought this turn`)
  for (const [k, f] of Object.entries(state.base ?? {})) {
    const v = Number(f?.value) || 0, max = Number(f?.max) || 100
    if (v / max <= 0.3) rules.push(`- ${k} is low (${v}/${max}) — thoughts run shorter, flatter, tireder`)
  }
  for (const [k, r] of Object.entries(state.relations ?? {})) {
    const v = Number(r?.value) || 0
    if (v <= -30) rules.push(`- you distrust ${k} (${v}) — suspicion first`)
    else if (v >= 30) rules.push(`- you are warm toward ${k} (+${v}) — generosity first`)
  }
  for (const b of state.buffs ?? []) rules.push(`- buff "${b.name}" is active — it is literally on your mind`)
  return rules.length ? rules.join('\n') : '- state is flat — let personality, not mood, carry this one'
}

/**
 * Deterministic gate inputs, rendered as `- ` lines. Cheap facts only — the
 * model reads the input itself; code must not score it.
 *
 * Every access is guarded (`?? {}`, `|| 0`) so a malformed state file yields a
 * thinner signal line instead of breaking the turn. The first-contact line is
 * always present, so this never returns '' — the caller may show it verbatim.
 *
 * @param opts.state - loaded STATE.md data (relations/palam/buffs)
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
  const interests = (meta.interests ?? []).filter(Boolean)
  if (interests.length) lines.push(`- interests (from your profile): ${interests.join(', ')}`)
  // 30 is the same number the retired table used as a verdict threshold; here it
  // only decides what is worth *showing* — the model reads the pressure and
  // rules on it itself.
  const hot = Object.entries(state.palam ?? {})
    .map(([k, p]) => [k, Number(p?.value) || 0])
    .filter(([, v]) => v >= 30)
    .sort((a, b) => b[1] - a[1])
  if (hot.length) lines.push(`- ${hot.map(([k, v]) => `${k} = ${v}`).join(', ')} — already hot`)
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
Your only output this step is ONE call — no reply text, no <thinking> yet:

  persona_gate({ critical: true|false, reason: "<why, in your own words>" })

${signals ? `${signals}\n\n` : ''}The reason becomes part of the stage directive when the turn is critical, so write it as yourself, not as a report.
`
}

/** Reply directive for a routine verdict (injected at the next step). */
export const REPLY_DIRECTIVE = '[persona reply] The gate ruled this turn routine. Reply directly, in voice. No <thinking> block, no preamble, no self-check.'

/** Verdict acknowledgement returned by persona_gate. */
export const GATE_ACK_CRITICAL = 'Verdict recorded: critical. The stage-1 directive arrives in your next input — do not reply yet.'
export const GATE_ACK_ROUTINE = 'Verdict recorded: routine. The reply directive arrives in your next input.'

/**
 * Stage-1 directive (the monologue step) — the shape a critical verdict earns.
 * The model's own `reason` opens it, so the block starts from the model's
 * reading of the turn rather than a code-generated label.
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

Write the block from what is already in your persona context, your memory index, and the conversation so far. Do NOT go reading files, logs, or session archives to fill it in — if something is missing, say so in the block and go look AFTER the reply.

The block opens with four labeled lines, then expands freely if the turn is loaded:
STATE: copy the Current state block from your persona context VERBATIM (base, palam, relations, active buffs)
TRIGGERS: what this input touches — values, wounds, stored memories
REFUSAL: what your persona will NOT say here
VOICE: tone + length for this reply, from Layer 2

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
 */
export function stageTwoPrompt({ name }) {
  return `[persona stage 2 of 2] Inner monologue committed. Now transform it into your reply.

Convert that monologue into what you actually say:
- Layer 2 Voice rules are in force: tone, sentence shape, taboos, default length.
- The monologue's FEELING carries into the reply; its CONTENTS may be edited, withheld, or sharpened — you say what you'd say, not everything you thought.
- Banned in the reply: numbers, stat names, psych jargon, mechanism nouns, the word "monologue", file paths, tool names. Embody, don't report.
- Output ONLY the reply — no <thinking>, no preamble.`
}

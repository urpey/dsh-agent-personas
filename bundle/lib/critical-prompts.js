/**
 * Turn-mode notices — the gate, expressed as ONE-call segments.
 *
 * The step-0 gate decides the turn's shape BEFORE generation starts:
 *   - single segment (routine): the reply alone.
 *   - two segments (critical): a <thinking> inner monologue, then the reply —
 *     both inside the SAME response, so the turn costs one LLM call.
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
 * The notice injected on the FIRST step of a turn — this is step 0 of the
 * the gate, and it fixes the turn's shape before anything is generated.
 * @param mode - 'staged' (critical: monologue step, then reply step) | 'one' (routine: reply only)
 */
export function modeNotice({ mode, mbti = '', state = {}, reason = '' }) {
  if (mode === 'one') {
    return `[persona 1-step turn — routine] Reply directly, in voice. No <thinking> block, no preamble, no self-check.`
  }
  return `[persona 2-step turn — CRITICAL: ${reason}]
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

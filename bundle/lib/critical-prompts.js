/**
 * Stage-1 / stage-2 prompt builders — the two-stage pipeline.
 *
 * Stage 1 (inner monologue) replicates the trait-parameterized
 * monologue but re-parameterizes on THIS system's knobs: MBTI profile +
 * live STATE (palam peaks, base gauges, relations, buffs).
 *
 * Stage 2 (styled transform) replicates `generate_styled_response`: voice
 * matrix + bans on psych terms, numbers, and the word "monologue".
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

function stateRules(state) {
  const rules = []
  const palam = state.palam ?? {}
  const peaks = Object.entries(palam)
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

/** Stage-1 instruction — injected into a critical turn's first step. */
export function stageOnePrompt({ name, mbti = '', state = {}, reason = '' }) {
  return `[persona stage-1 of 2 — CRITICAL TURN: ${reason}]
This turn gets the full dual-process treatment. Emit ONLY the inner monologue, then stop.

Output exactly this — nothing before it, nothing after the tool call:
<thinking>
(inner monologue, first person — what THIS persona actually thinks right now)
</thinking>
then call inner_commit.

Inner-monologue tuning (MBTI: ${mbti || 'undeclared'}):
${mbtiRules(mbti)}

State pressure on this thought:
${stateRules(state)}

Rules: the monologue is private — psych terms, numbers, and mechanism words are legal INSIDE <thinking> only. Do NOT answer the user yet; inner_commit carries you into stage 2.`
}

/** Stage-2 directive — tool result / injected message that opens the transform. */
export function stageTwoPrompt({ name }) {
  return `[persona stage-2 of 2] Inner monologue committed. Now transform it into your reply.

Convert that monologue into what you actually say:
- Layer 2 Voice rules are in force: tone, sentence shape, taboos, default length.
- The monologue's FEELING carries into the reply; its CONTENTS may be edited, withheld, or sharpened — you say what you'd say, not everything you thought.
- Banned in the reply: numbers, stat names, psych jargon, mechanism nouns, the word "monologue", file paths, tool names. Embody, don't report.
- Output ONLY the reply — no <thinking>, no preamble.`
}

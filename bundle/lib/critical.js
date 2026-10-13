/**
 * Critical-interaction gate — Step 0.
 *
 * Decides whether a turn needs the full two-generation pipeline
 * (inner monologue → styled transform) or the routine single-pass
 * four-line check. Mirrors the critical-interaction check:
 * first contact, emotional/conflict keywords, persona-interest hits —
 * plus a state-driven criterion (palam spike / named buff) and a
 * contradiction cue.
 */

/** zh/en keyword tables, adapted from the dual-process design. */
export const CRITICAL_KEYWORDS = {
  zh: [
    '喜欢', '讨厌', '生气', '开心', '难过', '愤怒', '失望', '惊喜', '爱', '恨',
    '查抄', '紧张', '病', '婚事', '离开', '死', '担心', '委屈',
    '议论', '指责', '质疑', '威胁', '危机', '紧急', '重大', '关键',
    '错', '不对', '重写', '回滚', '崩溃', '故障',
  ],
  en: [
    'love', 'hate', 'angry', 'happy', 'sad', 'disappointed', 'surprised', 'excited',
    'sick', 'blood', 'marriage', 'leave', 'die', 'worry', 'threat', 'crisis', 'urgent',
    'wrong', 'broken', 'rollback', 'critical', 'emergency',
  ],
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * @param opts.text          newest user-visible text of this step
 * @param opts.meta          PERSONA frontmatter: { interests?: string[] }
 * @param opts.state         STATE.md frontmatter data
 * @param opts.extraKeywords deployment-added keywords (config.criticalKeywords)
 * @returns { critical: boolean, reason: string }  reason feeds the stage-1 notice
 */
export function assessTurn({ text = '', meta = {}, state = {}, extraKeywords = [] }) {
  const lower = text.toLowerCase()

  // Criterion 1 — first contact: no relation entry yet for the speaker key.
  const rel = state.relations ?? {}
  if (!rel.user && !rel.speaker) {
    return { critical: true, reason: 'first contact — no relation record for this speaker' }
  }

  // Criterion 2 — emotional / conflict keywords (the upstream design table + extras).
  const kws = [...CRITICAL_KEYWORDS.zh, ...CRITICAL_KEYWORDS.en, ...extraKeywords]
  const hit = kws.find(k => k && lower.includes(String(k).toLowerCase()))
  if (hit) return { critical: true, reason: `emotional/conflict keyword: "${hit}"` }

  // Criterion 3 — topic hits the persona's declared interests.
  for (const interest of meta.interests ?? []) {
    if (interest && lower.includes(String(interest).toLowerCase())) {
      return { critical: true, reason: `persona interest hit: "${interest}"` }
    }
  }

  // Criterion 4 — state pressure: any palam ≥ 30, or a named buff is active.
  // (State-contradiction proxy: strong accumulated affect means the reflex
  // answer is likely the wrong one.)
  for (const [k, p] of Object.entries(state.palam ?? {})) {
    if (num(p?.value) >= 30) return { critical: true, reason: `palam pressure: ${k}=${p.value}` }
  }
  const buffs = state.buffs ?? []
  if (buffs.length) return { critical: true, reason: `active buffs: ${buffs.map(b => b.name).join(', ')}` }

  return { critical: false, reason: '' }
}

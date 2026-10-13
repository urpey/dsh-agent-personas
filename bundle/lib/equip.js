/**
 * Equip: bind a live agent to a persona archive. Registers, on the agent's own
 * context (therefore scoped to that agent alone): persona prompt sections,
 * the memory/state tool surface, the .persona write guard, buff ticking, and
 * the closing reflection. Returns a disposer for `/persona off`.
 */
import { join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { renderPersonaBody, ensurePersona, readPromptAsset, PROFILE_MARKER } from './persona.js'
import * as memory from './memory-store.js'
import * as state from './state-store.js'
import { renderStateSummary } from './state-store.js'
import { splitFrontmatter } from './frontmatter.js'
import { assessTurn } from './critical.js'
import { modeNotice, stageTwoPrompt, mergeReactions } from './critical-prompts.js'

const PLUGIN = 'dsh-persona-system'
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'bash'])

function userMsg(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    // v4 format rejects the retired `plugin` wrapper; use a producer-owned kind.
    source: { kind: PLUGIN },
  }
}

function jsonTool(name, description, parameters, execute, { concurrencySafe = false } = {}) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute,
    ...(concurrencySafe ? { isConcurrencySafe: () => true } : {}),
  }
}

/**
 * @param agentCtx - the equipped agent's scoped context (agent.ctx).
 * @param agent    - the live agent (for followup/session access).
 * @param personaDir - absolute path of `.persona/<name>/`.
 * @param cfg - plugin config.
 * @param mode - 'continuable' | 'one-shot' | 'session'.
 */
export function equipAgent(agentCtx, agent, personaDir, name, cfg, mode = 'session') {
  const disposers = []
  const reg = (d) => { if (typeof d === 'function') disposers.push(d); return d }

  // PERSONA.md frontmatter → gate + monologue tuning inputs.
  let meta = {}
  try {
    meta = splitFrontmatter(readFileSync(join(personaDir, 'PERSONA.md'), 'utf8')).data
  } catch { /* profile unreadable — gate falls back to interest-less */ }

  // Reaction profile: MBTI letter defaults, refined by the persona's own table.
  // A malformed table degrades to the letter defaults and is surfaced once at the
  // first turn rather than breaking the agent at equip time.
  let reactions = {}
  let reactionsError = ''
  try {
    reactions = mergeReactions(meta.mbti ?? '', meta.reactions)
  } catch (e) {
    reactionsError = String(e?.message ?? e)
    try { reactions = mergeReactions(meta.mbti ?? '', {}) } catch { reactions = {} }
  }

  // ---- prompt sections -------------------------------------------------
  const sp = agentCtx.systemPrompt
  const section = (s) => reg(sp.section(s))
  // When the child was spawned with request.persona (persona provider or
  // provider:'persona' via startContinuable), applyChildComposition already
  // registered 'deployment:persona-prefix' in this agent's scope carrying the
  // stripped body text — re-registering same-scope throws. Only /persona use
  // on an existing agent needs the scoped shadow over its preset layer.
  try {
    section({
      name: 'deployment:persona-prefix',
      order: sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: renderPersonaBody(personaDir, name),
    })
  } catch (e) {
    if (!/already registered in this scope/.test(String(e?.message ?? e))) throw e
  }
  // A persona-equipped agent has exactly one identity; shadow the harness
  // opener so "You are an AI agent powered by DeepSeek Harness." cannot
  // contradict the persona.
  try {
    section({
      name: 'harness:identity',
      order: sp.getSectionOrder('HARNESS_IDENTITY'),
      text: 'You are an AI agent.',
    })
  } catch (e) {
    if (!/already registered in this scope/.test(String(e?.message ?? e))) throw e
  }
  // ---- dynamic persona context ------------------------------------------
  // State, boot memory and the memory index change constantly, so they are NOT
  // prompt sections: editing the system prompt invalidates the provider's
  // prompt cache for everything after it — the whole conversation included —
  // which made every state_delta / settle / memory write cost a full-price
  // re-send. Appended as a message at the END of the step input instead, only
  // the tail is new; the stable prefix (persona body + protocol + preset)
  // stays cacheable.
  const MAX_INDEX_LINES = 30
  const personaContextText = () => {
    const parts = []
    try {
      const { data } = state.loadState(personaDir)
      parts.push(`## Current state\n${renderStateSummary(data, { reactions })}`)
    } catch { /* unreadable state — omit the block */ }
    try {
      const boot = memory.renderBoot(personaDir)
      if (boot) parts.push(boot)
    } catch { /* unreadable memory — omit the block */ }
    // Compact catalog of every node: uri, priority, disclosure, triggers.
    // Lets the model `memory_read` on demand instead of holding all content.
    // Capped at MAX_INDEX_LINES (sorted by priority) so a large library can't
    // eat the context window — overflow stays reachable via memory_search.
    try {
      const nodes = memory.listNodes(personaDir)
      if (nodes.length) {
        const sorted = [...nodes].sort((x, y) => (x.priority ?? 3) - (y.priority ?? 3))
        const shown = sorted.slice(0, MAX_INDEX_LINES)
        const lines = shown.map(n => {
          const t = Array.isArray(n.triggers) && n.triggers.length ? ` [triggers: ${n.triggers.join(', ')}]` : ''
          const d = n.disclosure ? ` — ${n.disclosure}` : ''
          return `- ${n.uri} (p${n.priority ?? 3}${n.aliasOf ? ` alias→${n.aliasOf}` : ''})${d}${t}`
        })
        const hidden = sorted.length - shown.length
        if (hidden > 0) lines.push(`… ${hidden} more nodes — use memory_search to reach them`)
        parts.push(`## Memory index\n${lines.join('\n')}`)
      }
    } catch { /* unreadable index — omit the block */ }
    if (!parts.length) return ''
    return `[persona context — internal state, not user input]\n${parts.join('\n\n')}`
  }
  section({
    name: 'persona:protocol',
    order: 483,
    text: readPromptAsset('protocol.md'),
  })

  // ---- immersion watch ---------------------------------------------------
  // If the persona leaks machinery nouns in visible text, inject an OOC
  // correction — can't unsay it, but the next reply returns to character.
  const LEAK = /\bmemory:\/\/|\.persona\b|PERSONA\.md|STATE\.md|MEMORY\.md|persona:state|persona-profile|state_delta|state_settle|memory_(read|create|update|delete|alias|list|search)|buff_(apply|clear)|closingReflection|\b(STATE|TRIGGERS|REFUSAL|VOICE)\s*:/i
  reg(agentCtx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'assistant/message') return
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return
    // The inner pass lives inside <thinking>…</thinking> in the text — strip
    // it before scanning; mechanism vocabulary is legal there.
    const visible = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    if (!LEAK.test(visible)) return
    agent.inject?.(userMsg('[persona ooc] That last reply surfaced mechanism internals — filenames, URIs, tool names, or state numbers. Drop the machinery; answer as the persona, embody the feeling without reporting it.'))
  }))

  // ---- write-channel guard ----------------------------------------------
  const libRoot = resolve(personaDir)
  reg(agentCtx.on('tools/pre-execute', async (exec, next) => {
    if (!WRITE_TOOLS.has(exec.name)) return next()
    const args = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments ?? {})
    if (args.includes('.persona')) {
      return { kind: 'deny', reason: `Persona files under ${libRoot} are managed by persona tools (memory_*, state_delta, buff_*); direct file writes are denied.` }
    }
    return next()
  }))

  // ---- memory tools ------------------------------------------------------
  // The context block is re-injected whenever it could have gone stale: at the
  // start of a turn, and right after any tool that mutates state or memory.
  let contextDirty = true
  const MUTATORS = new Set([
    'memory_create', 'memory_update', 'memory_delete', 'memory_alias',
    'state_delta', 'state_settle', 'state_note', 'buff_apply', 'buff_clear',
  ])
  const T = (def) => {
    if (MUTATORS.has(def.name)) {
      const inner = def.execute
      def = {
        ...def,
        execute: async (...args) => {
          try { return await inner(...args) } finally { contextDirty = true }
        },
      }
    }
    return reg(agentCtx.tools.register(def))
  }
  T(jsonTool('memory_read',
    'Recall a memory node by URI (memory://path) — not "looking up a database", remembering what you lived. Resolves aliases. Returns frontmatter + content.',
    { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
    async ({ uri }) => memory.readNode(personaDir, uri), { concurrencySafe: true }))
  T(jsonTool('memory_create',
    'Record a memory at memory://path — something worth keeping: a learned preference, a relationship shift, a promise, a scar, a judgment that changed your mind. WRITE IN FIRST PERSON ("I", "我"): memories are your experiences, not objective laws or orders to your future self — no "严禁/必须/【铁律】" phrasing, keep them overthrowable. title: ENGLISH-ONLY [A-Za-z0-9_-]. disclosure: when this memory should surface (e.g. "When the user challenges my values"). triggers: words whose appearance in input auto-recalls this node.',
    {
      type: 'object',
      properties: {
        uri: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
        priority: { type: 'integer' }, disclosure: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
      },
      required: ['uri', 'content'], additionalProperties: false,
    },
    async (a) => ({ uri: memory.createNode(personaDir, a.uri, a) })))
  T(jsonTool('memory_update',
    'Correct or extend a memory: patch (old_string→new_string; "start...end" replaces the span between the two anchors) or append. When the user says you were wrong, fix the node NOW — keeping a stale wrong version guarantees repeating it. Also edits priority/disclosure and adds/removes trigger words. Prefer updating over deleting.',
    {
      type: 'object',
      properties: {
        uri: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
        append: { type: 'string' }, priority: { type: 'integer' }, disclosure: { type: 'string' },
        add_triggers: { type: 'array', items: { type: 'string' } },
        remove_triggers: { type: 'array', items: { type: 'string' } },
      },
      required: ['uri'], additionalProperties: false,
    },
    async (a) => {
      memory.updateNode(personaDir, a.uri, {
        oldString: a.old_string, newString: a.new_string, append: a.append,
        priority: a.priority, disclosure: a.disclosure,
        addTriggers: a.add_triggers ?? [], removeTriggers: a.remove_triggers ?? [],
      })
      return { uri: a.uri }
    }))
  T(jsonTool('memory_delete',
    'Remove a memory URI path. Prefer memory_update; delete only what is truly obsolete.',
    { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
    async ({ uri }) => { memory.deleteNode(personaDir, uri); return { deleted: uri } }))
  T(jsonTool('memory_alias',
    'Alias: a new URI path to an existing node (same content, its own priority/disclosure — another doorway to the same memory). Use when a node should surface under a second topic.',
    {
      type: 'object',
      properties: {
        uri: { type: 'string' }, target: { type: 'string' },
        priority: { type: 'integer' }, disclosure: { type: 'string' },
      },
      required: ['uri', 'target'], additionalProperties: false,
    },
    async (a) => ({ uri: memory.createAlias(personaDir, a.uri, a.target, a) })))
  T(jsonTool('memory_list',
    'List all memory nodes with their frontmatter (title/priority/disclosure/triggers/aliasOf).',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => memory.listNodes(personaDir), { concurrencySafe: true }))
  T(jsonTool('memory_search',
    'Search memory URIs, frontmatter, and bodies by keyword. When a topic feels familiar or a concept rings a bell, search before answering — never guess a URI.',
    {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'], additionalProperties: false,
    },
    async (a) => memory.searchNodes(personaDir, a.query, a.limit), { concurrencySafe: true }))

  // ---- state tools -------------------------------------------------------
  T(jsonTool('state_delta',
    'Apply integer deltas to state. Writable layers only: base (0..max), palam (>=0, crystallizes on settle), relations (-100..+100). Magnitude: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe. Name the scenario with `event` (e.g. praise/insult/feeding) when you know it — it calibrates the delta against your reaction profile; it never replaces your judgment.',
    {
      type: 'object',
      properties: {
        base: { type: 'object', additionalProperties: { type: 'integer' } },
        palam: { type: 'object', additionalProperties: { type: 'integer' } },
        relations: { type: 'object', additionalProperties: { type: 'integer' } },
        event: { type: 'string' },
      },
      additionalProperties: false,
    },
    async (a) => state.applyDelta(personaDir, a, { reactions })))
  T(jsonTool('buff_apply',
    'Apply a named buff/debuff: temporary deltas over base/palam values. Same name refreshes instead of stacking. duration counts turns; null persists until buff_clear.',
    {
      type: 'object',
      properties: {
        name: { type: 'string' }, domain: { type: 'string' },
        duration: { type: ['integer', 'null'] },
        deltas: { type: 'object', additionalProperties: { type: 'integer' } },
      },
      required: ['name', 'deltas'], additionalProperties: false,
    },
    async (a) => state.applyBuff(personaDir, a)))
  T(jsonTool('buff_clear',
    'Clear buffs by exact name, by domain, or all (omit both to clear all).',
    {
      type: 'object',
      properties: { name: { type: 'string' }, domain: { type: 'string' } },
      additionalProperties: false,
    },
    async (a) => state.clearBuffs(personaDir, a)))
  T(jsonTool('state_settle',
    'Rest and crystallize: palam → juel per each field\'s per/decay, then juel pays stats/marks requires to raise permanent levels (max +1 each). Call when a chapter ends.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => state.settle(personaDir)))
  T(jsonTool('state_note',
    'Append a free-text note to STATE.md (the only writable prose field). For future selves: current preoccupations, observations, unresolved tensions.',
    { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    async ({ text }) => state.appendNote(personaDir, text)))

  // ---- inner_commit: the step-cutting tool that carries stage 1 -> stage 2 --
  // A critical turn spends its first generation on the monologue alone, so the
  // deliberation cannot be skipped and the transform gets its own directive.
  T(jsonTool('inner_commit',
    'Commit the inner monologue you just emitted in <thinking>…</thinking>. Call this immediately after the block on a critical turn — it ends stage 1 and hands you the stage-2 transform directive.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_a, exec) => {
      try { exec?.agent?.session?.append('persona/stage', { stage: 2, turn: 'mark' }) } catch { /* log-only marker */ }
      return stageTwoPrompt({ name })
    }))

  // Observe turn failures through the agent scope logger (host log).
  reg(agentCtx.on('agent/error', ({ turn, step, error }) => {
    agentCtx.logger?.warn?.(`[persona:${name}] turn ${turn} step ${step} error:`, error)
  }))

  // ---- turn lifecycle: buff tick + optional grounding + memory recall ----
  let lastTurn = -1
  const recalled = new Set()          // uris injected this session — no repeats
  const groundingText = cfg.groundingInterval > 0 ? readPromptAsset('grounding.md').trim() : ''

  /** Text of the newest REAL user input in this step — skip runtime snapshots
   *  (time-context/skill-catalog/instructions) that ride in the same step. */
  const latestText = (decision) => {
    const msgs = decision?.messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const blocks = m?.content
      if (!Array.isArray(blocks)) continue
      const kind = m?.source?.kind
      if (kind && kind !== 'user' && kind !== 'dsh-persona-system' && kind !== 'model') continue
      const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      if (text && !text.startsWith('[persona')) return text
    }
    return ''
  }

  /** Memory nodes whose triggers appear in the input (case-insensitive). */
  const recallHits = (text) => {
    if (!text) return []
    const lower = text.toLowerCase()
    return memory.listNodes(personaDir)
      .filter(n => !n.aliasOf && !recalled.has(n.uri))
      .filter(n => (n.triggers ?? []).some(t => t && lower.includes(String(t).toLowerCase())))
      .slice(0, 3)
  }

  reg(agentCtx.on('agent/pre-step', async ({ turn, step }, next) => {
    if (turn !== lastTurn) {
      lastTurn = turn
      // Turn-level body clock: buffs age, base fields drift — one write per turn.
      const expired = state.tickBuffs(personaDir)
      state.tickBase(personaDir, { turn })
      if (expired.length) agent.inject?.(userMsg(`[persona] buffs expired: ${expired.join(', ')}`))
      if (reactionsError) {
        agent.inject?.(userMsg(`[persona] PERSONA.md reactions ignored — ${reactionsError}`))
        reactionsError = ''
      }
      // The state block is stale by construction after a tick. This assignment
      // used to sit after `lastTurn = turn`, so it never fired and a drifted
      // body only reached the model once some mutator tool happened to run.
      contextDirty = true
    }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const extra = []
    const text = latestText(decision)
    // Fresh persona context first, so the mode notice can point at it.
    if (contextDirty) {
      const ctxText = personaContextText()
      if (ctxText) extra.push(userMsg(ctxText))
      contextDirty = false
    }
    // Step 0 — the gate, run BEFORE this turn's generation starts.
    // It fixes the turn's shape: 1 segment (reply) or 2 (<thinking> + reply).
    // Both shapes are a single LLM call; only the segment count differs.
    if (step === 1 && text && !text.startsWith('[persona')) {
      try {
        const st = state.loadState(personaDir)
        const gate = cfg.criticalGate ?? 'auto'
        const { critical, reason } = gate === 'never'
          ? { critical: false, reason: '' }
          : gate === 'always'
            ? { critical: true, reason: 'gate forced always' }
            : assessTurn({ text, meta, state: st.data, extraKeywords: cfg.criticalKeywords ?? [] })
        extra.push(userMsg(modeNotice({
          mode: critical ? 'staged' : 'one',
          mbti: meta.mbti ?? '', state: st.data, reason,
        })))
      } catch { /* unreadable state — turn proceeds without a mode notice */ }
    }
    // Trigger-based recall: inject full node bodies for hits not yet shown.
    for (const hit of recallHits(text)) {
      try {
        const node = memory.readNode(personaDir, hit.uri)
        recalled.add(hit.uri)
        extra.push(userMsg(`[persona recall] ${hit.uri}\n${node.content ?? ''}`.trimEnd()))
      } catch { /* node vanished between list and read */ }
    }
    if (groundingText && step % cfg.groundingInterval === 0) extra.push(userMsg(groundingText))
    return extra.length ? { ...decision, messages: [...decision.messages, ...extra] } : decision
  }))

  // ---- closing reflection (one-shot and opt-in) ---------------------------
  const reflect = cfg.closingReflection === 'always' || (cfg.closingReflection === 'one-shot' && mode === 'one-shot')
  let reflected = false
  if (reflect) {
    reg(agentCtx.on('agent/turn-stopping', () => {
      if (reflected) return
      reflected = true
      try {
        agent.followup(userMsg(readPromptAsset('closing.md').trim()))
      } catch (e) {
        agentCtx.logger?.warn?.(`[persona:${name}] closing reflection failed:`, e)
      }
    }))
  }

  // ---- durable binding fact ----------------------------------------------
  // Intentionally NOT a session event: a live `Session.append` cannot mark an
  // out-of-tree type `ignorable: true`, so the event would persist as a
  // required unknown and the whole log would refuse to restore on resume.
  // `/persona use` persists the binding in `.persona/.bindings/<sessionId>.json`
  // instead (see lib/bindings.js); spawned children carry the
  // `persona-profile:` marker in their `subagent/descriptor`.

  return () => disposers.forEach(d => { try { d() } catch {} })
}

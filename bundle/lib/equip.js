/**
 * Equip: bind a live agent to a persona archive. Registers, on the agent's own
 * context (therefore scoped to that agent alone): persona prompt sections,
 * the memory/state tool surface, the .persona write guard, buff ticking, and
 * the closing reflection. Returns a disposer for `/persona off`.
 */
import { join, resolve, dirname } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { renderPersonaBody, ensurePersona, readPromptAsset, PROFILE_MARKER } from './persona.js'
import * as memory from './memory-store.js'
import * as state from './state-store.js'
import { renderStateSummary } from './state-store.js'
import { splitFrontmatter } from './frontmatter.js'
import { gateInstruction, signalsLine, stageOnePrompt, stageTwoPrompt, mergeReactions,
         missingMonologueLabels, GATE_ACK_CRITICAL, GATE_ACK_ROUTINE, REPLY_DIRECTIVE } from './critical-prompts.js'
import { appendRoute } from './route-log.js'
import { transformThinkingStream, stripThinkingFromMessages } from './thinking-tags.js'

const PLUGIN = 'dsh-agent-personas'
// Sessions persisted before the rename carry `source.kind: 'dsh-persona-system'`
// on this plugin's injected messages; latestText must still accept them.
const LEGACY_PLUGIN = 'dsh-persona-system'
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'bash'])

function userMsg(text) {
  return {
    // Every injected message carries its own id. The inbox rejects a duplicate
    // pending id across both lists, and a message with NO id collides with any
    // other id-less message — so an unidentified injection could throw (losing
    // the directive) whenever another plugin happened to have something queued.
    // The harness mints user-message ids the same way: a UUID string.
    id: randomUUID(),
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
          return `- ${n.uri} (p${n.priority ?? 3}${n.title ? ` · ${n.title}` : ''}${n.aliasOf ? ` · alias→${n.aliasOf}` : ''})${d}${t}`
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
  //
  // The correction is *stored*, not injected here: this listener runs inside the
  // session's own append publish, and a nested `inject()` throws ("cannot reenter
  // while another append is being published"), which silently dropped every
  // correction. The pre-step hook delivers it with the rest of the step's
  // context — which is the step the correction is for anyway.
  let pendingOoc = ''
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
    pendingOoc = '[persona ooc] That last reply surfaced mechanism internals — filenames, URIs, tool names, or state numbers. Drop the machinery; answer as the persona, embody the feeling without reporting it.'
  }))

  // ---- write-channel guard ----------------------------------------------
  const libRoot = resolve(personaDir)
  // The route log belongs to the LIBRARY, not the persona: `.persona/.routes/`
  // sits beside `.bindings/` so it survives `/persona off` and one session's
  // verdicts stay one file. `libRoot` is the persona dir (the write guard's
  // boundary), so step up one level for the library.
  const routesRoot = dirname(libRoot)
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
  // Did this turn write a ledger entry — a `delta` on the gate call or a
  // `state_delta` call? Turn-stopping reads it to log a `no-delta` verdict, so
  // "the model stopped recording" becomes a number in the route log instead of
  // silence. Reset at each turn boundary.
  let deltaRecorded = false
  const MUTATORS = new Set([
    'memory_create', 'memory_update', 'memory_delete', 'memory_alias',
    'state_delta', 'state_settle', 'state_note', 'buff_apply', 'buff_clear',
  ])
  // One owner for the writable-delta shape: `state_delta` and the gate's ledger
  // take exactly the same object, so they can never drift apart.
  const DELTA_SCHEMA = {
    type: 'object',
    properties: {
      base: { type: 'object', additionalProperties: { type: 'integer' } },
      juel: { type: 'object', additionalProperties: { type: 'integer' } },
      relations: { type: 'object', additionalProperties: { type: 'integer' } },
      event: { type: 'string' },
    },
    additionalProperties: false,
  }
  /** A delta that names no field is not a ledger entry — applying it would
   *  rewrite STATE.md (dropping comments) to record nothing. */
  const hasDeltaFields = (d) => !!d && typeof d === 'object'
    && ['base', 'juel', 'relations'].some(l => d[l] && typeof d[l] === 'object' && Object.keys(d[l]).length > 0)
  /** Optional string argument, trimmed — '' for anything else. */
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
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
    'Recall a memory node by URI (memory://path) — not "looking up a database", remembering what you lived. Resolves aliases. Returns frontmatter + content + children/see-also links — follow them instead of guessing URIs.',
    { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false },
    async ({ uri }) => {
      const node = memory.readNode(personaDir, uri)
      // Pulled by hand → the push channel must not re-deliver the same body.
      // An alias read marks the resolved target too — same content.
      recalled.add(uri)
      if (node.aliasTarget) recalled.add(node.aliasTarget)
      return { ...node, ...memory.neighborhood(personaDir, node) }
    }, { concurrencySafe: true }))
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
    async (a) => {
      const uri = memory.createNode(personaDir, a.uri, a)
      // Advisory only (L2 convention — notices, never rejections): a node
      // without disclosure is a bare URI row to the index reader.
      return a.disclosure
        ? { uri }
        : { uri, notice: 'no disclosure — the index shows only this URI; memory_update can add one if it should surface on context' }
    }))
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
  // `state_delta` is the mid-turn beat, not the per-turn ledger: the gate call
  // already carries this turn's entry (see `persona_gate`). Use it for what
  // lands AFTER the verdict — a second sting inside a critical turn, a shift
  // that only surfaces while writing the reply.
  T(jsonTool('state_delta',
    'Apply integer deltas to state, mid-turn. Writable layers only: base (0..max), juel (signed -100..∞ — negative is banked amends, it burns the emitted param on settle), relations (-100..+100). Magnitude: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe. Name the scenario with `event` (e.g. praise/insult/feeding) when you know it — it calibrates the delta against your reaction profile; it never replaces your judgment. The gate call already carries a `delta` for what landed while reading the input; use this tool for what lands after it.',
    DELTA_SCHEMA,
    async (a) => {
      const r = state.applyDelta(personaDir, a, { reactions })
      deltaRecorded = true
      return r
    }))
  T(jsonTool('buff_apply',
    'Apply a named buff/debuff: temporary deltas over base/juel values. Same name refreshes instead of stacking. duration counts turns; null persists until buff_clear.',
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
    'Rest and crystallize: juel → param per each field\'s per/decay (negative juel burns param back — banked amends pay standing down, floored at 0), then param pays stats/marks requires to raise permanent levels (max +1 each). Call when a chapter ends.',
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
    'Commit the inner monologue you just emitted in <thinking>…</thinking>. Call this immediately after the block on a critical turn — it ends stage 1 and hands you the stage-2 transform directive with your monologue attached.',
    { type: 'object', properties: {}, additionalProperties: false },
    async (_a) => {
      // No `session.append('persona/stage', …)` here: `Session.append` cannot
      // mark an out-of-tree type `ignorable: true`, so the event persisted as
      // a required unknown and made the whole log refuse to restore (see the
      // "durable binding fact" note below — same rule).
      // The monologue landed, so turn-stopping must not queue stage 2 again.
      awaitingMonologue = false
      // The transform carries its own source: history strips synthetic
      // reasoning before the next request, so the monologue has to ride the
      // tool result — this makes stage 2 self-contained rather than lucky.
      // The label check is soft: a block that skipped aspects still commits,
      // and the transform is told to answer them in the reply.
      const monologue = lastMonologue()
      return stageTwoPrompt({ name, monologue, missing: missingMonologueLabels(monologue) })
    }))

  // ---- persona_gate: the model's verdict, carried by a stub tool -------------
  // The criteria live in prompts/protocol.md and the step-1 instruction, never
  // here: the tool holds no judgment, it records the verdict the model already
  // made and hands back the directive for the next step. `reason` is the model's
  // own words and opens the stage-1 directive, so the monologue starts from its
  // own reasoning instead of a code-generated string. `perceive`/`aim` are the
  // quick pass written down (perceive → aim → choice): on a routine turn they
  // ARE this turn's thinking, on a critical turn they are the sketch the
  // monologue deepens. Both are optional — a verdict never fails for a thin
  // quick pass — but the directive asks for them and the route log records them.
  reg(agentCtx.tools.register({
    name: 'persona_gate',
    description: 'Rule whether this turn deserves deliberation — loaded turns think first. Call it alone, before any reply text; the same call carries the quick pass (`perceive`, `aim`) and this turn\'s `delta` ledger entry (what already landed on you).',
    parameters: {
      type: 'object',
      properties: {
        critical: { type: 'boolean' },
        perceive: { type: 'string', description: 'the quick pass — what is actually happening in this input, one or two sentences' },
        aim: { type: 'string', description: 'the quick pass — what this reply needs to achieve' },
        reason: { type: 'string', description: 'why this verdict, in your own words — it opens the stage-1 directive' },
        delta: { ...DELTA_SCHEMA, description: 'this turn\'s ledger: what already landed on you while you read the input (same shape as state_delta). Omit it when the turn moved nothing.' },
      },
      required: ['critical'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const critical = args?.critical === true
      const reason = str(args?.reason)
      const perceive = str(args?.perceive)
      const aim = str(args?.aim)
      gateCalled = true
      awaitingMonologue = critical
      // The verdict is also the turn's ledger entry. Applying it here (before
      // the state is loaded for the directive) means the monologue's pressure
      // lines already include what just landed, and the next step's state block
      // shows it. A malformed delta degrades to a notice: the verdict and its
      // directive must survive a bad ledger entry.
      let ledger = null
      let ledgerNotice = ''
      if (hasDeltaFields(args?.delta)) {
        try {
          const r = state.applyDelta(personaDir, args.delta, { reactions })
          deltaRecorded = true
          ledger = r.changed
          ledgerNotice = r.notice ?? ''
        } catch (e) {
          ledgerNotice = `delta not applied — ${String(e?.message ?? e)}`
        }
      }
      let st = {}
      try { st = state.loadState(personaDir).data } catch { /* unreadable state — the directive degrades */ }
      pendingDirective = critical
        ? stageOnePrompt({ name, mbti: meta.mbti ?? '', state: st, reason })
        : REPLY_DIRECTIVE
      // The next step must read the state the verdict was ruled against.
      contextDirty = true
      appendRoute(routesRoot, exec?.agent?.session?.header?.id, {
        at: new Date().toISOString(),
        turn: lastTurn,
        step: lastStep,
        verdict: critical ? 'critical' : 'routine',
        reason,
        signals: lastSignals,
        // The quick pass, when the model wrote it. Absent fields are omitted so
        // the log's base shape (and every pre-existing line) stays what it was.
        ...(perceive ? { perceive } : {}),
        ...(aim ? { aim } : {}),
        // Only present when a ledger entry was actually written, so the log's
        // base shape stays what it always was.
        ...(ledger ? { delta: ledger } : {}),
      })
      const ack = critical ? GATE_ACK_CRITICAL : GATE_ACK_ROUTINE
      return ledgerNotice ? `${ack}\n[persona] ${ledgerNotice}` : ack
    },
  }))

  // Observe turn failures through the agent scope logger (host log).
  reg(agentCtx.on('agent/error', ({ turn, step, error }) => {
    agentCtx.logger?.warn?.(`[persona:${name}] turn ${turn} step ${step} error:`, error)
  }))

  // ---- <thinking> extraction --------------------------------------------
  // The protocol's inner monologue is written as literal <thinking>…</thinking>
  // inside reply text. Two seams give it a real block type without touching
  // the log: the stream transform splits tagged spans into reasoning blocks on
  // the way out (UI folds them into the thinking row), and the deriveMessages
  // wrapper strips synthetic reasoning + tag residue from request history so
  // the monologue is never replayed to the provider — only the transform is
  // replayed, never the tags. See lib/thinking-tags.js.
  const equippedSessionId = agent?.session?.header?.id ?? agent?.session?.id
  reg(agentCtx.on('llm/stream', (options, next) =>
    options?.sessionId === equippedSessionId
      ? transformThinkingStream(next())
      : next()))
  // Wrap once per session: a re-equip must not stack a second strip layer.
  // Fake sessions in unit tests may not implement deriveMessages at all.
  const session = agent?.session
  if (session && typeof session.deriveMessages === 'function' && !session.__personaStripThinking) {
    const derive = session.deriveMessages.bind(session)
    session.deriveMessages = () => stripThinkingFromMessages(derive())
    session.__personaStripThinking = true
  }

  /**
   * The monologue this turn just produced, recovered from the session log.
   * deriveMessages is wrapped, but snapshotEvents reads the raw log — the
   * reasoning block is still there even though requests will never see it.
   * Falls back to a literal-tag extract for logs written before the transform.
   */
  const lastMonologue = () => {
    try {
      const evs = session?.snapshotEvents?.() ?? []
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i]?.type !== 'assistant/message') continue
        const blocks = evs[i]?.data?.message?.content ?? []
        const reasoning = blocks
          .filter(b => b?.type === 'reasoning')
          .map(b => b.text ?? '')
          .join('\n')
          .trim()
        if (reasoning) return reasoning
        const literal = blocks
          .filter(b => b?.type === 'text')
          .map(b => b.text ?? '')
          .join('\n')
          .match(/<thinking>([\s\S]*?)(?:<\/thinking>|$)/)
        if (literal?.[1]?.trim()) return literal[1].trim()
        return ''
      }
    } catch { /* log unreadable — stage 2 renders without the monologue */ }
    return ''
  }

  // ---- turn lifecycle: buff tick + optional grounding + memory recall ----
  let lastTurn = -1
  let lastStep = -1
  const recalled = new Set()          // uris injected this session — no repeats
  const groundingText = cfg.groundingInterval > 0 ? readPromptAsset('grounding.md').trim() : ''

  /**
   * Queue model-facing context on the inbox, never letting a queue failure take
   * the turn down with it.
   *
   * Why the guard matters: `inject()` is a splice into the pending inbox, and the
   * inbox rejects a second id-less message while one is already pending. These
   * notices are worth delivering, but they are not worth a turn — and a throw
   * here would happen at the turn boundary, before any model request, so the
   * reader would get nothing at all.
   */
  const notice = (text) => {
    try { agent.inject?.(userMsg(text)) } catch (e) {
      agentCtx.logger?.warn?.(`[persona:${name}] notice dropped — ${text}:`, e)
    }
  }

  // Gate state, scoped to one turn. The verdict is produced by the model mid-turn,
  // so the directive it earns cannot ride the step that produced it — it is owed
  // to the NEXT step, and these four flags are the whole state machine.
  let pendingDirective = ''    // directive owed to the next step
  let awaitingMonologue = false // critical verdict committed, inner_commit not yet called
  let gateCalled = false       // this turn produced a verdict
  let gateOffered = false      // the gate instruction was shown at least once
  let gateReoffered = false    // ...and the one re-ask has been spent
  let lastSignals = ''         // rendered signals, for the route log

  /** Text of the newest REAL user input in this step — skip runtime snapshots
   *  (time-context/skill-catalog/instructions) that ride in the same step.
   *  Returns the source kind too: the gate rules on the USER's turn, so it must
   *  never be re-triggered by the assistant's own last message. */
  const latestText = (messages) => {
    const msgs = messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      const blocks = m?.content
      if (!Array.isArray(blocks)) continue
      const kind = m?.source?.kind
      if (kind && kind !== 'user' && kind !== PLUGIN && kind !== LEGACY_PLUGIN && kind !== 'model') continue
      const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      if (text && !text.startsWith('[persona')) return { text, kind }
    }
    return { text: '', kind: undefined }
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

  reg(agentCtx.on('agent/pre-step', async ({ turn, step, messages }, next) => {
    lastStep = step
    if (turn !== lastTurn) {
      lastTurn = turn
      // A new turn rules its own verdict: nothing carries over.
      gateCalled = false
      gateOffered = false
      gateReoffered = false
      awaitingMonologue = false
      pendingDirective = ''
      lastSignals = ''
      deltaRecorded = false
      // Turn-level body clock: buffs age, base fields drift — one write per turn.
      const expired = state.tickBuffs(personaDir)
      state.tickBase(personaDir, { turn })
      // Both notices ride ONE queue call: a second id-less pending message is
      // rejected by the inbox, and at the turn boundary that rejection used to
      // abort the turn before any request was made.
      const notices = []
      if (expired.length) notices.push(`[persona] buffs expired: ${expired.join(', ')}`)
      if (reactionsError) {
        notices.push(`[persona] PERSONA.md reactions ignored — ${reactionsError}`)
        reactionsError = ''
      }
      if (notices.length) notice(notices.join('\n'))
      // The state block is stale by construction after a tick. This assignment
      // used to sit after `lastTurn = turn`, so it never fired and a drifted
      // body only reached the model once some mutator tool happened to run.
      contextDirty = true
    }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const extra = []
    // The payload carries this step's claimed messages; the terminal decision may
    // not, so read the input from the payload.
    const { text, kind: textKind } = latestText(messages)
    // Fresh persona context first, so everything after it can point at it.
    if (contextDirty) {
      const ctxText = personaContextText()
      if (ctxText) extra.push(userMsg(ctxText))
      contextDirty = false
    }
    // The directive a verdict earned, owed to the step after it. Injected once.
    if (pendingDirective) {
      extra.push(userMsg(pendingDirective))
      pendingDirective = ''
    }
    // Gate step — the verdict is the model's, so the turn opens with the
    // imperative rather than a mode notice decided in code. Offered on the first
    // user-bearing step of a turn, and re-offered ONCE if that step went by
    // without a verdict (a model may answer straight away; the turn is not
    // interrupted, it is asked once more and then logged as a miss).
    if (!gateCalled && (!gateOffered || !gateReoffered) && step <= 2 && text && textKind === 'user') {
      let st = {}
      try { st = state.loadState(personaDir).data } catch { /* unreadable state — signals degrade */ }
      lastSignals = signalsLine({ state: st, meta, text })
      const forced = cfg.criticalGate === 'always' || cfg.criticalGate === 'never'
        ? cfg.criticalGate
        : undefined
      if (gateOffered) gateReoffered = true
      gateOffered = true
      extra.push(userMsg(gateInstruction({ signals: lastSignals, forced })))
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
    // The immersion correction stored by the leak watcher, delivered at the step
    // it is for. It goes before the gate instruction: it is about the previous
    // reply, and the gate — when this step carries one — must stay the last thing
    // the model reads.
    if (pendingOoc) {
      extra.push(userMsg(pendingOoc))
      pendingOoc = ''
    }
    // The gate instruction is the LAST thing the model reads, so the verdict is
    // ruled on the whole input — recall bodies, grounding, and any correction
    // included — rather than on a partial view with context appended after the ask.
    const gateMsg = extra.findIndex(m => String(m.content?.[0]?.text ?? '').startsWith('[persona gate]'))
    if (gateMsg >= 0 && gateMsg !== extra.length - 1) extra.push(extra.splice(gateMsg, 1)[0])
    return extra.length ? { ...decision, messages: [...decision.messages, ...extra] } : decision
  }))

  // ---- turn-stopping recovery ---------------------------------------------
  // Registered before the closing reflection (handlers fire in registration
  // order) so a turn that owes itself a directive pays it before housekeeping.
  reg(agentCtx.on('agent/turn-stopping', ({ agent: stopped }) => {
    const sessionId = stopped?.session?.header?.id ?? agent?.session?.header?.id
    // The turn was offered the gate, ruled, and wrote no ledger entry — no
    // `delta` on the verdict and no `state_delta` call. The reply is left
    // intact: this only makes the omission visible, so "state is not updated
    // every turn" is a count in the route log instead of silence. Logged ahead
    // of the directive branches below because it is independent of them.
    if (gateCalled && !deltaRecorded) {
      appendRoute(routesRoot, sessionId, {
        at: new Date().toISOString(),
        turn: lastTurn,
        step: lastStep,
        verdict: 'no-delta',
        reason: '',
        signals: lastSignals,
      })
    }
    // A verdict with no step left to consume it. A tool call normally opens
    // another step, so this is rare — but if the gate call was the step's last
    // act, the directive would be lost with it.
    //
    // `inject` alone is the right call here, and adding `followup` was a defect:
    // the inbox rejects a second pending id-less message, so the pair threw on
    // every run (inside a bare catch) and never woke the driver; with identified
    // messages it would instead deliver the same directive twice. A non-empty
    // next-step queue is itself what makes the loop re-enter, so one queue call
    // delivers exactly once.
    if (pendingDirective) {
      const owed = pendingDirective
      pendingDirective = ''
      notice(owed)
      return
    }
    // A critical turn that never committed its monologue must not end as a bare
    // monologue or a silent drop — hand it the transform directive. This one
    // does need `followup`: the turn has genuinely ended, and nothing else will
    // wake the driver for a message the model owes itself.
    if (awaitingMonologue) {
      awaitingMonologue = false
      try {
        const monologue = lastMonologue()
        agent.followup(userMsg(stageTwoPrompt({ name, monologue, missing: missingMonologueLabels(monologue) })))
      } catch (e) {
        agentCtx.logger?.warn?.(`[persona:${name}] stage-2 recovery failed:`, e)
      }
      return
    }
    // The model answered without ever ruling. The turn is left intact — the
    // reader got an answer — but the miss is what the route log exists to show.
    // Only a turn that was actually OFFERED the gate can miss it: a turn with no
    // user text (a closing-reflection housekeeping turn, for one) was never asked,
    // and logging that as non-compliance would make the log lie.
    if (!gateCalled && gateOffered) {
      appendRoute(routesRoot, sessionId, {
        at: new Date().toISOString(),
        turn: lastTurn,
        step: lastStep,
        verdict: 'missed',
        reason: '',
        signals: lastSignals,
      })
    }
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
  // The ledger in `.persona/.bindings/<sessionId>.json` is the ONE durable
  // owner of "which persona is this session equipped with" (see
  // lib/bindings.js): `/persona use` registers the session it equipped, every
  // spawn path registers the child session it created, and the client's picker
  // reads the same row for its 已装备 badge. A `subagent/descriptor` marker is
  // NOT a second channel — continuable spawns carry persona BODY text only
  // (lib/provider.js `personaBodyText`), so nothing could parse a name from it.

  return () => disposers.forEach(d => { try { d() } catch {} })
}

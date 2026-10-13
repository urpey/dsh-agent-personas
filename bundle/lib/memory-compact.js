/**
 * In-process memory compaction: one auxiliary `ctx.llm.stream()` call, no agent.
 *
 * `/persona compact` used to run the audit as a one-shot structured SUBAGENT.
 * That bought a child session, the whole persona machinery (tools, gate,
 * closing reflection) and a ~22k-token agent envelope — to obtain one edit
 * plan. It polluted the session list, tripped the structured-run guard in the
 * child's closing turn (every tool denied after `structured_output`), and took
 * minutes of wall clock.
 *
 * This module is the seam `dsh-compaction-basic` uses for context compaction —
 * one auxiliary call with `purpose: 'compaction'` — aimed at the memory TREE
 * instead of a session span. It is deliberately NOT `ctx.compaction`: that
 * service replaces session-surface spans addressed by `SessionSeq`, and a file
 * tree is outside its contract.
 *
 * The model contract is unchanged: one tool (`structured_output`) carrying
 * `PLAN_SCHEMA`, called once. Tree semantics stay in code —
 * `renderMemorySnapshot` feeds the whole tree in, `validatePlan` is the hard
 * gate, `applyPlan` performs every write. The model never touches a file.
 *
 * @module dsh-persona-system/memory-compact
 */
import { readPromptAsset } from './persona.js'
import { PLAN_SCHEMA, renderMemorySnapshot, validatePlan, applyPlan, describePlan } from './memory-plan.js'

/** The one tool the audit model may call; the name is the whole contract. */
export const COMPACT_TOOL = 'structured_output'

/**
 * Default output cap for the plan: the 65_536 `headroomTokens` the harness's
 * own context compaction uses. `update` ops carry whole node bodies and
 * reasoning blocks count against the same budget — and `maxTokens` is a limit,
 * not a target, so overshooting costs nothing unless the model rambles.
 */
const DEFAULT_MAX_TOKENS = 65_536

/**
 * Ceiling for truncation escalation: when a configured `compactMaxTokens`
 * below the default runs out, the cap doubles toward this bound instead of
 * giving up. At the default it is already reached and a truncated answer just
 * fails.
 */
const MAX_TOKENS_CEILING = 65_536

/** Default re-asks after an unreadable answer; 0 disables the retry. */
const DEFAULT_RETRIES = 1

/**
 * Description copied verbatim from the harness's structured-run tool, so the
 * model sees the exact contract it would see inside a structured subagent.
 */
const TOOL_DESCRIPTION
  = 'Report your final structured result. Call this exactly once, when your answer is complete; '
    + 'the arguments must match this tool\'s parameter schema exactly.'

/** The tool declaration sent with the request. */
export function compactToolSchema() {
  return { name: COMPACT_TOOL, description: TOOL_DESCRIPTION, parameters: PLAN_SCHEMA }
}

/**
 * Resolve the provider/model for the compaction call: explicit config first,
 * then the last routed request, then the agent's own options. Mirrors
 * `summarizeWithLlm`'s fallback so one mental model covers both.
 *
 * `reasoningEffort` is intentionally NOT inherited: a routed `max` is what made
 * the old subagent run take minutes. The adapter default applies unless
 * `compactReasoningEffort` says otherwise.
 *
 * @param cfg - resolved plugin config.
 * @param agent - the command's agent, for routing facts.
 * @returns the provider/model pair to call.
 * @throws when no route can be resolved at all.
 */
export function resolveCompactTarget(cfg = {}, agent) {
  const configured = cfg.compactProvider && cfg.compactModel
    ? { provider: cfg.compactProvider, model: cfg.compactModel }
    : undefined
  const routed = agent?.session?.requestHeader?.()?.config
  const fromRoute = routed?.provider && routed?.model
    ? { provider: routed.provider, model: routed.model }
    : undefined
  const fromAgent = agent?.options?.provider && agent?.options?.model
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? fromRoute ?? fromAgent
  if (target === undefined) {
    throw new Error(
      'no provider/model available for memory compaction: set compactProvider+compactModel, '
      + 'route one request, or set both AgentOptions fields',
    )
  }
  return target
}

/** One request's messages: the audit prompt plus the whole tree, as ONE user turn. */
function compactMessages(dir, note) {
  const head = readPromptAsset('compact.md').trim()
  // The re-ask keeps both doors open: a tool call is the contract, but an
  // adapter that ignores `tools` on a one-shot request still lands through the
  // JSON-in-text extractor.
  const retry = note
    ? `\n\nYour previous answer did not yield a complete plan (${note}). Send the plan again as ONE JSON object `
      + `of the shape \`{"ops": [...]}\` — call \`${COMPACT_TOOL}\` with it if you can, otherwise make that JSON object your entire message.`
    : ''
  return [{ role: 'user', content: [{ type: 'text', text: `${head}${retry}\n\n${renderMemorySnapshot(dir)}` }] }]
}

/**
 * Fold a chunk stream into blocks, exactly as `BlockAssembler` does for the
 * pieces this call uses: deltas accumulate per index, `block-end` is
 * authoritative, and a stream with no `finish` chunk reads as `stop`.
 * @returns a stateful accumulator: `push(chunk)` then `result()`.
 */
function createAccumulator() {
  const partials = new Map()
  const order = []
  let finish
  let usage
  const ensure = (index, blockType) => {
    let partial = partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', toolCallId: undefined, toolCallName: undefined, toolCallArguments: '', block: undefined }
      partials.set(index, partial)
      order.push(index)
    }
    return partial
  }
  return {
    push(chunk) {
      switch (chunk?.type) {
        case 'block-start':
          ensure(chunk.index, chunk.blockType)
          return
        case 'text-delta':
        case 'reasoning-delta': {
          const partial = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
          if (partial.block) return
          partial.text += chunk.text ?? ''
          return
        }
        case 'tool-call-delta': {
          const partial = ensure(chunk.index, 'tool-call')
          if (partial.block) return
          partial.toolCallId = chunk.id
          if (chunk.name) partial.toolCallName = chunk.name
          partial.toolCallArguments += chunk.argumentsDelta ?? ''
          return
        }
        case 'block-end': {
          const partial = ensure(chunk.index, chunk.block?.type ?? 'text')
          if (partial.block) return
          partial.block = chunk.block
          return
        }
        case 'usage':
          usage = chunk.usage
          return
        case 'finish':
          finish = chunk.reason
          return
        default:
          return
      }
    },
    result() {
      const blocks = order.map((index) => {
        const partial = partials.get(index)
        if (partial.block) return partial.block
        switch (partial.blockType) {
          case 'text': return { type: 'text', text: partial.text }
          case 'reasoning': return { type: 'reasoning', text: partial.text }
          case 'tool-call':
            return {
              type: 'tool-call',
              id: partial.toolCallId ?? `call-${index}`,
              name: partial.toolCallName ?? '',
              arguments: partial.toolCallArguments,
            }
          default: return { type: 'text', text: partial.text }
        }
      })
      return { blocks, finish: finish ?? { kind: 'stop' }, usage }
    },
  }
}

/**
 * Fold an already-collected chunk list (pure; the unit-test seam).
 * @param chunks - raw chunks in stream order.
 * @returns the assembled blocks, the finish reason, and usage when reported.
 */
export function foldChunks(chunks) {
  const accumulator = createAccumulator()
  for (const chunk of chunks) accumulator.push(chunk)
  return accumulator.result()
}

/** Fold a live `ctx.llm.stream()` iterable. */
async function foldStream(stream) {
  const accumulator = createAccumulator()
  for await (const chunk of stream) accumulator.push(chunk)
  return accumulator.result()
}

/**
 * Find the first balanced `{…}` object in free text (handles ```json fences
 * because it only looks for the brace).
 * @param text - model text.
 * @returns the object source, or undefined when no object closes.
 */
function firstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Parse a plan value; only an object with an `ops` array counts. */
function parsePlan(source) {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  const trimmed = source.trim()
  const candidate = trimmed.startsWith('{') ? trimmed : firstJsonObject(trimmed)
  if (candidate === undefined) return undefined
  try {
    const value = JSON.parse(candidate)
    return value !== null && typeof value === 'object' && Array.isArray(value.ops) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the plan out of the assembled blocks: the `structured_output` tool call
 * first, then any tool call, then JSON text as the fallback for adapters that
 * will not emit a tool call on a one-shot request.
 * @param blocks - assembled content blocks.
 * @returns the plan object, or undefined when the answer carried none.
 */
export function planFromBlocks(blocks) {
  const calls = (blocks ?? []).filter(block => block?.type === 'tool-call')
  const preferred = calls.find(block => block.name === COMPACT_TOOL) ?? calls[0]
  if (preferred !== undefined) {
    const plan = parsePlan(preferred.arguments)
    if (plan !== undefined) return plan
  }
  for (const block of blocks ?? []) {
    if (block?.type !== 'text') continue
    const plan = parsePlan(block.text)
    if (plan !== undefined) return plan
  }
  return undefined
}

/** Map a terminal finish to its fail-closed error (mirrors `summarizeWithLlm`). */
function finishError(finish) {
  switch (finish?.kind) {
    case 'error':
    case 'aborted':
      return new Error(`compaction call ${finish.kind === 'aborted' ? 'was aborted' : 'failed'}: ${finish.failure?.message ?? finish.kind}`)
    default:
      return undefined
  }
}

/** An error the command reports as a refusal rather than a transport failure. */
function planRefused(message) {
  const error = new Error(message)
  error.code = 'PLAN_REFUSED'
  return error
}

/**
 * Run the compaction: one auxiliary call (plus optional re-asks), then the
 * existing validate → apply → report pipeline. Nothing is written until the
 * plan validates against the same snapshot the model reasoned about.
 *
 * @param ctx - plugin context providing the `llm` service.
 * @param options - `cfg`, the calling `agent`, the persona `dir`, optional `signal`.
 * @returns the operator-facing report plus call facts.
 * @throws on a transport failure, an unreadable answer, or a refused plan.
 */
export async function compactWithLlm(ctx, { cfg = {}, agent, dir, signal }) {
  const target = resolveCompactTarget(cfg, agent)
  const retries = Number.isSafeInteger(cfg.compactRetries) && cfg.compactRetries >= 0
    ? cfg.compactRetries
    : DEFAULT_RETRIES
  const attempts = retries + 1
  let maxTokens = Number.isSafeInteger(cfg.compactMaxTokens) && cfg.compactMaxTokens > 0
    ? cfg.compactMaxTokens
    : DEFAULT_MAX_TOKENS

  let note
  let lastFailure
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const options = {
      provider: target.provider,
      model: target.model,
      ...cfg.compactReasoningEffort === undefined ? {} : { reasoningEffort: cfg.compactReasoningEffort },
      messages: compactMessages(dir, note),
      tools: [compactToolSchema()],
      maxTokens,
      sessionId: agent?.session?.header?.id ?? agent?.session?.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    const { blocks, finish, usage } = await foldStream(ctx.llm.stream(options))
    const failure = finishError(finish)
    if (failure !== undefined) throw failure
    if (finish?.kind === 'max-tokens') {
      // The answer came back cut short: escalate the cap rather than give up —
      // a bigger plan was the point of the budget, not a failure of it.
      lastFailure = 'truncated'
      const next = Math.min(MAX_TOKENS_CEILING, maxTokens * 2)
      if (attempt < attempts && next > maxTokens) {
        note = 'the output was cut off by the token cap'
        maxTokens = next
        continue
      }
      break
    }
    const plan = planFromBlocks(blocks)
    if (plan === undefined) {
      lastFailure = 'no-plan'
      note = 'no structured_output call carrying an `ops` array was found'
      continue
    }
    let report
    try {
      const { ops, warnings } = validatePlan(dir, plan)
      report = describePlan(applyPlan(dir, ops), warnings)
    } catch (e) {
      // Half-applied is worse than refused: validatePlan runs before any write.
      throw planRefused(e?.message ?? String(e))
    }
    return { report, attempts: attempt, usage, provider: target.provider, model: target.model }
  }
  if (lastFailure === 'truncated') {
    throw new Error(
      `compaction truncated at the token cap (maxTokens ${maxTokens}) after ${attempts} attempt${attempts === 1 ? '' : 's'}`
      + ' — raise compactMaxTokens or compactRetries',
    )
  }
  const error = new Error(`produced no plan (${note}) after ${attempts} attempt${attempts === 1 ? '' : 's'}`)
  error.code = 'NO_PLAN'
  throw error
}

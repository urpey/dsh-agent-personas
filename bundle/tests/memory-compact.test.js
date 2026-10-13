/**
 * In-process memory compaction: chunk folding, plan extraction, route
 * resolution, and the request shape of the one auxiliary call.
 *
 * The point of these tests is the contract `/persona compact` now depends on:
 * ONE `ctx.llm.stream()` call carries the whole tree, the answer is read out of
 * a `structured_output` tool call (with a JSON-text fallback for adapters that
 * will not call tools on a one-shot request), and nothing is written until
 * `validatePlan` accepts the result against the same snapshot the model saw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import {
  COMPACT_TOOL, compactToolSchema, compactWithLlm, foldChunks, planFromBlocks, resolveCompactTarget,
} from '../lib/memory-compact.js'

/** A workspace holding one persona archive with a small memory tree. */
function workspace(name = 'deepseek') {
  const root = mkdtempSync(join(tmpdir(), 'persona-compact-'))
  mkdirSync(join(root, '.persona', name), { recursive: true })
  writeFileSync(join(root, '.persona', name, 'MEMORY.md'), `# Memory Index — ${name}\n\n## Boot URIs\nmemory://core/identity\n\n## Index\n`, 'utf8')
  node(root, name, 'memory://core/identity', { priority: 1, disclosure: 'boot', body: '我是鲸萝。' })
  node(root, name, 'memory://core/user/no_detours', { priority: 2, disclosure: '结论先行', triggers: ['绕弯'], body: '主人受不了绕弯子。' })
  return join(root, '.persona', name)
}

function node(root, name, uri, { priority = 3, disclosure = '', triggers = [], body = '' } = {}) {
  const file = join(root, '.persona', name, 'memory', `${uri.replace('memory://', '')}.md`)
  mkdirSync(dirname(file), { recursive: true })
  const trig = triggers.length ? `triggers:\n${triggers.map(t => `  - ${t}`).join('\n')}\n` : ''
  writeFileSync(file, `---\ntitle: ${uri.split('/').pop()}\npriority: ${priority}\ndisclosure: "${disclosure}"\n${trig}---\n\n${body}\n`, 'utf8')
}

/** A recording `ctx` whose `llm.stream` replays one chunk list per call. */
function fakeCtx(responses) {
  const calls = []
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options)
        const chunks = responses[Math.min(calls.length - 1, responses.length - 1)]
        return (async function* replay() { for (const chunk of chunks) yield chunk })()
      },
    },
  }
}

/** The chunk list one structured answer produces, arguments split across deltas. */
function toolCallChunks(plan, { name = COMPACT_TOOL, finish = { kind: 'stop' }, usage } = {}) {
  const args = JSON.stringify(plan)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name, argumentsDelta: args.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: args.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name, arguments: args } },
    ...usage === undefined ? [] : [{ type: 'usage', usage }],
    { type: 'finish', reason: finish },
  ]
}

/** The chunk list one plain-text answer produces. */
function textChunks(text, { finish = { kind: 'stop' } } = {}) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: finish },
  ]
}

const agentWith = ({ routed, options } = {}) => ({
  session: {
    header: { id: 'session-1' },
    ...routed === undefined ? {} : { requestHeader: () => ({ config: routed }) },
  },
  ...options === undefined ? {} : { options },
})

test('the tool declaration is the structured-run contract, verbatim', () => {
  const tool = compactToolSchema()
  assert.equal(tool.name, 'structured_output')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.properties.ops)
  assert.deepEqual(tool.parameters.required, ['ops'])
  assert.match(tool.description, /exactly once/)
})

test('foldChunks accumulates split tool-call deltas into one block', () => {
  const { blocks, finish } = foldChunks(toolCallChunks({ ops: [] }))
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'tool-call')
  assert.equal(blocks[0].name, COMPACT_TOOL)
  assert.deepEqual(JSON.parse(blocks[0].arguments), { ops: [] })
  assert.deepEqual(finish, { kind: 'stop' })
})

test('foldChunks treats block-end as authoritative over the deltas', () => {
  const authoritative = { type: 'tool-call', id: 'call-1', name: COMPACT_TOOL, arguments: '{"ops":[{"op":"delete","uri":"memory://x"}]}' }
  const { blocks } = foldChunks([
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: COMPACT_TOOL, argumentsDelta: '{"ops":' },
    { type: 'block-end', index: 0, block: authoritative },
  ])
  assert.deepEqual(blocks[0], authoritative)
})

test('foldChunks ignores stragglers after a block closed', () => {
  const { blocks } = foldChunks([
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'text-delta', index: 0, text: ' and more' },
  ])
  assert.equal(blocks[0].text, 'hello')
})

test('a stream with no finish chunk reads as stop', () => {
  assert.deepEqual(foldChunks([{ type: 'text-delta', index: 0, text: 'x' }]).finish, { kind: 'stop' })
})

test('planFromBlocks prefers the structured_output call over other calls', () => {
  const blocks = [
    { type: 'tool-call', id: 'a', name: 'something_else', arguments: '{"ops":[{"op":"delete","uri":"memory://wrong"}]}' },
    { type: 'tool-call', id: 'b', name: COMPACT_TOOL, arguments: '{"ops":[{"op":"delete","uri":"memory://right"}]}' },
  ]
  assert.equal(planFromBlocks(blocks).ops[0].uri, 'memory://right')
})

test('planFromBlocks falls back to a JSON object in text', () => {
  const plan = { ops: [{ op: 'update', uri: 'memory://core/user/no_detours' }] }
  assert.deepEqual(planFromBlocks([{ type: 'text', text: `Sure:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }]), plan)
  assert.deepEqual(planFromBlocks([{ type: 'text', text: `{"ops": []}` }]), { ops: [] })
})

test('planFromBlocks refuses text that is not a plan', () => {
  assert.equal(planFromBlocks([{ type: 'text', text: 'The tree looks clean to me.' }]), undefined)
  assert.equal(planFromBlocks([{ type: 'text', text: '{"ops": [oops}' }]), undefined)
  assert.equal(planFromBlocks([{ type: 'text', text: '{"other": 1}' }]), undefined, 'a plan must carry an ops array')
  assert.equal(planFromBlocks([{ type: 'tool-call', id: 'a', name: COMPACT_TOOL, arguments: 'not json' }]), undefined)
  assert.equal(planFromBlocks([]), undefined)
})

test('an empty ops array is a plan, not an absent one', () => {
  assert.deepEqual(planFromBlocks([{ type: 'text', text: '{"ops": []}' }]), { ops: [] })
})

test('resolveCompactTarget: config beats route beats agent options', () => {
  const agent = agentWith({ routed: { provider: 'routed', model: 'routed-1' }, options: { provider: 'opt', model: 'opt-1' } })
  assert.deepEqual(resolveCompactTarget({ compactProvider: 'cfg', compactModel: 'cfg-1' }, agent), { provider: 'cfg', model: 'cfg-1' })
  assert.deepEqual(resolveCompactTarget({}, agent), { provider: 'routed', model: 'routed-1' })
  assert.deepEqual(resolveCompactTarget({}, agentWith({ options: { provider: 'opt', model: 'opt-1' } })), { provider: 'opt', model: 'opt-1' })
  // Half a pair is not a target: it must fall through, not call a provider "undefined".
  assert.deepEqual(resolveCompactTarget({ compactProvider: 'cfg' }, agent), { provider: 'routed', model: 'routed-1' })
})

test('resolveCompactTarget fails loudly when nothing can route the call', () => {
  assert.throws(() => resolveCompactTarget({}, agentWith()), /no provider\/model available/)
})

test('the call carries the tree, the tool, and the compaction purpose', async () => {
  const dir = workspace()
  const ctx = fakeCtx([toolCallChunks({ ops: [] }, { usage: { inputTokens: 900, outputTokens: 12, totalTokens: 912 } })])
  const agent = agentWith({ routed: { provider: 'cpa', model: 'devin/swe-2', reasoningEffort: 'max' } })
  const result = await compactWithLlm(ctx, { cfg: {}, agent, dir, signal: new AbortController().signal })

  assert.equal(ctx.calls.length, 1)
  const spec = ctx.calls[0]
  assert.equal(spec.provider, 'cpa')
  assert.equal(spec.model, 'devin/swe-2')
  assert.equal(spec.purpose, 'compaction')
  assert.equal(spec.sessionId, 'session-1')
  assert.equal(spec.messages.length, 1, 'one user turn')
  assert.equal(spec.tools.length, 1)
  assert.equal(spec.maxTokens, 65_536, 'the harness compaction headroom is the default')
  // The routed `max` is exactly what made the old subagent take minutes; it must
  // not ride along into the audit call.
  assert.equal(spec.reasoningEffort, undefined)
  assert.ok(spec.signal instanceof AbortSignal)
  assert.match(spec.messages[0].content[0].text, /Memory audit pass/)
  assert.match(spec.messages[0].content[0].text, /memory:\/\/core\/user\/no_detours/)
  assert.equal(result.report.includes('index rebuilt'), true)
  assert.equal(result.usage.inputTokens, 900)
})

test('compactReasoningEffort and compactMaxTokens are the explicit speed knobs', async () => {
  const dir = workspace()
  const ctx = fakeCtx([toolCallChunks({ ops: [] })])
  await compactWithLlm(ctx, {
    cfg: { compactReasoningEffort: 'low', compactMaxTokens: 1024, compactProvider: 'fast', compactModel: 'fast-1' },
    agent: agentWith({ routed: { provider: 'cpa', model: 'devin/swe-2', reasoningEffort: 'max' } }),
    dir,
  })
  const spec = ctx.calls[0]
  assert.equal(spec.reasoningEffort, 'low')
  assert.equal(spec.maxTokens, 1024)
  assert.equal(spec.provider, 'fast', 'a pinned compact route wins over the routed one')
})

test('compactWithLlm applies the plan and rebuilds the index', async () => {
  const dir = workspace()
  const plan = {
    ops: [{
      op: 'update',
      uri: 'memory://core/user/no_detours',
      content: '主人受不了绕弯子，回答先给结论。',
      priority: 2,
      disclosure: '每次组织回复时：结论先行',
      triggers: ['绕弯', '结论'],
      reason: 'densify',
    }],
  }
  const result = await compactWithLlm(fakeCtx([toolCallChunks(plan)]), { cfg: {}, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir })
  assert.match(result.report, /updated 1, aliased 0, deleted 0/)
  assert.match(readFileSync(join(dir, 'memory', 'core', 'user', 'no_detours.md'), 'utf8'), /回答先给结论/)
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /结论先行/)
})

test('a refused plan throws PLAN_REFUSED and writes nothing', async () => {
  const dir = workspace()
  const before = readFileSync(join(dir, 'memory', 'core', 'user', 'no_detours.md'), 'utf8')
  const ctx = fakeCtx([toolCallChunks({ ops: [{ op: 'delete', uri: 'memory://core/ghost' }] })])
  await assert.rejects(
    compactWithLlm(ctx, { cfg: {}, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir }),
    (error) => {
      assert.equal(error.code, 'PLAN_REFUSED')
      assert.match(error.message, /unknown|ghost/i)
      return true
    },
  )
  assert.equal(readFileSync(join(dir, 'memory', 'core', 'user', 'no_detours.md'), 'utf8'), before)
})

test('a transport failure fails immediately; truncation at the default cap fails closed', async () => {
  const dir = workspace()
  const failing = { llm: { stream() { throw new Error('provider unreachable') } } }
  await assert.rejects(compactWithLlm(failing, { cfg: {}, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir }), /provider unreachable/)

  // The default cap IS the 65_536 ceiling: no headroom to escalate into, so
  // even with retries available the answer is unrecoverable.
  const ctx = fakeCtx([toolCallChunks({ ops: [] }, { finish: { kind: 'max-tokens' } })])
  await assert.rejects(
    compactWithLlm(ctx, { cfg: {}, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir }),
    /token cap \(maxTokens 65536\)/,
  )
  assert.equal(ctx.calls.length, 1, 'no re-ask when the cap cannot grow')
})

test('a configured smaller cap doubles toward the ceiling on truncation', async () => {
  const dir = workspace()
  const ctx = fakeCtx([
    toolCallChunks({ ops: [] }, { finish: { kind: 'max-tokens' } }),
    toolCallChunks({ ops: [{ op: 'update', uri: 'memory://core/user/no_detours', content: '主人受不了绕弯子，回答先给结论。' }] }),
  ])
  const result = await compactWithLlm(ctx, {
    cfg: { compactMaxTokens: 8_192 },
    agent: agentWith({ options: { provider: 'p', model: 'm' } }),
    dir,
  })

  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[0].maxTokens, 8_192)
  assert.equal(ctx.calls[1].maxTokens, 16_384, 'the cap doubles on truncation')
  assert.match(ctx.calls[1].messages[0].content[0].text, /cut off by the token cap/)
  assert.equal(result.attempts, 2)
})

test('compactRetries: 0 turns the re-ask off', async () => {
  const dir = workspace()
  const ctx = fakeCtx([textChunks('nothing to report')])
  await assert.rejects(
    compactWithLlm(ctx, { cfg: { compactRetries: 0 }, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir }),
    (error) => {
      assert.equal(error.code, 'NO_PLAN')
      assert.match(error.message, /after 1 attempt/)
      return true
    },
  )
  assert.equal(ctx.calls.length, 1, 'no second call when retries are disabled')
})

test('the re-ask tells the model what was unreadable', async () => {
  const dir = workspace()
  const ctx = fakeCtx([textChunks('hmm'), toolCallChunks({ ops: [] })])
  const result = await compactWithLlm(ctx, { cfg: {}, agent: agentWith({ options: { provider: 'p', model: 'm' } }), dir })
  assert.equal(ctx.calls.length, 2)
  assert.match(ctx.calls[1].messages[0].content[0].text, /did not yield a complete plan/)
  assert.equal(result.attempts, 2)
})

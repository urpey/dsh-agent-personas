import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transformThinkingStream, stripThinkingFromMessages } from '../lib/thinking-tags.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Drive the transform over a chunk list; returns emitted chunks in order. */
const run = async (chunks) => {
  const out = []
  for await (const c of transformThinkingStream((async function* () { yield* chunks })())) out.push(c)
  return out
}

/** A conventional adapter stream for one text block + finish. */
const textStream = (pieces, { finish } = {}) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...pieces.map((text, i) => ({ type: 'text-delta', index: 0, text })),
  { type: 'block-end', index: 0, block: { type: 'text', text: pieces.join('') } },
  finish ?? { type: 'finish', reason: { kind: 'stop' } },
]

/** Emitted block contents, reconstructed from block-end chunks. */
const blocksOf = (out) =>
  out.filter(c => c.type === 'block-end').map(c => c.block)

/** Emitted text block bodies — what the reader would see, one entry per block. */
const textBlocksOf = (out) => blocksOf(out).filter(b => b.type === 'text').map(b => b.text)

/** Every reasoning-delta payload joined — what the thinking row shows. */
const reasoningOf = (out) =>
  out.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')

/** Emitted indexes in stream order, for contiguity assertions. */
const emittedIndexes = (out) =>
  out.filter(c => c.type === 'block-start').map(c => c.index)

// ---------------------------------------------------------------------------
// outbound: tag → reasoning block
// ---------------------------------------------------------------------------

test('mid-text tag splits into text + reasoning + text', async () => {
  const out = await run(textStream(['Hello <thinking>secret</thinking> world']))
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'Hello' },
    { type: 'reasoning', text: 'secret' },
    { type: 'text', text: 'world' },
  ])
  assert.deepEqual(emittedIndexes(out), [0, 1, 2])
  assert.deepEqual(textBlocksOf(out), ['Hello', 'world'])
  assert.equal(reasoningOf(out), 'secret')
})

test('tag at block head: whitespace before it is scaffolding, dropped', async () => {
  const out = await run(textStream(['\n\n<thinking>monologue</thinking>\n\nreply']))
  assert.deepEqual(blocksOf(out), [
    { type: 'reasoning', text: 'monologue' },
    { type: 'text', text: 'reply' },
  ])
  assert.deepEqual(textBlocksOf(out), ['reply'])
})

test('multiple tags in one block produce multiple reasoning blocks', async () => {
  const out = await run(textStream(['A<thinking>x</thinking>B<thinking>y</thinking>C']))
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'A' },
    { type: 'reasoning', text: 'x' },
    { type: 'text', text: 'B' },
    { type: 'reasoning', text: 'y' },
    { type: 'text', text: 'C' },
  ])
  assert.deepEqual(emittedIndexes(out), [0, 1, 2, 3, 4])
})

test('unclosed tag swallows the rest of the block into reasoning', async () => {
  const out = await run(textStream(['Hi <thinking>stream cut off']))
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'Hi' },
    { type: 'reasoning', text: 'stream cut off' },
  ])
})

test('open tag split across chunks is still detected', async () => {
  const out = await run(textStream(['Hello <thin', 'king>secret</thinking> world']))
  // The space before '<thin' was already released before the tag could be
  // confirmed — emitted deltas cannot be taken back, so it rides the text
  // block. Whitespace is only dropped when the tag is seen in the same scan.
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'Hello ' },
    { type: 'reasoning', text: 'secret' },
    { type: 'text', text: 'world' },
  ])
})

test('close tag split across chunks is still detected', async () => {
  const out = await run(textStream(['<thinking>secret</thin', 'king> tail']))
  assert.deepEqual(blocksOf(out), [
    { type: 'reasoning', text: 'secret' },
    { type: 'text', text: 'tail' },
  ])
})

test('a stray close tag in text passes through verbatim', async () => {
  const out = await run(textStream(['sec</think', 'ing></thinking> tail']))
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'sec</thinking></thinking> tail' },
  ])
})

test('a truncated tag at block end is emitted verbatim', async () => {
  const out = await run(textStream(['word <thin']))
  assert.deepEqual(blocksOf(out), [{ type: 'text', text: 'word <thin' }])
})

test('no tag anywhere: the adapter block object forwards verbatim', async () => {
  const srcBlock = { type: 'text', text: 'plain reply', extra: 'kept' }
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'plain ' },
    { type: 'text-delta', index: 0, text: 'reply' },
    { type: 'block-end', index: 0, block: srcBlock },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(blocksOf(out), [srcBlock]) // same object, extra fields intact
})

test('leading whitespace without a tag is content, preserved verbatim', async () => {
  const out = await run(textStream(['\n\n  reply']))
  assert.deepEqual(blocksOf(out), [{ type: 'text', text: '\n\n  reply' }])
})

test('a pure-whitespace block emits its text (not fabricated into a tag)', async () => {
  const out = await run(textStream(['   ']))
  assert.deepEqual(blocksOf(out), [{ type: 'text', text: '   ' }])
})

test('empty tag produces an empty reasoning block', async () => {
  const out = await run(textStream(['A<thinking></thinking>B']))
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'A' },
    { type: 'reasoning', text: '' },
    { type: 'text', text: 'B' },
  ])
})

test('nested open tag inside reasoning is literal content', async () => {
  const out = await run(textStream(['<thinking>a <thinking> still me</thinking>tail']))
  assert.deepEqual(blocksOf(out), [
    { type: 'reasoning', text: 'a <thinking> still me' },
    { type: 'text', text: 'tail' },
  ])
})

test('finish closes a dangling open block (stream invariant)', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'dangling' },
    { type: 'finish', reason: { kind: 'aborted' } },
  ])
  assert.deepEqual(blocksOf(out), [{ type: 'text', text: 'dangling' }])
  assert.equal(out.at(-1).type, 'finish')
})

test('byte-at-a-time deltas: tags still detected', async () => {
  const text = 'Hi <thinking>sec</thinking> bye'
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...[...text].map((t) => ({ type: 'text-delta', index: 0, text: t })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await run(chunks)
  // Byte-at-a-time deltas release 'Hi ' before '<' even arrives — the trailing
  // space was already on the wire when the tag was confirmed.
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'Hi ' },
    { type: 'reasoning', text: 'sec' },
    { type: 'text', text: 'bye' },
  ])
})

test('delta-only stream (no block-start/end) still splits and settles', async () => {
  const out = await run([
    { type: 'text-delta', index: 0, text: 'a<thinking>x</thinking>b' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(blocksOf(out), [
    { type: 'text', text: 'a' },
    { type: 'reasoning', text: 'x' },
    { type: 'text', text: 'b' },
  ])
})

test('passthrough blocks keep sequence but renumber', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'a<thinking>x</thinking>b' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'a<thinking>x</thinking>b' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'inner_commit', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'inner_commit', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  assert.deepEqual(emittedIndexes(out), [0, 1, 2, 3])
  assert.deepEqual(blocksOf(out).at(-1), { type: 'tool-call', id: 'c1', name: 'inner_commit', arguments: '{}' })
})

// ---------------------------------------------------------------------------
// outbound: replay envelope remapping
// ---------------------------------------------------------------------------

test('replay blocks remap: real thinking keeps signature, splits go synthetic', async () => {
  const replayState = {
    response: { id: 'resp-1' },
    blocks: [
      { type: 'text' },
      { type: 'reasoning', signature: 'sig-real' },
    ],
  }
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'A<thinking>x</thinking>B' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'A<thinking>x</thinking>B' } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'native thought' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'native thought' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState },
  ])
  const replay = out.find(c => c.type === 'finish').replayState
  // emitted order: text, reasoning(tag), text, reasoning(native)
  assert.deepEqual(replay.blocks, [
    { type: 'text' },                       // source text entry, reused once
    { type: 'reasoning' },                  // tag extraction: synthetic, no sig
    { type: 'text' },                       // second text piece: synthetic
    { type: 'reasoning', signature: 'sig-real' }, // real thinking keeps sig
  ])
  assert.deepEqual(replay.response, { id: 'resp-1' })
})

test('replay blocks whose count mismatches drop to response-only', async () => {
  const out = await run(textStream(['hi'], {
    finish: {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: 'r', blocks: [{ type: 'text' }, { type: 'text' }] },
    },
  }))
  const replay = out.find(c => c.type === 'finish').replayState
  assert.deepEqual(replay, { response: 'r' })
})

test('replay without blocks passes through untouched', async () => {
  const replayState = { response: { id: 'r' } }
  const out = await run(textStream(['hi'], {
    finish: { type: 'finish', reason: { kind: 'stop' }, replayState },
  }))
  assert.deepEqual(out.find(c => c.type === 'finish').replayState, replayState)
})

// ---------------------------------------------------------------------------
// inbound: stripThinkingFromMessages
// ---------------------------------------------------------------------------

const assistant = (content, replayState) => ({
  id: 'm1',
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'p', model: 'm', replayState },
})

test('signed reasoning is kept; synthetic reasoning and residue are stripped', () => {
  const msgs = [
    assistant(
      [
        { type: 'reasoning', text: 'native thought' },
        { type: 'text', text: 'answer' },
      ],
      { response: 'r', blocks: [{ type: 'reasoning', signature: 'sig' }, { type: 'text' }] },
    ),
    assistant(
      [
        { type: 'reasoning', text: 'tag monologue' },
        { type: 'text', text: 'reply' },
      ],
      { response: 'r', blocks: [{ type: 'reasoning' }, { type: 'text' }] },
    ),
    assistant([{ type: 'text', text: 'left <thinking>residue</thinking> right' }]),
    assistant([{ type: 'text', text: 'unclosed <thinking>tail' }]),
  ]
  const out = stripThinkingFromMessages(msgs)
  assert.equal(out.length, 4)
  assert.deepEqual(out[0].content, [
    { type: 'reasoning', text: 'native thought' },
    { type: 'text', text: 'answer' },
  ])
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'reply' }])
  assert.equal(out[2].content[0].text, 'left  right')
  assert.equal(out[3].content[0].text, 'unclosed ')
})

test('replayState.blocks stays aligned after filtering', () => {
  const msgs = [assistant(
    [
      { type: 'reasoning', text: 'tag' },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    { response: 'r', blocks: [{ type: 'reasoning' }, { type: 'text' }, { type: 'text' }] },
  )]
  const [m] = stripThinkingFromMessages(msgs)
  assert.deepEqual(m.source.replayState.blocks, [{ type: 'text' }, { type: 'text' }])
})

test('a message stripped to nothing is dropped; tool calls survive', () => {
  const msgs = [
    assistant([{ type: 'reasoning', text: 'monologue only' }]),
    assistant([{ type: 'tool-call', id: 'c1', name: 'inner_commit', arguments: '{}' }]),
    assistant([{ type: 'text', text: '<thinking>all gone</thinking>' }]),
  ]
  const out = stripThinkingFromMessages(msgs)
  assert.equal(out.length, 1)
  assert.equal(out[0].content[0].type, 'tool-call')
})

test('untouched messages return the same object', () => {
  const m = assistant([{ type: 'text', text: 'clean' }])
  const out = stripThinkingFromMessages([m])
  assert.equal(out[0], m)
})

test('non-assistant roles are left alone', () => {
  const user = { role: 'user', content: [{ type: 'text', text: '<thinking>x</thinking> hi' }], source: { kind: 'user' } }
  const out = stripThinkingFromMessages([user])
  assert.equal(out[0], user)
})

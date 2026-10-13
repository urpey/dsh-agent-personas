/**
 * <thinking>…</thinking> extraction — outbound stream transform + inbound
 * history strip.
 *
 * The persona protocol has the model write its inner monologue as a literal
 * <thinking> block inside reply text (critical turns, and any stray use). This
 * module gives those tags a real block type both ways:
 *
 *  - OUTBOUND (`transformThinkingStream`): an `llm/stream` waterfall wrapper
 *    that scans text blocks, splits every tagged span out into its own
 *    reasoning block, and re-numbers emitted blocks so indexes stay contiguous.
 *    The UI renders reasoning as a collapsed thinking row — no UI code needed.
 *  - INBOUND (`stripThinkingFromMessages`): a `deriveMessages` post-processor
 *    that removes synthetic reasoning (no replay signature) and any leftover
 *    literal tags from request history, so the monologue is never replayed to
 *    the provider. The session log itself is never touched.
 *
 * Scanner rules (text blocks only; other block types pass through):
 *  - `<thinking>` is recognized ANYWHERE in a text block — block head, mid
 *    text, repeatedly. Everything before it stays text; a whitespace run
 *    immediately before a tag is dropped (it is scaffolding).
 *  - Inside a tag only `</thinking>` is scanned; a nested `<thinking>` is
 *    literal content. An unclosed tag swallows the rest of the block.
 *  - After `</thinking>`, a whitespace-only run up to the next real byte is
 *    dropped; a truncated tail (half a tag at block end) is emitted as text.
 *  - Tag detection survives chunk splits: each mode holds back a tail no
 *    longer than (tag length − 1), and only scans the released prefix.
 *
 * Replay envelope: emitted blocks record which source block they came from.
 * `finish.replayState.blocks` is rebuilt in emitted order — a matching-type
 * source entry is reused once (real thinking keeps its signature), extra
 * emitted pieces get a synthetic `{type}` entry, and a source whose count no
 * longer aligns drops `blocks` but keeps `response`.
 */

export const THINKING_OPEN = '<thinking>'
export const THINKING_CLOSE = '</thinking>'
const OPEN_LEN = THINKING_OPEN.length   // 10
const CLOSE_LEN = THINKING_CLOSE.length // 11

// ---------------------------------------------------------------------------
// outbound: transformThinkingStream(source: AsyncIterable<StreamChunk>)
// ---------------------------------------------------------------------------

/** Longest suffix of `s` that is a proper prefix of `tag` (0..tag.length-1). */
const tagSuffixHold = (s, tag) => {
  const max = Math.min(s.length, tag.length - 1)
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n
  }
  return 0
}

const hasSignature = (entry) =>
  typeof entry === 'object' && entry !== null && typeof entry.signature === 'string'

/**
 * Wrap an adapter chunk stream so every literal <thinking>…</thinking> span in
 * text blocks becomes a real reasoning block.
 *
 * @param {AsyncIterable<object>} source - downstream `llm/stream` output.
 * @yields re-indexed StreamChunks. Invariants: an emitted block is opened
 *   before its deltas and closed before the terminal chunk leaves.
 */
export async function* transformThinkingStream(source) {
  let nextEmitted = 0          // contiguous emitted index
  const srcBlocks = []         // source blocks in arrival order (srcPos keyed)
  const srcByIndex = new Map() // source chunk index → src meta
  const emittedFrom = []       // emitted index → { srcPos, type }
  const out = []               // chunks queued for yield, drained per input

  const srcState = (index, type) => {
    let st = srcByIndex.get(index)
    if (!st) {
      st = {
        index,
        srcPos: srcBlocks.length,
        type,
        // scanner state (text sources):
        mode: 'gap',           // 'gap' | 'text' | 'reasoning'
        tail: '',              // held-back bytes that could complete a tag
        gapWs: '',             // pending whitespace, undecided until next byte
        afterTag: false,       // 'gap' entered via a CLOSE — its ws is dropped
        // emitted-block bookkeeping (all sources):
        emittedIndex: -1,      // currently open emitted block, or -1
        emittedType: '',
        emittedText: '',       // accumulated text of the open emitted block
        emittedCount: 0,       // emitted blocks this source produced
        toolId: undefined,     // forwarded-tool accumulation for end synthesis
        toolName: '',
        toolArgs: '',
        everSawTag: false,
        ended: false,
      }
      srcBlocks.push(st)
      srcByIndex.set(index, st)
    }
    return st
  }

  const open = (st, type) => {
    const index = nextEmitted++
    st.emittedIndex = index
    st.emittedType = type
    st.emittedText = ''
    st.emittedCount += 1
    emittedFrom.push({ srcPos: st.srcPos, type })
    out.push({ type: 'block-start', index, blockType: type })
  }

  const closeOpen = (st, block) => {
    if (st.emittedIndex < 0) return
    out.push({ type: 'block-end', index: st.emittedIndex, block })
    st.emittedIndex = -1
    st.emittedType = ''
    st.emittedText = ''
  }

  /** The block object a settled-but-never-closed source ends with. */
  const synthEnd = (st) => {
    if (st.emittedType === 'tool-call') {
      return {
        type: 'tool-call',
        id: st.toolId ?? `call-${st.emittedIndex}`,
        name: st.toolName,
        arguments: st.toolArgs,
      }
    }
    return { type: st.emittedType, text: st.emittedText }
  }

  const emitTextDelta = (st, text) => {
    if (!text) return
    if (st.emittedIndex < 0) open(st, 'text')
    st.emittedText += text
    out.push({ type: 'text-delta', index: st.emittedIndex, text })
  }

  const emitReasoningDelta = (st, text) => {
    if (!text) return
    if (st.emittedIndex < 0) open(st, 'reasoning')
    st.emittedText += text
    out.push({ type: 'reasoning-delta', index: st.emittedIndex, text })
  }

  /**
   * Scan released (non-held) bytes on the text side of a tag boundary — modes
   * 'gap' and 'text'. `released` never ends inside a tag prefix.
   *
   * Whitespace policy, matching the block-head rule everywhere:
   *  - 'gap' accumulates pure-whitespace releases into `st.gapWs`, undecided.
   *    Real bytes resolve it: after a CLOSE (`afterTag`) it is dropped, at
   *    block start it is content and releases verbatim; before an OPEN tag it
   *    is scaffolding and drops either way.
   *  - 'text' emits releases verbatim; only a whitespace run immediately
   *    before an OPEN tag is dropped.
   */
  const scanTextSide = (st, released) => {
    const s = released
    if (!s) return
    const at = s.indexOf(THINKING_OPEN)
    if (at === -1) {
      if (st.mode === 'text') { emitTextDelta(st, s); return }
      if (/\S/.test(s)) {
        emitTextDelta(st, st.afterTag ? (st.gapWs + s).replace(/^\s+/, '') : st.gapWs + s)
        st.gapWs = ''
        st.afterTag = false    // leaving 'gap': mid-text whitespace is content
        st.mode = 'text'
      } else st.gapWs += s
      return
    }
    const before = (st.mode === 'gap' ? st.gapWs : '') + s.slice(0, at)
    st.gapWs = ''
    // Real text before the tag keeps interior whitespace; the whitespace run
    // hugging the tag itself is scaffolding and drops either way.
    let text = before.replace(/\s+$/, '')
    if (st.afterTag) text = text.replace(/^\s+/, '')
    if (/\S/.test(text)) emitTextDelta(st, text)
    st.everSawTag = true
    closeOpen(st, synthEnd(st))
    open(st, 'reasoning')
    st.mode = 'reasoning'
    const rest = s.slice(at + OPEN_LEN)
    const held = rest.length - tagSuffixHold(rest, THINKING_CLOSE)
    st.tail = rest.slice(held)
    if (held > 0) scanReasoningSide(st, rest.slice(0, held))
  }

  /**
   * Scan released bytes inside a tag for the CLOSE tag. Only `</thinking>`
   * ends reasoning mode; a nested `<thinking>` is literal content.
   */
  const scanReasoningSide = (st, released) => {
    const s = released
    const at = s.indexOf(THINKING_CLOSE)
    if (at === -1) {
      emitReasoningDelta(st, s)
      return
    }
    emitReasoningDelta(st, s.slice(0, at))
    closeOpen(st, { type: 'reasoning', text: st.emittedText })
    st.mode = 'gap'
    st.afterTag = true
    st.gapWs = ''
    const rest = s.slice(at + CLOSE_LEN)
    const held = rest.length - tagSuffixHold(rest, THINKING_OPEN)
    st.tail = rest.slice(held)
    if (held > 0) scanTextSide(st, rest.slice(0, held))
  }

  /**
   * Fold the held tail into a complete block: no further chunk can complete a
   * tag, so the tail is content — or discardable whitespace in 'gap'.
   */
  const flushTail = (st) => {
    if (st.tail) {
      const tail = st.tail
      st.tail = ''
      if (st.mode === 'reasoning') emitReasoningDelta(st, tail)
      else if (st.mode === 'text') emitTextDelta(st, tail)
      else {
        // 'gap': fold undecided whitespace + tail. A truncated half-tag like
        // 'x<thin' is emitted verbatim — fidelity beats stripping.
        const all = st.gapWs + tail
        if (/\S/.test(all)) emitTextDelta(st, st.afterTag ? all.replace(/^\s+/, '') : all)
      }
      st.gapWs = ''
      return
    }
    if (st.mode !== 'gap' || !st.gapWs) return
    // 'gap' tail empty: block-start whitespace is content, post-tag is not.
    const ws = st.gapWs
    st.gapWs = ''
    if (!st.afterTag) emitTextDelta(st, ws)
  }

  const endSourceBlock = (st, srcBlock) => {
    flushTail(st)
    if (st.emittedIndex >= 0) {
      // Passthrough blocks forward the adapter's own block object verbatim —
      // nothing was cut, so the authoritative end stays authoritative.
      const verbatim = st.emittedCount === 1 && !st.everSawTag
        && srcBlock?.type === st.emittedType
      closeOpen(st, verbatim ? srcBlock : synthEnd(st))
    }
    st.ended = true
  }

  /** Source blocks still open at stream end must not dangle past finish. */
  const settleAll = () => {
    for (const st of srcBlocks) {
      if (st.ended) continue
      if (st.type === 'text') flushTail(st)
      closeOpen(st, synthEnd(st))
      st.ended = true
    }
  }

  const remapReplay = (replayState) => {
    if (replayState === undefined || replayState === null) return replayState
    const blocks = replayState.blocks
    if (!Array.isArray(blocks)) return replayState
    // Positions are allocated per source block; a count mismatch means the
    // envelope cannot be walked back — drop per-block data, keep response.
    if (blocks.length !== srcBlocks.length) return { response: replayState.response }
    const consumed = new Array(srcBlocks.length).fill(false)
    const remapped = emittedFrom.map(({ srcPos, type }) => {
      const entry = blocks[srcPos]
      // Reuse the source entry once per same-type block: a real thinking block
      // keeps its signature; extra pieces of a split source go synthetic.
      if (!consumed[srcPos] && srcBlocks[srcPos]?.type === type) {
        consumed[srcPos] = true
        return entry
      }
      return { type }
    })
    return { ...replayState, blocks: remapped }
  }

  for await (const chunk of source) {
    switch (chunk?.type) {
      case 'block-start': {
        const st = srcState(chunk.index, chunk.blockType)
        // Non-text blocks forward immediately with a fresh emitted index.
        // A text block-start is lazy: it emits only when content is released.
        if (st.type !== 'text' && st.emittedIndex < 0) open(st, st.type)
        break
      }
      case 'text-delta': {
        const st = srcState(chunk.index, 'text')
        if (st.type !== 'text') {          // text-delta on a non-text index
          if (st.emittedIndex < 0) open(st, st.type)
          st.emittedText += chunk.text ?? ''
          out.push({ ...chunk, index: st.emittedIndex })
          break
        }
        const buf = st.tail + (chunk.text ?? '')
        const tag = st.mode === 'reasoning' ? THINKING_CLOSE : THINKING_OPEN
        const held = buf.length - tagSuffixHold(buf, tag)
        st.tail = buf.slice(held)
        const released = buf.slice(0, held)
        if (st.mode === 'reasoning') scanReasoningSide(st, released)
        else scanTextSide(st, released)
        break
      }
      case 'reasoning-delta': {
        const st = srcState(chunk.index, 'reasoning')
        if (st.emittedIndex < 0) open(st, 'reasoning')
        st.emittedText += chunk.text ?? ''
        out.push({ ...chunk, index: st.emittedIndex })
        break
      }
      case 'tool-call-delta': {
        const st = srcState(chunk.index, 'tool-call')
        if (st.emittedIndex < 0) open(st, 'tool-call')
        st.toolId ??= chunk.id
        if (chunk.name) st.toolName += chunk.name
        st.toolArgs += chunk.argumentsDelta ?? ''
        out.push({ ...chunk, index: st.emittedIndex })
        break
      }
      case 'block-end': {
        const st = srcByIndex.get(chunk.index)
        if (!st) break                     // end for a block never seen — drop
        if (st.type === 'text') endSourceBlock(st, chunk.block)
        else closeOpen(st, chunk.block)
        st.ended = true
        break
      }
      case 'usage':
        out.push(chunk)
        break
      case 'finish': {
        settleAll()
        out.push({ ...chunk, replayState: remapReplay(chunk.replayState) })
        break
      }
      default:
        out.push(chunk)                    // forward unknown chunk kinds
    }
    while (out.length) yield out.shift()
  }
  // Source ended without a finish chunk: settle dangling blocks anyway so the
  // emitted stream never violates block invariants.
  settleAll()
  while (out.length) yield out.shift()
}

// ---------------------------------------------------------------------------
// inbound: stripThinkingFromMessages(messages)
// ---------------------------------------------------------------------------

/** Literal-tag residue in stored text: complete spans and unclosed tails. */
const LITERAL_THINKING = /<thinking>[\s\S]*?(<\/thinking>|$)/g

/**
 * Remove planning residue from one derived message; returns the same object
 * when nothing changes so frozen instances keep being shared.
 *
 * Rules:
 *  - reasoning blocks keep only provider-signed thinking: content[i] must line
 *    up with `source.replayState.blocks[i]` carrying a signature — the replay
 *    envelope is positional over emitted blocks. Synthetic <thinking>
 *    extractions and chat-completions round-trips have none.
 *  - text blocks drop literal `<thinking>…(</thinking>|$)` residue; a block
 *    left whitespace-only is dropped entirely.
 *  - `replayState.blocks` is filtered to the kept positions so the envelope
 *    stays aligned with content.
 */
function stripMessage(message) {
  // Only model output can carry monologue blocks; user/tool input that quotes
  // the literal tag is the speaker's own words and stays.
  if (message?.role !== 'assistant') return message
  const content = Array.isArray(message.content) ? message.content : null
  if (!content) return message
  const replayBlocks = message?.source?.replayState?.blocks
  const aligned = Array.isArray(replayBlocks) && replayBlocks.length === content.length
  const keep = []
  const nextContent = []
  let changed = false
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block?.type === 'reasoning') {
      if (aligned && hasSignature(replayBlocks[i])) {
        keep.push(i)
        nextContent.push(block)
      } else changed = true
      continue
    }
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = block.text.replace(LITERAL_THINKING, '')
      if (/\S/.test(text)) {
        keep.push(i)
        nextContent.push(text === block.text ? block : { ...block, text })
        if (text !== block.text) changed = true
      } else changed = true
      continue
    }
    keep.push(i)
    nextContent.push(block)
  }
  if (!changed) return message
  const source = message.source
  const replayState = aligned && source?.replayState !== undefined
    ? { ...source.replayState, blocks: keep.map(i => replayBlocks[i]) }
    : source?.replayState
  return {
    ...message,
    content: nextContent,
    ...(source ? { source: { ...source, replayState } } : {}),
  }
}

/**
 * Post-process `session.deriveMessages()` output: strip planning residue from
 * every message and drop messages left with no content. Tool calls are never
 * touched, so call/result pairing is unaffected.
 */
export function stripThinkingFromMessages(messages) {
  const out = []
  for (const m of messages ?? []) {
    const stripped = stripMessage(m)
    if (!stripped || !Array.isArray(stripped.content) || stripped.content.length === 0) continue
    out.push(stripped)
  }
  return out
}

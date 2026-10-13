/**
 * The `persona` SubagentProvider + the pending-binding side channel.
 *
 * persona_spawn / `/persona spawn` / `spawn_teammate(provider:'persona')`
 * all resolve to this provider. It delegates actual creation to the stock
 * `spawn` provider (which applies the persona prefix text and owns the run
 * lifecycle), while recording a pending persona name so the `agent/created`
 * equip listener can bind the child's tools to `<cwd>/.persona/<name>/`.
 */
import { renderPersonaPrefix, renderPersonaBody, personaDir, personaExists, ensurePersona, stripPersonaText } from './persona.js'

/** name → personaName bindings keyed by durable child session id (continuable). */
export const pendingContinuable = new Map()
/** parent sessionId → FIFO queue of persona names (one-shot). */
export const pendingOneShot = new Map()

export function queueOneShot(parentId, personaName) {
  const q = pendingOneShot.get(parentId) ?? []
  q.push(personaName)
  pendingOneShot.set(parentId, q)
}

export function takeOneShot(parentId) {
  const q = pendingOneShot.get(parentId)
  if (!q?.length) return undefined
  const name = q.shift()
  if (!q.length) pendingOneShot.delete(parentId)
  return name
}

export function personaProviderName(cfg) {
  return cfg.providerName ?? 'persona'
}

/** Encode the rendered persona text for a spawn request. */
export function personaRequestText(cwd, name, libraryDir) {
  const dir = personaDir(cwd, name, libraryDir)
  return renderPersonaPrefix(dir, name)
}

/** Prompt-facing persona text for spawns whose name is bound via
 *  pendingContinuable: body only, no marker, no frontmatter. */
export function personaBodyText(cwd, name, libraryDir) {
  const dir = personaDir(cwd, name, libraryDir)
  return renderPersonaBody(dir, name)
}

/**
 * Build the provider object registered on ctx.subagents.
 * @param innerName - the stock provider to delegate to ('spawn').
 */
export function createPersonaProvider(name, innerName, resolveCwd, libraryDir, cfg = {}) {
  const reflect = cfg.closingReflection === 'always' || cfg.closingReflection === 'one-shot'
  return {
    name,
    inheritsParentContext: false,
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },

    async start(request) {
      // One-shot: request.persona carries the marker text; recover the name.
      const m = /^persona-profile:([\w-]+)/m.exec(request.persona ?? '')
      const parentId = request.parent?.session?.header?.id ?? request.parent?.id
      if (m && parentId) queueOneShot(parentId, m[1])
      const inner = this._inner()
      // Marker line and PERSONA.md frontmatter are detection metadata, not
      // persona content — strip before the text reaches the child's prompt.
      const personaText = m ? stripPersonaText(request.persona) : request.persona
      let run
      try {
        run = await inner.start(personaText !== request.persona ? { ...request, persona: personaText } : request)
      } catch (e) {
        // Failed start: the child never arrives, so agent/created will never
        // drain this queue entry — pop it ourselves, otherwise the next
        // one-shot child of this parent consumes a stale name.
        const q = m && parentId ? pendingOneShot.get(parentId) : undefined
        if (q) { q.pop(); if (!q.length) pendingOneShot.delete(parentId) }
        throw e
      }
      if (!reflect) return run
      // The closing reflection adds a housekeeping turn AFTER the task turn.
      // readResult picks the LAST assistant message, which would be the
      // reflection's housekeeping chatter — swap output back to the last
      // assistant message before the '[persona closing]' injection.
      const result = run.result.then(res => {
        const agent = run.localAgent
        if (!agent || res.output?.length === 0) return res
        try {
          const evs = agent.session.snapshotEvents()
          const isClosing = e => e.type === 'user/message'
            && (e.data?.content ?? []).some(b => b?.type === 'text' && b.text?.startsWith('[persona closing]'))
          const cut = evs.findIndex(isClosing)
          const taskEvs = cut < 0 ? evs : evs.slice(0, cut)
          const blocksOf = e => e.data?.message?.content ?? []
          const hasVisible = e => e.type === 'assistant/message'
            && blocksOf(e).some(b => b?.type === 'text'
              && (b.text ?? '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim())
          // A critical turn is staged: step 1 is the <thinking> monologue plus
          // an inner_commit call, so the answer is the first visible text AFTER
          // that call — never the monologue, never the closing chatter.
          let reply
          for (let i = taskEvs.length - 1; i >= 0 && !reply; i--) {
            if (!blocksOf(taskEvs[i]).some(b => b?.type === 'tool-call' && b.name === 'inner_commit')) continue
            for (let j = i + 1; j < taskEvs.length; j++) {
              if (hasVisible(taskEvs[j])) { reply = taskEvs[j]; break }
            }
          }
          // Routine turn: the answer is simply the last thing said before the
          // closing reflection turn.
          if (!reply) {
            reply = [...taskEvs].reverse()
              .find(e => e.type === 'assistant/message' && e.data?.message?.content?.length)
          }
          return reply ? { ...res, output: reply.data.message.content } : res
        } catch { return res }
      })
      return { ...run, result }
    },

    async prepareContinuable({ sessionId, parent }) {
      // persona_spawn mints spec.childId and stashes the name here beforehand.
      const pending = pendingContinuable.get(sessionId)
      if (pending) {
        ensurePersona(resolveCwd(parent), pending, libraryDir)
      }
      const inner = this._inner()
      return inner.prepareContinuable?.({ sessionId, parent }) ?? {}
    },

    // resolved lazily so the stock provider may register after us
    _inner: null,
    bindInner(getProvider) {
      this._inner = () => {
        const p = getProvider(innerName)
        if (!p) throw new Error(`persona provider requires the '${innerName}' subagent provider`)
        return p
      }
    },
  }
}

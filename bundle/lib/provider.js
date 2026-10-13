/**
 * The `persona` SubagentProvider + the pending-binding side channel.
 *
 * persona_spawn / `/persona spawn` / `spawn_teammate(provider:'persona')`
 * all resolve to this provider. It delegates actual creation to the stock
 * `spawn` provider (which applies the persona prefix text and owns the run
 * lifecycle), while recording a pending persona name so the `agent/created`
 * equip listener can bind the child's tools to `<cwd>/.persona/<name>/`.
 */
import { renderPersonaPrefix, personaDir, personaExists, ensurePersona } from './persona.js'

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
      const run = await inner.start(request)
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
          if (cut < 0) return res
          const prior = evs.slice(0, cut).reverse()
            .find(e => e.type === 'assistant/message' && e.data?.message?.content?.length)
          return prior ? { ...res, output: prior.data.message.content } : res
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

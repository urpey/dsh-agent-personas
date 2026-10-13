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
export function createPersonaProvider(name, innerName, resolveCwd, libraryDir) {
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
      return inner.start(request)
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

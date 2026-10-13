/**
 * dsh-agent-personas — persistent persona engine for DeepSeek Harness.
 *
 * A single Host plugin row. It:
 *  - watches `agent/created` for persona-bound agents (the pending maps of a
 *    live spawn, the `.persona/.bindings/` ledger of a resumed one) and equips
 *    them with the memory/state tool surface plus persona prompt sections;
 *  - registers the `persona` SubagentProvider (delegates to `spawn`, adds the
 *    persona-profile binding side-channel);
 *  - registers `/persona` slash commands and the `persona_list`/`persona_spawn`
 *    model-facing tools.
 *
 * Persona content lives in `<workspace>/.persona/<name>/` — never in this file.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { personaExists, ensurePersona, listPersonas, libraryRoot, savePersona, BUNDLE_ROOT } from './lib/persona.js'
import { equipAgent } from './lib/equip.js'
import { createPersonaProvider, pendingContinuable, pendingOneShot, takeOneShot, queueOneShot, personaRequestText, personaBodyText } from './lib/provider.js'
import { registerCommands, equipSession } from './lib/commands.js'
import { readBinding, clearBinding, persistBinding } from './lib/bindings.js'
import { splitFrontmatter } from './lib/frontmatter.js'
import { randomUUID } from 'node:crypto'

/**
 * A signal that never aborts, for the paths where the caller supplies none.
 * `new AbortSignal()` is a TypeError ("Illegal constructor") — `AbortSignal` is
 * an interface, not a constructible class — and the subagent entry points call
 * `signal.throwIfAborted()`.
 */
const NEVER_ABORTS = new AbortController().signal

export default {
  name: 'agent-personas',
  inject: ['agents', 'commands', 'subagents', 'tools', 'systemPrompt', 'llm'],
  // NOTE: must be an arrow/prototype-less function — cordis treats any
  // plugin callback with a .prototype as a constructor (isConstructor) and
  // would `new` it, dropping the inject-bearing context.
  apply: (ctx, config) => {
  const cfg = {
    libraryDir: config?.libraryDir ?? '.persona',
    groundingInterval: config?.groundingInterval ?? 0,
    closingReflection: config?.closingReflection ?? 'one-shot',
    providerName: config?.providerName ?? 'persona',
    criticalGate: config?.criticalGate ?? 'auto',
    // `/persona compact` knobs — all optional; lib/memory-compact.js applies
    // its own defaults (65_536 cap, 1 retry) when these stay unset.
    compactProvider: config?.compactProvider,
    compactModel: config?.compactModel,
    compactReasoningEffort: config?.compactReasoningEffort,
    compactMaxTokens: config?.compactMaxTokens,
    compactRetries: config?.compactRetries,
  }

  const resolveCwd = (agent) =>
    agent?.session?.header?.cwd ?? process.cwd()

  // ---------------------------------------------------------------- provider
  const provider = createPersonaProvider(cfg.providerName, 'spawn', resolveCwd, cfg.libraryDir, cfg)
  provider.bindInner((n) => ctx.subagents.getProvider(n))
  ctx.subagents.registerProvider(provider)

  // ------------------------------------------------------------- equip watch
  ctx.on('agent/created', ({ agent }) => {
    // The equip state lives ON the agent (agent.id === session.id), not in a
    // module-level table: an HMR reload rebuilds the module but the agent —
    // and this property — survives, so commands never read a stale answer.
    if (agent.personaEquip) return
    let personaName
    // 1) continuable spawn: pending by child session id
    personaName = pendingContinuable.get(agent.id) ?? pendingContinuable.get(agent.session?.header?.id)
    if (personaName) pendingContinuable.delete(agent.id)
    let mode = personaName ? 'continuable' : undefined
    // 2) one-shot: FIFO pending by parent session id
    if (!personaName) {
      const parentId = agent.session?.header?.parentSession
      if (parentId) { personaName = takeOneShot(parentId); if (personaName) mode = 'one-shot' }
    }
    // 3) durable rebind: the `.persona/.bindings/` ledger. Written by
    // `/persona use` for the session it equipped and by every spawn path for
    // the child session it created, so this is the one channel that re-equips a
    // resumed session — root or child — after a restart. The ledger lives in
    // `.persona/.bindings/<sessionId>.json`, not in the session log — see
    // lib/bindings.js for why a session event can't work.
    if (!personaName) {
      const cwd = resolveCwd(agent)
      const sessionId = agent.session?.header?.id ?? agent.session?.id
      personaName = readBinding(libraryRoot(cwd, cfg.libraryDir), sessionId)
      if (personaName) mode = 'session'
    }
    if (!personaName) return
    const cwd = resolveCwd(agent)
    if (!personaExists(cwd, personaName, cfg.libraryDir)) {
      // The bound persona archive was deleted — drop the stale ledger entry
      // so every future resume doesn't re-walk this dead end.
      if (mode === 'session') {
        clearBinding(libraryRoot(cwd, cfg.libraryDir), agent.session?.header?.id ?? agent.session?.id)
      }
      return
    }
    const dir = ensurePersona(cwd, personaName, cfg.libraryDir)
    const dispose = equipAgent(agent.ctx, agent, dir, personaName, cfg, mode ?? 'session')
    // The agent object carries the equip for its whole life — the property
    // dies with the agent, which is exactly the session's lifetime.
    agent.personaEquip = { name: personaName, dispose }
  })

  // ------------------------------------------------------- model-facing tools
  ctx.tools.register({
    name: 'persona_list',
    description: 'List persona archives in this workspace\'s .persona/ library (name, description, memory count).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {},
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const cwd = exec?.agent ? resolveCwd(exec.agent) : process.cwd()
      return listPersonas(cwd, cfg.libraryDir)
    },
  })

  ctx.tools.register({
    name: 'persona_spawn',
    description:
      'Spawn a persistent persona-backed agent as a continuable child of this session. ' +
      'mode "continuable" (default) returns immediately with a durable child id you can send_message to; ' +
      'mode "one-shot" runs the task and returns its result. The child equips .persona/<name>/: ' +
      'persona prefix, memory tools, state tools.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Persona archive name under .persona/' },
        prompt: { type: 'string', description: 'Initial task/prompt delivered to the persona agent' },
        label: { type: 'string', description: 'Short label for the child agent' },
        mode: { type: 'string', enum: ['continuable', 'one-shot'], description: 'continuable (default, durable) or one-shot' },
      },
      required: ['name', 'prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return { error: 'persona_spawn requires an agent context' }
      const cwd = resolveCwd(agent)
      if (!personaExists(cwd, args.name, cfg.libraryDir)) {
        return { error: `persona "${args.name}" not found under ${cfg.libraryDir}/`, available: listPersonas(cwd, cfg.libraryDir).map(p => p.name) }
      }
      const personaText = personaRequestText(cwd, args.name, cfg.libraryDir)
      if (args.mode === 'one-shot') {
        const run = await ctx.subagents.start(cfg.providerName, {
          label: args.label ?? `persona:${args.name}`,
          prompt: [{ type: 'text', text: args.prompt }],
          parent: agent,
          persona: personaText,
          signal: exec.signal ?? NEVER_ABORTS,
        })
        const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), run.id, args.name)
        const result = await run.result
        return { mode: 'one-shot', childId: run.id, stopReason: result.stopReason, output: result.output, bindingNote }
      }
      const childId = randomUUID()
      pendingContinuable.set(childId, args.name)
      let id, messageId
      try {
        const started = await ctx.subagents.startContinuable({
          childId,
          provider: cfg.providerName,
          label: args.label ?? `persona:${args.name}`,
          // Name is bound via pendingContinuable; prompt text must not carry
          // the marker/frontmatter.
          request: { parent: agent, prompt: [{ type: 'text', text: args.prompt }], persona: personaBodyText(cwd, args.name, cfg.libraryDir) },
          signal: exec.signal ?? NEVER_ABORTS,
        })
        id = started.childId
        messageId = started.messageId
      } catch (e) {
        pendingContinuable.delete(childId)   // failed spawn: no zombie pending entry
        throw e
      }
      // Same registration as `/persona spawn`: the child is equipped by
      // construction, so the picker must be able to badge it and a restart must
      // be able to re-equip it.
      const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), id, args.name)
      return { mode: 'continuable', childId: id, messageId, bindingNote }
    },
  })

  // ------------------------------------------------------- authoring tools
  // The two model-facing halves of the creation wizard (`skills/persona-authoring`).
  // They exist because that wizard runs INSIDE a live session: an equipped
  // session cannot write `.persona/**` with the file tools at all — the equip
  // guard denies it (`lib/equip.js`) — so without a tool-face channel,
  // "create a persona while running as one" would be impossible.
  ctx.tools.register({
    name: 'persona_save',
    description:
      'Create a NEW persona archive under .persona/<name>/ from an authored draft. ' +
      'This is the only channel an agent may use to write persona files: the write/edit/bash tools are denied on .persona/**, ' +
      'and an existing archive is never overwritten. Call it only after the user has seen the full draft and approved it. ' +
      'files maps archive-relative paths to file text: PERSONA.md (required, opening with a --- frontmatter block), STATE.md, ' +
      'MEMORY.md, and memory/<name>.md nodes. STATE.md and MEMORY.md are filled from the template when omitted.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Archive name under .persona/ — letters, digits, _ or - only' },
        files: {
          type: 'object',
          description: 'Archive path → file text. Allowed keys: PERSONA.md, STATE.md, MEMORY.md, memory/<name>.md',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name', 'files'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const cwd = agent ? resolveCwd(agent) : process.cwd()
      const running = agent?.personaEquip?.name
      // Subsumed by the existence check below whenever the archive is still on
      // disk — but this is the case the wizard is most likely to hit, and
      // "already exists" would not say WHY this particular archive is special.
      // It also covers the live-but-deleted archive, which existence no longer
      // catches.
      if (running !== undefined && running === args.name) {
        return { error: `"${args.name}" is the persona this session is running as — persona_save only creates new archives and never rewrites a live one` }
      }
      try {
        const dir = savePersona(cwd, args.name, args.files, cfg.libraryDir)
        return { created: args.name, dir, wrote: Object.keys(args.files ?? {}) }
      } catch (e) {
        return { error: e.message }
      }
    },
  })

  ctx.tools.register({
    name: 'persona_use',
    description:
      'Equip an existing persona archive from .persona/<name>/ onto THIS session: its profile, memory tools and state tools ' +
      'take effect on the next message, and the binding survives a restart. Call it only after the user agrees to equip. ' +
      'It fails when the session is already equipped — the user must run /persona off first.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Persona archive name under .persona/' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    },
    execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return { error: 'persona_use requires an agent context' }
      try {
        const { dir, bindingNote } = equipSession(agent, args.name, cfg, resolveCwd)
        return { equipped: args.name, dir, bindingNote }
      } catch (e) {
        return { error: e.message }
      }
    },
  })

  // ---------------------------------------------------- authoring skill
  // The authoring workflow is the wizard's single source of truth. It shipped
  // as an unregistered file for a while: packaged by `files`, but invisible to
  // every agent's catalog, so nothing could ever load it. Registering it here
  // puts `persona-authoring` in the skill registry's GLOBAL layer, which every
  // agent's scope chain merges (`[global, ...chainLayers]`), so a preset agent
  // sees it even though presets own their own local discovery.
  //
  // `ctx.inject` rather than a hard `inject` entry: a profile with no skill
  // registry loses the wizard's discoverability, not the whole persona engine.
  ctx.inject(['skills'], (skillCtx) => {
    const skillRoot = join(BUNDLE_ROOT, 'skills', 'persona-authoring')
    const { data, body } = splitFrontmatter(readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'))
    skillCtx.skills.register({
      name: String(data.name ?? 'persona-authoring'),
      description: String(data.description ?? ''),
      ...(data.whenToUse === undefined ? {} : { whenToUse: String(data.whenToUse) }),
      source: 'runtime',
      provider: 'agent-personas',
      content: body.trim(),
      resourceBase: { kind: 'directory', path: skillRoot },
    })
  })

  // --------------------------------------------------------------- commands
  registerCommands(ctx, cfg, resolveCwd)
  },
}

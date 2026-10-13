/**
 * dsh-persona-system — persistent persona engine for DeepSeek Harness.
 *
 * A single Host plugin row. It:
 *  - watches `agent/created` for persona-bound agents (provider spawns,
 *    `.persona/.bindings/` ledger, `subagent/descriptor` markers, pending
 *    maps) and equips them with the memory/state tool surface plus persona
 *    prompt sections;
 *  - registers the `persona` SubagentProvider (delegates to `spawn`, adds the
 *    persona-profile binding side-channel);
 *  - registers `/persona` slash commands and the `persona_list`/`persona_spawn`
 *    model-facing tools.
 *
 * Persona content lives in `<workspace>/.persona/<name>/` — never in this file.
 */

import { personaExists, ensurePersona, listPersonas, libraryRoot, parseProfileMarker } from './lib/persona.js'
import { equipAgent } from './lib/equip.js'
import { createPersonaProvider, pendingContinuable, pendingOneShot, takeOneShot, queueOneShot, personaRequestText, personaBodyText } from './lib/provider.js'
import { registerCommands } from './lib/commands.js'
import { readBinding, clearBinding } from './lib/bindings.js'
import { randomUUID } from 'node:crypto'

/** AgentId → { name, dispose } for /persona use|off and teardown. */
const equipped = new Map()

export default {
  name: 'persona-system',
  inject: ['agents', 'commands', 'subagents', 'tools', 'systemPrompt'],
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
  }

  const resolveCwd = (agent) =>
    agent?.session?.header?.cwd ?? process.cwd()

  // ---------------------------------------------------------------- provider
  const provider = createPersonaProvider(cfg.providerName, 'spawn', resolveCwd, cfg.libraryDir, cfg)
  provider.bindInner((n) => ctx.subagents.getProvider(n))
  ctx.subagents.registerProvider(provider)

  // ------------------------------------------------------------- equip watch
  ctx.on('agent/created', ({ agent }) => {
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
    // 3) durable rebind: /persona use binding ledger (resume).
    // Bindings live in `.persona/.bindings/<sessionId>.json`, not in the
    // session log — see lib/bindings.js for why a session event can't work.
    if (!personaName) {
      const cwd = resolveCwd(agent)
      const sessionId = agent.session?.header?.id ?? agent.session?.id
      personaName = readBinding(libraryRoot(cwd, cfg.libraryDir), sessionId)
      if (personaName) mode = 'session'
    }
    // 4) subagent descriptor replay (cold-resumed continuable child)
    if (!personaName) {
      try {
        const evs = agent.session.snapshotEvents?.() ?? []
        const d = evs.find(e => e.type === 'subagent/descriptor')
        const parsed = parseProfileMarker(d?.data?.persona)
        if (parsed) { personaName = parsed; mode = 'continuable' }
      } catch { /* ignore */ }
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
    equipped.set(agent.id, { name: personaName, dispose })
    agent.ctx.on?.('agent/disposed', () => { equipped.delete(agent.id) })
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
          signal: exec.signal ?? new AbortSignal(),
        })
        const result = await run.result
        return { mode: 'one-shot', childId: run.id, stopReason: result.stopReason, output: result.output }
      }
      const childId = randomUUID()
      pendingContinuable.set(childId, args.name)
      const { childId: id, messageId } = await ctx.subagents.startContinuable({
        childId,
        provider: cfg.providerName,
        label: args.label ?? `persona:${args.name}`,
        // Name is bound via pendingContinuable; prompt text must not carry
        // the marker/frontmatter.
        request: { parent: agent, prompt: [{ type: 'text', text: args.prompt }], persona: personaBodyText(cwd, args.name, cfg.libraryDir) },
        signal: exec.signal ?? new AbortSignal(),
      })
      return { mode: 'continuable', childId: id, messageId }
    },
  })

  // --------------------------------------------------------------- commands
  registerCommands(ctx, cfg, resolveCwd, equipped)
  },
}

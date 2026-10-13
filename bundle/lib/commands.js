/**
 * /persona slash commands + the shared persona operation bodies.
 *
 *   list | new <name> [desc] [--from <example>] | examples | use <name> | off | spawn <name> [task] | compact <name> | status
 *
 * The operation bodies live in `createPersonaOps()` and answer `{ ok, text }`.
 * TWO surfaces drive them, so neither can drift from the other:
 *   - the `/persona` slash command (`registerCommands`), which parses the raw
 *     line and maps `{ ok, text }` onto the command result shape;
 *   - the `/personas` picker, through the Host Remote service built in
 *     `lib/remote.js` — the channel that keeps working when the slash command
 *     is switched off (`slashCommand: false` in the bundle config).
 */
import { randomUUID } from 'node:crypto'
import { listPersonas, createPersona, createPersonaFromExample, listExamples, personaExists, ensurePersona, personaDir, libraryRoot } from './persona.js'
import { equipAgent } from './equip.js'
import { pendingContinuable, personaBodyText } from './provider.js'
import { persistBinding, clearBinding } from './bindings.js'
import { compactWithLlm } from './memory-compact.js'

/**
 * A signal that never aborts.
 *
 * `new AbortSignal()` is a TypeError ("Illegal constructor") — `AbortSignal` is
 * an interface, not a constructible class — and the subagent entry points call
 * `signal.throwIfAborted()`, so a spawn without a caller signal needs a real,
 * live one.
 */
const NEVER_ABORTS = new AbortController().signal

/** Durable session id for the binding ledger (header id, matching resume-time lookups). */
const sessionIdOf = (agent) => agent?.session?.header?.id ?? agent?.session?.id

/** Where a caller goes to unequip when the `/persona` command is switched off. */
const UNEQUIP_HINT = 'unequip it first (the /personas picker\'s "Unequip the current persona" row)'

/**
 * Equip a persona archive onto a live session: validate, register the persona
 * surface on the agent, and record the durable binding.
 *
 * Shared by `/persona use`, the picker's `personaInternals/use`, and the
 * model-facing `persona_use` tool, so the three entry points cannot drift: the
 * already-equipped guard, the equip handle on the agent, and the ledger row are
 * one implementation. The equip handle lives ON the agent (never a module-level
 * table) — see `docs/persona-format.md` for why a process-scoped map lied after
 * every reload.
 *
 * @param agent - the live agent the equip belongs to.
 * @param name - persona archive name.
 * @param cfg - plugin config.
 * @param resolveCwd - workspace resolver for the agent.
 * @returns the persona directory and the ledger note (`''` when healthy).
 * @throws when the archive is missing or the session is already equipped.
 */
export function equipSession(agent, name, cfg, resolveCwd) {
  const cwd = resolveCwd(agent)
  if (!personaExists(cwd, name, cfg.libraryDir)) throw new Error(`persona "${name}" not found in ${cfg.libraryDir}/`)
  if (agent.personaEquip) throw new Error(`already equipped as "${agent.personaEquip.name}" — ${UNEQUIP_HINT}`)
  const dir = ensurePersona(cwd, name, cfg.libraryDir)
  const dispose = equipAgent(agent.ctx, agent, dir, name, cfg, 'session')
  // The equip lives on the agent itself — it IS this session's state.
  agent.personaEquip = { name, dispose }
  // Persist the binding so a resumed session re-equips itself and the picker
  // can badge it (session events can't carry this — see lib/bindings.js header).
  const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), sessionIdOf(agent), name)
  return { dir, bindingNote }
}

/**
 * The persona operations, parameterized so both entry surfaces can call them.
 *
 * Every method answers `{ ok, text }` and NEVER throws for a business refusal
 * (missing archive, no equip, refused compaction plan): a refusal is data, and
 * each surface renders it its own way — a command result, a Remote reply, or a
 * composer notice. A thrown error therefore means a real internal fault.
 *
 * @param ctx - plugin context (subagents, llm).
 * @param cfg - plugin config.
 * @param resolveCwd - workspace resolver for an agent.
 * @returns the operation table.
 */
export function createPersonaOps(ctx, cfg, resolveCwd) {
  return {
    /** `list` — the library as text rows. */
    list(agent) {
      const rows = listPersonas(resolveCwd(agent), cfg.libraryDir)
      if (!rows.length) return fail(`No personas in ${cfg.libraryDir}/ — create one with the /personas picker`)
      return okay(rows.map(r => `- ${r.name}: ${r.description || '(no description)'} · ${r.memoryCount} memories`).join('\n'))
    },

    /**
     * `new [name] [desc] [--from <example>]` — create an empty skeleton, or copy
     * a bundled example. The name defaults to the example's own name.
     */
    new(agent, name, description, from) {
      const target = name ?? from
      if (!target) {
        return fail('usage: /persona new <name> [description] — or /persona new [name] --from <example> (see /persona examples)')
      }
      const cwd = resolveCwd(agent)
      try {
        if (from !== undefined) {
          const dir = createPersonaFromExample(cwd, target, from, cfg.libraryDir)
          return okay(`Created ${dir} from example "${from}" — /persona use ${target} or /persona spawn ${target}.`)
        }
        const dir = createPersona(cwd, target, description ?? '', cfg.libraryDir)
        return okay(`Created ${dir} (empty skeleton)\nAuthor it with the /personas picker — the agent guides you through it — or edit PERSONA.md (identity+voice) and STATE.md (fields) by hand, then /persona use ${target} or /persona spawn ${target}.`)
      } catch (e) { return fail(e.message) }
    },

    /** `examples` — the archives shipped with this bundle. */
    examples() {
      const rows = listExamples()
      if (!rows.length) return okay('No example personas shipped with this bundle.')
      return okay(rows.map(r => `- ${r.name}: ${r.description || '(no description)'}`).join('\n')
        + '\nCreate one with: /persona new <name> --from <example>')
    },

    /** `use <name>` — equip onto this session and record the ledger row. */
    use(agent, name) {
      if (!name) return fail('usage: /persona use <name>')
      try {
        const { dir, bindingNote } = equipSession(agent, name, cfg, resolveCwd)
        return okay(`Persona "${name}" equipped — takes effect on your next message. ${dir}${bindingNote}`)
      } catch (e) { return fail(e.message) }
    },

    /** `off` — dispose the equip and clear the ledger row. */
    off(agent) {
      const cur = agent.personaEquip
      if (!cur) return fail('no persona equipped on this session')
      cur.dispose()
      delete agent.personaEquip
      clearBinding(libraryRoot(resolveCwd(agent), cfg.libraryDir), sessionIdOf(agent))
      return okay(`Persona "${cur.name}" removed; tools and sections unregistered.`)
    },

    /**
     * `spawn <name> [task]` — a continuable child equipped by construction.
     * The child is registered in the ledger the same way `use` registers its
     * session: without that row the picker cannot badge it and a restart cannot
     * re-equip it.
     */
    async spawn(agent, name, task) {
      if (!name) return fail('usage: /persona spawn <name> [task]')
      const cwd = resolveCwd(agent)
      if (!personaExists(cwd, name, cfg.libraryDir)) return fail(`persona "${name}" not found`)
      if (!ctx.subagents) return fail('subagents service unavailable')
      const childId = randomUUID()
      pendingContinuable.set(childId, name)
      const prompt = task
        ? task
        : `You are "${name}". Introduce yourself in character, then await instructions.`
      let id, messageId
      try {
        const started = await ctx.subagents.startContinuable({
          childId,
          provider: cfg.providerName ?? 'persona',
          label: `persona:${name}`,
          request: {
            parent: agent,
            prompt: [{ type: 'text', text: prompt }],
            // Name bound via pendingContinuable — prompt text is body only.
            persona: personaBodyText(cwd, name, cfg.libraryDir),
          },
          signal: NEVER_ABORTS,
        })
        id = started.childId
        messageId = started.messageId
      } catch (e) {
        pendingContinuable.delete(childId)   // failed spawn: no zombie pending entry
        throw e
      }
      const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), id, name)
      return okay(`Spawned persona agent "${name}" (session ${id}, message ${messageId}).${bindingNote}`)
    },

    /**
     * `compact <name>` — ONE in-process `ctx.llm.stream()` call, no child
     * session. The tree is the only input; validate → apply land the plan (see
     * lib/memory-compact.js). Nothing here touches `ctx.subagents`, so the run
     * leaves no session, no catalog row and no binding ledger entry.
     *
     * @param signal - carrier cancellation from a Remote caller; absent for the
     *   slash command, which has no caller-owned signal.
     */
    async compact(agent, name, signal) {
      if (!name) return fail('usage: /persona compact <name>')
      const cwd = resolveCwd(agent)
      if (!personaExists(cwd, name, cfg.libraryDir)) return fail(`persona "${name}" not found`)
      const dir = personaDir(cwd, name, cfg.libraryDir)
      try {
        const { report } = await compactWithLlm(ctx, { cfg, agent, dir, signal: signal ?? NEVER_ABORTS })
        return okay(`compact ${name}:\n${report}`)
      } catch (e) {
        // A refused plan is not a transport failure: the tree is untouched
        // by construction, and that difference must be visible.
        if (e?.code === 'PLAN_REFUSED') {
          return fail(`compact ${name}: plan refused, memory tree untouched — ${e.message}`)
        }
        return fail(`compact ${name} failed: ${e.message}`)
      }
    },

    /** `status` — the equip ON the agent plus the library size. */
    status(agent) {
      const cur = agent.personaEquip
      const rows = listPersonas(resolveCwd(agent), cfg.libraryDir)
      return okay([
        `equipped: ${cur ? cur.name : 'none'}`,
        `library: ${cfg.libraryDir}/ (${rows.length} persona${rows.length === 1 ? '' : 's'})`,
      ].join('\n'))
    },
  }
}

/**
 * Register the `/persona` slash command.
 *
 * The command layer is a pure parser: it splits the raw line into the
 * operation's parameters and maps the operation's `{ ok, text }` onto the
 * command result shape. Every behavior lives in `createPersonaOps()`.
 *
 * @param ctx - plugin context.
 * @param cfg - plugin config.
 * @param resolveCwd - workspace resolver for an agent.
 * @param ops - the shared operation table; created here when a caller has none
 *   (the `/personas` picker shares index.js's table so the two cannot drift).
 * @returns the operation table this command drives.
 */
export function registerCommands(ctx, cfg, resolveCwd, ops = createPersonaOps(ctx, cfg, resolveCwd)) {
  ctx.commands.register({
    name: 'persona',
    description: 'Manage persistent personas: /persona list|new|examples|use|off|spawn|compact|status — author a new one with the /personas picker (agent-guided)',
    input: { hint: '<list|new|examples|use|off|spawn|compact|status> [args]' },
    handler: async ({ agent, rawInput }) => {
      const [sub = '', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
      switch (sub) {
        case 'list':
          return toResult(ops.list(agent))
        case 'new': {
          // `--from` may appear anywhere; the first remaining token is the
          // persona name (defaulting to the example's own), the rest a desc.
          const fromAt = rest.indexOf('--from')
          const from = fromAt === -1 ? undefined : rest[fromAt + 1]
          const positional = fromAt === -1 ? rest : [...rest.slice(0, fromAt), ...rest.slice(fromAt + 2)]
          const [name, ...desc] = positional
          if (fromAt !== -1 && !from) return err('usage: /persona new [name] --from <example>')
          return toResult(ops.new(agent, name, desc.join(' '), from))
        }
        case 'examples':
          return toResult(ops.examples())
        case 'use': {
          const [name] = rest
          return toResult(ops.use(agent, name))
        }
        case 'off':
          return toResult(ops.off(agent))
        case 'spawn': {
          const [name, ...task] = rest
          return toResult(await ops.spawn(agent, name, task.join(' ')))
        }
        case 'compact': {
          const [name] = rest
          return toResult(await ops.compact(agent, name))
        }
        case 'status':
          return toResult(ops.status(agent))
        default:
          return err(`unknown subcommand "${sub}". Try: list | new <name> [--from <example>] | examples | use <name> | off | spawn <name> [task] | compact <name> | status`)
      }
    },
  })
  return ops
}

/** Map an operation outcome onto the command result the UI renders. */
const toResult = ({ ok, text }) => (ok ? { kind: 'success', text } : { kind: 'error', text })

const okay = (text) => ({ ok: true, text })
const fail = (text) => ({ ok: false, text })
const err = (text) => ({ kind: 'error', text })

/**
 * /persona slash commands: human entry points.
 *   list | new <name> [desc] | use <name> | off | spawn <name> [task] | compact <name> | status
 */
import { randomUUID } from 'node:crypto'
import { listPersonas, createPersona, personaExists, ensurePersona, personaDir, libraryRoot } from './persona.js'
import { equipAgent } from './equip.js'
import { pendingContinuable, personaRequestText, personaBodyText } from './provider.js'
import { persistBinding, clearBinding } from './bindings.js'

const PLUGIN = 'dsh-persona-system'

/**
 * A signal that never aborts.
 *
 * `new AbortSignal()` is a TypeError ("Illegal constructor") — `AbortSignal` is
 * an interface, not a constructible class — and the subagent entry points call
 * `signal.throwIfAborted()`, so a slash-command spawn needs a real, live signal.
 */
const NEVER_ABORTS = new AbortController().signal

/** Durable session id for the binding ledger (header id, matching resume-time lookups). */
const sessionIdOf = (agent) => agent?.session?.header?.id ?? agent?.session?.id

export function registerCommands(ctx, cfg, resolveCwd) {
  ctx.commands.register({
    name: 'persona',
    description: 'Manage persistent personas: /persona list|new|use|off|spawn|compact|status',
    input: { hint: '<list|new|use|off|spawn|compact|status> [args]' },
    handler: async ({ agent, rawInput }) => {
      const [sub = '', ...rest] = rawInput.trim().split(/\s+/).filter(Boolean)
      const cwd = resolveCwd(agent)
      switch (sub) {
        case 'list': {
          const rows = listPersonas(cwd, cfg.libraryDir)
          if (!rows.length) return ok(`No personas in ${cfg.libraryDir}/ — create one with /persona new <name>`)
          return ok(rows.map(r => `- ${r.name}: ${r.description || '(no description)'} · ${r.memoryCount} memories`).join('\n'))
        }
        case 'new': {
          const [name, ...desc] = rest
          if (!name) return err('usage: /persona new <name> [description]')
          try {
            const dir = createPersona(cwd, name, desc.join(' '), cfg.libraryDir)
            return ok(`Created ${dir}\nEdit PERSONA.md (identity+voice) and STATE.md (fields), then /persona use ${name} or /persona spawn ${name}.`)
          } catch (e) { return err(e.message) }
        }
        case 'use': {
          const [name] = rest
          if (!name) return err('usage: /persona use <name>')
          if (!personaExists(cwd, name, cfg.libraryDir)) return err(`persona "${name}" not found in ${cfg.libraryDir}/`)
          if (agent.personaEquip) return err(`already equipped as "${agent.personaEquip.name}" — /persona off first`)
          const dir = ensurePersona(cwd, name, cfg.libraryDir)
          const dispose = equipAgent(agent.ctx, agent, dir, name, cfg, 'session')
          // The equip lives on the agent itself — it IS this session's state.
          agent.personaEquip = { name, dispose }
          // Persist the binding so a resumed session re-equips itself and the
          // picker can badge it (session events can't carry this — see
          // lib/bindings.js header).
          const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), sessionIdOf(agent), name)
          return ok(`Persona "${name}" equipped — takes effect on your next message. ${personaDir(cwd, name, cfg.libraryDir)}${bindingNote}`)
        }
        case 'off': {
          const cur = agent.personaEquip
          if (!cur) return err('no persona equipped on this session')
          cur.dispose()
          delete agent.personaEquip
          clearBinding(libraryRoot(cwd, cfg.libraryDir), sessionIdOf(agent))
          return ok(`Persona "${cur.name}" removed; tools and sections unregistered.`)
        }
        case 'spawn': {
          const [name, ...task] = rest
          if (!name) return err('usage: /persona spawn <name> [task]')
          if (!personaExists(cwd, name, cfg.libraryDir)) return err(`persona "${name}" not found`)
          if (!ctx.subagents) return err('subagents service unavailable')
          const childId = randomUUID()
          pendingContinuable.set(childId, name)
          const prompt = task.length
            ? task.join(' ')
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
          // The child is equipped by construction, so it is registered the same
          // way `/persona use` registers its session: without this row the
          // picker cannot badge it and a restart cannot re-equip it.
          const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), id, name)
          return ok(`Spawned persona agent "${name}" (session ${id}, message ${messageId}).${bindingNote}`)
        }
        case 'compact': {
          const [name] = rest
          if (!name) return err('usage: /persona compact <name>')
          if (!personaExists(cwd, name, cfg.libraryDir)) return err(`persona "${name}" not found`)
          if (!ctx.subagents) return err('subagents service unavailable')
          const { readPromptAsset } = await import('./persona.js')
          const run = await ctx.subagents.start(cfg.providerName ?? 'persona', {
            label: `persona:${name}:compact`,
            prompt: [{ type: 'text', text: readPromptAsset('compact.md').trim() }],
            parent: agent,
            persona: personaRequestText(cwd, name, cfg.libraryDir),
            signal: NEVER_ABORTS,
          })
          // Registered before the run is awaited: the child session exists now,
          // so entering it while it works must already show it as equipped.
          const bindingNote = persistBinding(libraryRoot(cwd, cfg.libraryDir), run.id, name)
          const result = await run.result
          const text = (result.output ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
          return ok(`compact ${name} (${result.stopReason}):\n${text || '(no report)'}${bindingNote}`)
        }
        case 'status': {
          const cur = agent.personaEquip
          const rows = listPersonas(cwd, cfg.libraryDir)
          return ok([
            `equipped: ${cur ? cur.name : 'none'}`,
            `library: ${cfg.libraryDir}/ (${rows.length} persona${rows.length === 1 ? '' : 's'})`,
          ].join('\n'))
        }
        default:
          return err(`unknown subcommand "${sub}". Try: list | new <name> | use <name> | off | spawn <name> [task] | compact <name> | status`)
      }
    },
  })
}

const ok = (text) => ({ kind: 'success', text })
const err = (text) => ({ kind: 'error', text })

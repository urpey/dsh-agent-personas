/**
 * dsh-agent-personas — the `/personas` picker's Host channel.
 *
 * WHY THIS EXISTS
 * The `/` menu is printed from the Host command registry, and that registry has
 * no "hidden" flag: every registered command becomes a menu row
 * (`packages/interaction/commands/src/types.ts` — `CommandDefinition` carries
 * only `definitionId`/`name`/`description`/`input`). So hiding `/persona` means
 * NOT registering it — and then the picker's mutating rows can no longer reach
 * the Host through `session.command()`, which resolves against that same
 * registry. This module is the replacement channel.
 *
 * HOW IT REACHES THE HOST
 * The Gateway dispatches `namespace/method` requests against its strict
 * generated registry, and — for endpoints no generated face claims — falls back
 * to scanning every Cordis service for an explicit Remote binding
 * (`packages/api/gateway/src/index.ts`, `resolveSrcDescriptor`). Two markers make
 * a service eligible, and both are written here BY HAND because this bundle is
 * loaded from a plain directory whose bare specifiers do not resolve (it cannot
 * `import '@deepseek-ai/dsh-typert-protocol'`):
 *
 *   1. `service.typertRemote = { service, serviceKey, namespace }`
 *      — read by `validateBinding`/`readBinding`, which require `service` to be
 *      the receiver itself, `serviceKey` to match the Cordis service key, and
 *      `namespace` to match the requested namespace.
 *   2. a `remote-methods` descriptor on the PROTOTYPE
 *      — `{ version: 1, methods: [{ method, invocation: { kind: 'direct' } }] }`,
 *      read by `remoteMethods()`. The Gateway then derives the parameter list by
 *      parsing each method's source text (`methodParameterNames`), so every
 *      parameter must be a plain unique identifier — no destructuring, no
 *      defaults, no rest — and a trailing `signal` parameter becomes carrier
 *      cancellation.
 *
 * A parameter named `agent` is resolved by the Host's own `agent` lookup
 * provider (registered by `packages/core/agent`, wire field `agentId`), so the
 * browser only has to send the session id it already holds.
 *
 * UPGRADE RISK — the two markers are an internal Harness contract, not a public
 * API. If a Harness upgrade changes the descriptor key, the marker shape, or the
 * binding fields, the Gateway answers `gateway/binding-invalid` /
 * `gateway/invocation-unavailable` and the picker reports it — loudly, without
 * corrupting state. `tests/remote.test.js` pins the exact shapes; re-read the two
 * source locations above when that test starts failing.
 */

/**
 * Prototype property carrying the Remote method descriptor.
 * Mirrors `REMOTE_METHOD_DESCRIPTOR` in `@deepseek-ai/dsh-typert-protocol`.
 */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Cordis service key AND wire namespace of the picker's channel. */
export const REMOTE_SERVICE_KEY = 'personaInternals'

/**
 * The endpoints the picker may call. `list` and `status` are deliberately
 * absent: the popup already renders the library and the bound persona, so a
 * round trip would only repeat what the panel says.
 */
export const REMOTE_METHOD_NAMES = Object.freeze([
  'use',
  'off',
  'spawn',
  'compact',
  'newFromExample',
])

/**
 * Build the Host service the picker talks to.
 *
 * Every method forwards to the SAME operation bodies the `/persona` command
 * drives (`createPersonaOps`), so switching the command off cannot change what
 * an operation does — only how it is reached. Methods answer `{ ok, text }`
 * (JSON-safe by construction) instead of throwing for a business refusal, so the
 * picker can render a refusal as a notice; a thrown error therefore means a real
 * internal fault and surfaces as `gateway/internal`.
 *
 * @param ops - the shared operation table from `lib/commands.js`.
 * @returns the service value to hand to `ctx.provide()`.
 */
export function createPersonaInternals(ops) {
  /**
   * The Remote surface. Declared inside the factory so every method closes over
   * `ops` directly: the Gateway invokes methods on a Context-bound receiver, and
   * reading `ops` from the closure keeps that indirection from mattering.
   *
   * Method NAMES and PARAMETER NAMES are wire contract — see the header.
   */
  class PersonaInternals {
    /** `use <name>` — equip onto the calling session. */
    async use(agent, name) {
      return ops.use(agent, name)
    }

    /** `off` — unequip the calling session. */
    async off(agent) {
      return ops.off(agent)
    }

    /** `spawn <name> [task]` — a continuable child equipped by construction. */
    async spawn(agent, name, task) {
      return ops.spawn(agent, name, task)
    }

    /** `compact <name>` — one in-process memory compaction; `signal` = carrier cancellation. */
    async compact(agent, name, signal) {
      return ops.compact(agent, name, signal)
    }

    /**
     * The picker's example row: copy a bundled example under its own name.
     * `name` is left undefined on purpose — `ops.new` then defaults it to the
     * example's own name, exactly as `/persona new --from <example>` does.
     */
    async newFromExample(agent, example) {
      return ops.new(agent, undefined, undefined, example)
    }
  }

  Object.defineProperty(PersonaInternals.prototype, REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(REMOTE_METHOD_NAMES.map(method => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  })

  const service = new PersonaInternals()
  // `readBinding` requires the binding to name THIS object as its service and
  // the Cordis service key it was provided under; a mismatch is rejected before
  // any method runs.
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({
      service,
      serviceKey: REMOTE_SERVICE_KEY,
      namespace: REMOTE_SERVICE_KEY,
    }),
  })
  return service
}

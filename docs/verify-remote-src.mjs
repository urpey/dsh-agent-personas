/**
 * Upgrade regression check for the picker's Host channel.
 *
 * The `/personas` picker reaches the Host through the `personaInternals` Remote
 * service, which `bundle/lib/remote.js` declares with two HAND-WRITTEN markers
 * (a `typertRemote` binding and a prototype `remote-methods` descriptor). Those
 * markers are an internal Harness contract, not a public API: a Harness upgrade
 * that renames the descriptor key, changes the marker shape, or tightens the
 * binding rules turns every picker action into `gateway/binding-invalid` or
 * `gateway/invocation-unavailable`.
 *
 * The bundle cannot depend on the Harness (it ships zero dependencies and is
 * installed from a plain directory), so this check lives outside `bundle/` and
 * imports the Harness's own built modules by path. Run it after upgrading DSH,
 * or whenever a picker action reports a gateway error.
 *
 * Usage:
 *   node docs/verify-remote-src.mjs /path/to/deepseek-harness
 *
 * The Harness checkout must be built (`pnpm run build:lib`) — this imports
 * `packages/api/gateway/lib/index.js` and friends, not their sources.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node docs/verify-remote-src.mjs /path/to/deepseek-harness')
  process.exit(2)
}
const harness = resolve(root)
const required = [
  'vendor/cordis/lib/index.js',
  'packages/typert/registry/lib/index.js',
  'packages/api/gateway/lib/index.js',
]
for (const relative of required) {
  if (!existsSync(join(harness, relative))) {
    console.error(`missing ${relative} — is ${harness} a built DSH checkout? (pnpm run build:lib)`)
    process.exit(2)
  }
}

const { Context } = await import(join(harness, 'vendor/cordis/lib/index.js'))
const { TypertRegistry } = await import(join(harness, 'packages/typert/registry/lib/index.js'))
const { TypertGatewayService } = await import(join(harness, 'packages/api/gateway/lib/index.js'))
const { createPersonaInternals } = await import(new URL('../bundle/lib/remote.js', import.meta.url))

const AGENT = { id: 'agent-1', sentinel: 'the-real-agent-object' }
const calls = []

function ops() {
  const record = (name) => async (...args) => {
    calls.push([name, ...args])
    if (name === 'use' && args[1] === 'ghost') return { ok: false, text: 'persona "ghost" not found' }
    return { ok: true, text: `ran ${name}` }
  }
  return {
    list: record('list'),
    new: record('new'),
    examples: record('examples'),
    use: record('use'),
    off: record('off'),
    spawn: record('spawn'),
    compact: record('compact'),
    status: record('status'),
  }
}

const ctx = new Context()
await ctx.plugin(TypertRegistry)
await ctx.plugin(TypertGatewayService)
// Register the `agent` lookup exactly as AgentRegistry does
// (packages/core/agent/src/index.ts): it is what turns the wire's `agentId`
// into the Agent object handed to the method.
await new Promise((done) => {
  ctx.inject(['typert'], (typeCtx) => {
    typeCtx.typert.lookups.register('agent', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
      wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      resolve: sessionId => (sessionId === AGENT.id ? AGENT : undefined),
    })
    done()
  })
})
ctx.provide('personaInternals', createPersonaInternals(ops()))

async function code(request) {
  try {
    return { ok: true, value: await ctx.typertGateway.invoke(request) }
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error), message: error?.message }
  }
}

const results = []
function check(label, condition, detail) {
  results.push(condition)
  if (!condition) console.error(`FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  else console.log(`ok    ${label}`)
}

const endpoint = (method, args) => ({ namespace: 'personaInternals', method, args })

const use = await code(endpoint('use', { agentId: 'agent-1', name: 'alice' }))
check('use resolves the agent lookup and returns the envelope',
  use.ok && use.value?.ok === true && use.value?.text === 'ran use', use)
check('the method received the real agent object', calls.at(-1)?.[1] === AGENT, calls.at(-1))

const off = await code(endpoint('off', { agentId: 'agent-1' }))
check('off takes the agent alone', off.ok && off.value?.text === 'ran off', off)

// Under SRC every json parameter is omissible; `signal` is never a wire field.
const spawn = await code(endpoint('spawn', { agentId: 'agent-1', name: 'bob' }))
check('spawn admits an omitted json argument', spawn.ok && calls.at(-1)?.[3] === undefined, spawn)

const compact = await code(endpoint('compact', { agentId: 'agent-1', name: 'bob' }))
check('compact is callable without sending signal', compact.ok, compact)
check('compact received an AbortSignal last', calls.at(-1)?.[3] instanceof AbortSignal, typeof calls.at(-1)?.[3])

const example = await code(endpoint('newFromExample', { agentId: 'agent-1', example: 'deepseek' }))
check('newFromExample defers the name to the example',
  example.ok && calls.at(-1)?.[0] === 'new' && calls.at(-1)?.[2] === undefined && calls.at(-1)?.[4] === 'deepseek', example)

const refused = await code(endpoint('use', { agentId: 'agent-1', name: 'ghost' }))
check('a refusal crosses the wire as data',
  refused.ok && refused.value?.ok === false && refused.value?.text === 'persona "ghost" not found', refused)

// The boundaries the Gateway must still enforce.
const unknown = await code(endpoint('nope', { agentId: 'agent-1' }))
check('an unknown method is refused', !unknown.ok && unknown.code === 'gateway/invocation-unavailable', unknown)
const badAgent = await code(endpoint('use', { agentId: 'ghost-session', name: 'alice' }))
check('an unresolvable agentId is refused', !badAgent.ok && badAgent.code === 'gateway/lookup-not-found', badAgent)
const extra = await code(endpoint('use', { agentId: 'agent-1', name: 'alice', extra: 1 }))
check('an unexpected argument is refused', !extra.ok && extra.code === 'gateway/arguments-invalid', extra)
const noLookup = await code(endpoint('use', { name: 'alice' }))
check('an omitted lookup id is never omissible', !noLookup.ok && noLookup.code === 'gateway/arguments-invalid', noLookup)
const wrongNs = await code({ namespace: 'personas', method: 'use', args: { agentId: 'agent-1', name: 'alice' } })
check('another namespace does not reach this service', !wrongNs.ok && wrongNs.code === 'gateway/invocation-unavailable', wrongNs)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
assert.equal(passed, results.length, 'the picker Host channel no longer matches the Gateway contract')

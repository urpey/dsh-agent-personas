/**
 * The `/personas` picker's Host channel (`lib/remote.js`).
 *
 * Hiding `/persona` means not registering it (the Host command registry has no
 * hidden flag), so the picker cannot submit command lines any more. It calls the
 * `personaInternals` Remote service instead, which the Gateway discovers through
 * its SRC fallback: it scans every Cordis service for a `typertRemote` binding
 * and reads the method list from a `remote-methods` descriptor on the service's
 * PROTOTYPE, then derives each parameter list by parsing the method's own source
 * text (`packages/api/gateway/src/index.ts`, `resolveSrcDescriptor` /
 * `methodParameterNames`).
 *
 * Both markers are written BY HAND in `lib/remote.js` — this bundle cannot
 * import `@deepseek-ai/dsh-typert-protocol` (bare specifiers do not resolve from
 * a profile-installed directory) — so these tests pin the exact shapes the
 * Gateway requires. A Harness upgrade that changes them must fail HERE, with the
 * reason, rather than as an opaque `gateway/binding-invalid` in the browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPersonaInternals, REMOTE_METHOD_NAMES, REMOTE_SERVICE_KEY } from '../lib/remote.js'

/** Prototype property carrying the Remote method descriptor. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** An operation table that records how each call arrived. */
function recordingOps() {
  const calls = []
  const answer = (name) => (...args) => {
    calls.push([name, ...args])
    return { ok: true, text: `ran ${name}` }
  }
  return {
    calls,
    ops: {
      list: answer('list'),
      new: answer('new'),
      examples: answer('examples'),
      use: answer('use'),
      off: answer('off'),
      spawn: answer('spawn'),
      compact: answer('compact'),
      status: answer('status'),
    },
  }
}

/**
 * Mirror of the Gateway's `methodParameterNames` rule: the list is read from the
 * method's source text, so anything but plain identifiers is rejected before the
 * endpoint can ever be called.
 */
function parameterNames(service, method) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), method)
  assert.equal(typeof descriptor?.value, 'function', `${method} must be a PROTOTYPE method`)
  const source = Function.prototype.toString.call(descriptor.value)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  assert.ok(open >= 0 && close > open, `${method} must declare a parameter list`)
  const body = source.slice(open + 1, close).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

test('the prototype carries a v1 Remote method descriptor naming every endpoint', () => {
  const { ops } = recordingOps()
  const service = createPersonaInternals(ops)

  const property = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), REMOTE_METHODS)
  assert.ok(property, 'the descriptor must sit on the PROTOTYPE: remoteMethods() reads it there')
  const descriptor = property.value
  assert.equal(descriptor.version, 1, 'an unknown version is rejected outright')
  assert.ok(Array.isArray(descriptor.methods))

  assert.deepEqual(
    descriptor.methods.map(marker => marker.method),
    [...REMOTE_METHOD_NAMES],
  )
  for (const marker of descriptor.methods) {
    // A `context` invocation would demand a Host Context provider; every
    // endpoint here is a plain call.
    assert.deepEqual(marker.invocation, { kind: 'direct' }, `${marker.method} must be a direct invocation`)
    assert.equal(marker.mode, undefined, `${marker.method} is unary, never a stream`)
    assert.equal(marker.exportName, undefined, `${marker.method} exports under its own name`)
  }
})

test('the binding names this very service, under the key it is provided as', () => {
  const { ops } = recordingOps()
  const service = createPersonaInternals(ops)

  // `readBinding` rejects the endpoint unless all three fields agree with the
  // request and the Cordis registration.
  assert.deepEqual(service.typertRemote, {
    service,
    serviceKey: REMOTE_SERVICE_KEY,
    namespace: REMOTE_SERVICE_KEY,
  })
  assert.equal(REMOTE_SERVICE_KEY, 'personaInternals', 'the client hard-codes this namespace in its endpoint')
  assert.equal(typeof service.typertRemote.namespace, 'string')
})

test('every endpoint declares plain, unique parameters with agent first and signal last', () => {
  const { ops } = recordingOps()
  const service = createPersonaInternals(ops)

  for (const method of REMOTE_METHOD_NAMES) {
    const names = parameterNames(service, method)
    assert.ok(names.length > 0, `${method} must declare parameters`)
    for (const name of names) {
      assert.match(name, /^[$A-Z_a-z][$\w]*$/u, `${method}: "${name}" is not a plain identifier`)
    }
    assert.equal(new Set(names).size, names.length, `${method}: duplicate parameter name`)
    // `agent` is the Host lookup that turns the wire's `agentId` into the Agent,
    // so it must be a top-level parameter of every endpoint.
    assert.equal(names[0], 'agent', `${method} must take the agent lookup first`)
    // Cancellation is only recognized in the final position.
    const signal = names.indexOf('signal')
    if (signal !== -1) assert.equal(signal, names.length - 1, `${method}: signal must come last`)
  }
  assert.deepEqual(parameterNames(service, 'compact'), ['agent', 'name', 'signal'])
})

test('each endpoint forwards to the shared operation body and returns its outcome unchanged', async () => {
  const { ops, calls } = recordingOps()
  const service = createPersonaInternals(ops)
  const agent = { id: 'agent-1' }

  assert.deepEqual(await service.use(agent, 'alice'), { ok: true, text: 'ran use' })
  assert.deepEqual(await service.off(agent), { ok: true, text: 'ran off' })
  assert.deepEqual(await service.spawn(agent, 'alice', 'do the thing'), { ok: true, text: 'ran spawn' })
  assert.deepEqual(await service.compact(agent, 'alice', undefined), { ok: true, text: 'ran compact' })

  assert.deepEqual(calls, [
    ['use', agent, 'alice'],
    ['off', agent],
    ['spawn', agent, 'alice', 'do the thing'],
    ['compact', agent, 'alice', undefined],
  ])
})

test('the example row defers its name to the example, exactly like /persona new --from', async () => {
  const { ops, calls } = recordingOps()
  const service = createPersonaInternals(ops)
  const agent = { id: 'agent-1' }

  assert.deepEqual(await service.newFromExample(agent, 'deepseek'), { ok: true, text: 'ran new' })
  // `name` stays undefined so `ops.new` defaults it to the example's own name.
  assert.deepEqual(calls, [['new', agent, undefined, undefined, 'deepseek']])
})

test('a business refusal stays data — it is never thrown at the wire', async () => {
  const { ops } = recordingOps()
  // The picker renders `{ ok: false, text }` as a notice; throwing instead would
  // arrive as an opaque `gateway/internal` and lose the reason.
  ops.use = async () => ({ ok: false, text: 'already equipped as "alice"' })
  const service = createPersonaInternals(ops)

  assert.deepEqual(await service.use({ id: 'agent-1' }, 'alice'), { ok: false, text: 'already equipped as "alice"' })
})

test('every exposed method answers a JSON-safe envelope', async () => {
  const { ops } = recordingOps()
  const service = createPersonaInternals(ops)
  const agent = { id: 'agent-1' }

  for (const [method, args] of [
    ['use', ['alice']],
    ['off', []],
    ['spawn', ['alice', undefined]],
    ['compact', ['alice', undefined]],
    ['newFromExample', ['deepseek']],
  ]) {
    const value = await service[method](agent, ...args)
    // The Gateway deep-copies the result and rejects anything non-JSON.
    assert.deepEqual(Object.keys(value).sort(), ['ok', 'text'], `${method} must answer { ok, text }`)
    assert.equal(typeof value.ok, 'boolean')
    assert.equal(typeof value.text, 'string')
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)))
  }
})

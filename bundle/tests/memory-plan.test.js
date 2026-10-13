/**
 * The memory-audit plan: snapshot rendering, plan validation, and application.
 *
 * The audit's whole safety story lives here. A plan is applied only after every
 * op validates against the tree it was built from, because a half-applied merge
 * is indistinguishable from a deliberate state on the next pass — the survivor
 * exists, the alias does not, and nothing records that the two belonged
 * together. These tests pin the refusals as hard as the happy path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { renderMemorySnapshot, validatePlan, applyPlan, describePlan, PLAN_SCHEMA } from '../lib/memory-plan.js'
import { readNode, syncIndex } from '../lib/memory-store.js'

/** A persona archive with a small, deliberately messy memory tree. */
function tree({ boot = ['memory://core/identity'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'persona-plan-'))
  const dir = join(root, '.persona', 'deepseek')
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'),
    `# Memory Index — deepseek\n\n## Boot URIs\n${boot.join('\n')}\n\n## Index\n`, 'utf8')
  write(join(dir, 'memory/core/identity.md'),
    '---\ntitle: identity\npriority: 1\ndisclosure: "boot"\n---\n\n我是鲸萝。\n')
  write(join(dir, 'memory/core/user/no_detours.md'),
    '---\ntitle: no_detours\npriority: 2\ndisclosure: "每次组织回复时记得：结论先行"\ntriggers:\n  - 绕弯\n---\n\n主人受不了绕弯子。\n')
  write(join(dir, 'memory/core/user/think_before_speaking.md'),
    '---\ntitle: think_before_speaking\npriority: 1\ndisclosure: "每次组织回复时：先想清楚"\ntriggers:\n  - 结论\n---\n\n主人要我深入思考。\n')
  write(join(dir, 'memory/core/user/user_love.md'),
    '---\naliasOf: "memory://core/user/think_before_speaking"\npriority: 1\ndisclosure: "主人说爱我时"\n---\n\n')
  return dir
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

const bodyOf = (dir, uri) => readNode(dir, uri).content
const rawOf = (dir, uri) => readFileSync(join(dir, 'memory', `${uri.replace('memory://', '')}.md`), 'utf8')

test('the snapshot carries the index and every node body', () => {
  const dir = tree()
  const text = renderMemorySnapshot(dir)

  assert.match(text, /## Current index \(MEMORY\.md\)/)
  assert.match(text, /memory:\/\/core\/user\/no_detours — no_detours/)
  assert.match(text, /## Nodes \(4\)/)
  assert.match(text, /主人受不了绕弯子/)
  assert.match(text, /triggers: 绕弯/)
  // An alias must be visible as a doorway, not mistaken for an empty node.
  assert.match(text, /aliasOf: memory:\/\/core\/user\/think_before_speaking/)
  assert.match(text, /\(alias — no body of its own\)/)
})

test('the schema stays inside the enforced subset', () => {
  // `oneOf` with `required` inside branches is rejected by assertObjectJsonSchema,
  // so the op union is one flat shape discriminated by `op`.
  assert.equal(PLAN_SCHEMA.type, 'object')
  assert.equal(PLAN_SCHEMA.additionalProperties, false)
  assert.deepEqual(PLAN_SCHEMA.required, ['ops'])
  const item = PLAN_SCHEMA.properties.ops.items
  assert.equal(item.type, 'object')
  assert.deepEqual(item.properties.op.enum, ['update', 'alias', 'delete'])
  assert.deepEqual(item.required, ['op', 'uri'])
  assert.equal(item.additionalProperties, false)
  assert.equal(item.oneOf, undefined, 'the enforced subset cannot express a required-bearing oneOf')
})

test('a merge plan applies in order: rewrite, alias, then index rebuild', () => {
  const dir = tree()
  const { ops, warnings } = validatePlan(dir, {
    ops: [
      { op: 'alias', uri: 'memory://core/user/no_detours', target: 'memory://core/user/think_before_speaking' },
      {
        op: 'update',
        uri: 'memory://core/user/think_before_speaking',
        content: '主人要我深入思考。他还受不了绕弯子，回答先给结论。',
        priority: 1,
        disclosure: '每次组织回复时：先想清楚，再给结论，不绕',
        triggers: ['结论', '不绕'],
      },
    ],
  })
  const result = applyPlan(dir, ops)

  assert.deepEqual(warnings, [])
  assert.equal(bodyOf(dir, 'memory://core/user/think_before_speaking'), '主人要我深入思考。他还受不了绕弯子，回答先给结论。')
  assert.deepEqual(readNode(dir, 'memory://core/user/think_before_speaking').triggers, ['结论', '不绕'])
  assert.equal(readNode(dir, 'memory://core/user/no_detours').aliasTarget, 'memory://core/user/think_before_speaking')
  assert.match(rawOf(dir, 'memory://core/user/no_detours'), /aliasOf:/)
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  assert.match(index, /memory:\/\/core\/user\/no_detours — alias→memory:\/\/core\/user\/think_before_speaking/)
  assert.match(index, /再给结论，不绕/, 'the rewritten disclosure must reach the index')
  assert.equal(result.index.rows, 4)
  assert.match(describePlan(result), /updated 1, aliased 1, deleted 0/)
})

test('triggers are replaced wholesale, not merged', () => {
  const dir = tree()
  const { ops } = validatePlan(dir, {
    ops: [{ op: 'update', uri: 'memory://core/user/think_before_speaking', content: '正文。', triggers: ['新词'] }],
  })
  applyPlan(dir, ops)

  assert.deepEqual(readNode(dir, 'memory://core/user/think_before_speaking').triggers, ['新词'], 'a noisy trigger must be removable')
})

test('an empty plan is a valid answer and rewrites nothing', () => {
  const dir = tree()
  const before = rawOf(dir, 'memory://core/user/no_detours')
  const result = applyPlan(dir, validatePlan(dir, { ops: [] }).ops)

  assert.equal(rawOf(dir, 'memory://core/user/no_detours'), before)
  assert.match(describePlan(result), /no edits/)
})

test('an update must carry a body — the patch channel is not the plan channel', () => {
  const dir = tree()
  assert.throws(
    () => validatePlan(dir, { ops: [{ op: 'update', uri: 'memory://core/user/no_detours', priority: 5 }] }),
    /no content/,
  )
})

test('every op is validated against the tree before a single write lands', () => {
  const dir = tree()
  const cases = [
    [{ ops: 'nope' }, /must be an object with an `ops` array/],
    [{ ops: [{ op: 'purge', uri: 'memory://core/identity' }] }, /unknown op "purge"/],
    [{ ops: [{ op: 'update', uri: 'core/identity', content: 'x' }] }, /needs a memory:\/\/ uri/],
    [{ ops: [{ op: 'delete', uri: 'memory://nope' }] }, /not in the memory tree/],
    [{ ops: [{ op: 'alias', uri: 'memory://core/identity', target: 'memory://core/identity' }] }, /to itself/],
    [{ ops: [{ op: 'alias', uri: 'memory://core/identity', target: 'memory://ghost' }] }, /not in the memory tree/],
    [{ ops: [
      { op: 'update', uri: 'memory://core/identity', content: 'a' },
      { op: 'delete', uri: 'memory://core/identity' },
    ] }, /one op per node per pass/],
  ]
  for (const [plan, pattern] of cases) {
    assert.throws(() => validatePlan(dir, plan), pattern, `must refuse: ${JSON.stringify(plan)}`)
  }
  assert.ok(existsSync(join(dir, 'memory/core/identity.md')), 'a refused plan must not have written anything')
})

test('deleting a URI another node still aliases is refused', () => {
  const dir = tree()
  // `user_love` already aliases `think_before_speaking`, so retiring the target
  // would leave that doorway pointing at nothing.
  assert.throws(
    () => validatePlan(dir, { ops: [{ op: 'delete', uri: 'memory://core/user/think_before_speaking' }] }),
    /still alias it/,
  )
  // Retiring both together is fine — the doorway goes with the room.
  const both = validatePlan(dir, { ops: [
    { op: 'delete', uri: 'memory://core/user/think_before_speaking' },
    { op: 'delete', uri: 'memory://core/user/user_love' },
  ] })
  assert.equal(both.ops.length, 2)
})

test('an alias cycle is refused rather than left to blow the stack', () => {
  const dir = tree()
  assert.throws(() => validatePlan(dir, { ops: [
    { op: 'alias', uri: 'memory://core/user/no_detours', target: 'memory://core/user/think_before_speaking' },
    { op: 'alias', uri: 'memory://core/user/think_before_speaking', target: 'memory://core/user/no_detours' },
  ] }), /alias cycle/)
})

test('an alias may not point at something the same plan deletes', () => {
  const dir = tree()
  // Either refusal is correct here: the pre-existing `user_love` doorway is
  // caught first, and the final-state check would catch it otherwise.
  assert.throws(() => validatePlan(dir, { ops: [
    { op: 'alias', uri: 'memory://core/user/no_detours', target: 'memory://core/user/think_before_speaking' },
    { op: 'delete', uri: 'memory://core/user/think_before_speaking' },
  ] }), /still alias it|not a node this plan leaves behind/)
})

test('retiring a booted node is allowed but reported', () => {
  const dir = tree({ boot: ['memory://core/identity', 'memory://core/user/no_detours'] })
  const { ops, warnings } = validatePlan(dir, { ops: [{ op: 'delete', uri: 'memory://core/user/no_detours' }] })
  const result = applyPlan(dir, ops)

  assert.match(warnings.join('\n'), /deleted memory:\/\/core\/user\/no_detours, which is listed under Boot URIs/)
  assert.equal(existsSync(join(dir, 'memory/core/user/no_detours.md')), false)
  // The boot line survives the delete, so the dangling promise is still visible
  // to the operator instead of being quietly edited away.
  assert.deepEqual(result.index.missingBoot, ['memory://core/user/no_detours'])
  assert.match(describePlan(result, warnings), /boot URI memory:\/\/core\/user\/no_detours no longer resolves/)
})

test('the index is rebuilt from the tree, so a stale row cannot survive', () => {
  const dir = tree()
  // A row for a node that no longer exists, plus a missing row for one that does.
  writeFileSync(join(dir, 'MEMORY.md'),
    `# Memory Index — deepseek\n\n## Boot URIs\nmemory://core/identity\n\n## Index\n- [gone] memory://core/ghost — ghost\n`, 'utf8')
  const { rows, missingBoot } = syncIndex(dir)
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')

  assert.equal(rows, 4)
  assert.doesNotMatch(index, /ghost/, 'a row with no node behind it must not survive a rebuild')
  assert.match(index, /memory:\/\/core\/user\/no_detours — no_detours/)
  assert.deepEqual(missingBoot, [], 'the boot section is authored, not projected')
  assert.match(index, /## Boot URIs\nmemory:\/\/core\/identity/, 'the boot section must be preserved verbatim')
})

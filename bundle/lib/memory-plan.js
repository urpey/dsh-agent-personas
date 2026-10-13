/**
 * The memory-audit plan: snapshot the tree into a prompt, validate the model's
 * edit plan against that snapshot, then apply it in one deterministic pass.
 *
 * Why a plan instead of a tool loop. The audit used to be a subagent calling
 * `memory_read` per node and `memory_update` per edit: the model spent a round
 * trip per discovery, and every write was a guess about state it had read
 * several calls ago. Here the whole tree is small enough to hand over up
 * front, the model answers ONCE with an edit plan, and this module applies it
 * against the same snapshot the model reasoned about. One model call, N file
 * writes, no re-reads — and a merge no longer has to survive a patch anchor.
 *
 * The plan is validated before ANY write lands. A half-applied audit is worse
 * than a refused one: a merge that wrote its survivor but never its alias
 * leaves links dangling, and the next audit cannot tell that from a deliberate
 * state. So the order is always: validate everything, then write.
 */
import { listNodes, readNode, rewriteNode, createAlias, deleteNode, syncIndex, bootUris } from './memory-store.js'

/**
 * The `structured_output` parameter schema. The enforced subset (see
 * `dsh-tools/json-schema`) accepts object properties, `required`, boolean
 * `additionalProperties`, array `items`, and scalar `enum` — but NOT `oneOf`
 * with `required` inside branches, so the op union is flattened into one shape
 * discriminated by `op` and cross-checked here instead.
 */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['update', 'alias', 'delete'],
            description: 'update = rewrite a node in place; alias = keep a URI as a doorway to another; delete = retire a node.',
          },
          uri: { type: 'string', description: 'The memory:// path this op targets.' },
          content: { type: 'string', description: 'update only: the node\'s COMPLETE new body.' },
          priority: { type: 'integer', description: 'update only: p0–p2 load-bearing self-knowledge, p3 default, p4–p6 stale or trivial.' },
          disclosure: { type: 'string', description: 'update only: when this memory should surface, as an index line.' },
          triggers: { type: 'array', items: { type: 'string' }, description: 'update only: the COMPLETE replacement trigger list.' },
          target: { type: 'string', description: 'alias only: the memory:// path this URI should resolve to.' },
          reason: { type: 'string', description: 'Why this op is right, in one short sentence. Reported to the operator.' },
        },
        required: ['op', 'uri'],
        additionalProperties: false,
      },
    },
  },
  required: ['ops'],
  additionalProperties: false,
}

/** Sort so a merge's alias exists before anything deletes its old URI. */
const APPLY_ORDER = { update: 0, alias: 1, delete: 2 }

/**
 * Render every node as prompt text: the index first (what the model would see
 * at runtime), then each node's frontmatter and full body.
 * @param personaDir - persona archive root.
 * @returns the snapshot text handed to the audit model.
 */
export function renderMemorySnapshot(personaDir) {
  const nodes = listNodes(personaDir)
  const lines = nodes
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.uri.localeCompare(b.uri))
    .map(n => `- [${n.disclosure || 'always'}] ${n.uri} — ${n.aliasOf ? `alias→${n.aliasOf}` : n.title ?? '(untitled)'}`)

  const bodies = []
  for (const n of nodes) {
    let node
    try {
      node = readNode(personaDir, n.uri)
    } catch (e) {
      // A node whose alias target is gone is still real state the audit must
      // see — report it instead of hiding it from the snapshot.
      bodies.push(`### ${n.uri}\n[BROKEN: ${e.message}]`)
      continue
    }
    const meta = [
      `title: ${node.title ?? '(untitled)'}`,
      `priority: ${node.priority ?? 3}`,
      `disclosure: ${node.disclosure || '(none)'}`,
      `triggers: ${(node.triggers ?? []).join(', ') || '(none)'}`,
      ...(node.aliasTarget ? [`aliasOf: ${node.aliasTarget}`] : []),
    ].join('\n')
    const body = node.aliasTarget ? '(alias — no body of its own)' : node.content || '(empty)'
    bodies.push(`### ${n.uri}\n${meta}\n\n${body}`)
  }
  return [
    `## Current index (MEMORY.md)\n${lines.length ? lines.join('\n') : '(no nodes)'}`,
    `## Nodes (${nodes.length})\n${bodies.length ? bodies.join('\n\n') : '(no nodes)'}`,
  ].join('\n\n')
}

/**
 * Validate a plan against the snapshot it was built from, and return the ops in
 * application order.
 *
 * Everything a write could get wrong is caught here: an op naming a node that
 * does not exist, an alias to a missing or self-referential target, an alias
 * cycle that would make `readNode` recurse forever, a delete that would strand
 * an alias or a boot URI, a second op on the same URI, and an update that
 * carries no content at all.
 *
 * @param personaDir - persona archive root.
 * @param plan - the model's `structured_output` value.
 * @returns ordered ops plus non-fatal warnings.
 * @throws when the plan cannot be applied safely.
 */
export function validatePlan(personaDir, plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.ops)) {
    throw new Error('memory plan must be an object with an `ops` array')
  }
  const nodes = new Map(listNodes(personaDir).map(n => [n.uri, n]))
  const warnings = []
  const seen = new Set()
  const ops = []
  const deleted = new Set()

  for (const [index, raw] of plan.ops.entries()) {
    const at = `op[${index}]`
    if (!raw || typeof raw !== 'object') throw new Error(`${at} must be an object`)
    const { op, uri } = raw
    if (op !== 'update' && op !== 'alias' && op !== 'delete') {
      throw new Error(`${at} has unknown op "${op}" (expected update, alias, or delete)`)
    }
    if (typeof uri !== 'string' || !uri.startsWith('memory://')) {
      throw new Error(`${at} needs a memory:// uri`)
    }
    if (seen.has(uri)) throw new Error(`${at} repeats ${uri}: one op per node per pass`)
    seen.add(uri)
    if (!nodes.has(uri)) throw new Error(`${at} names ${uri}, which is not in the memory tree`)

    if (op === 'update') {
      if (typeof raw.content !== 'string' || raw.content.trim() === '') {
        throw new Error(`${at} updates ${uri} with no content: an update must carry the complete new body`)
      }
      ops.push({
        op,
        uri,
        content: raw.content,
        priority: raw.priority,
        disclosure: raw.disclosure,
        triggers: raw.triggers,
        reason: raw.reason,
      })
      continue
    }

    if (op === 'alias') {
      if (typeof raw.target !== 'string' || !raw.target.startsWith('memory://')) {
        throw new Error(`${at} aliases ${uri} to no memory:// target`)
      }
      if (raw.target === uri) throw new Error(`${at} aliases ${uri} to itself`)
      if (!nodes.has(raw.target)) throw new Error(`${at} aliases ${uri} to ${raw.target}, which is not in the memory tree`)
      ops.push({ op, uri, target: raw.target, reason: raw.reason })
      continue
    }

    // delete: nothing may be left pointing at the URI. An alias whose own op in
    // this plan removes it is not left behind — `replaced` holds only the URIs
    // that stop being aliases, because a deleted alias cannot dangle.
    const replaced = new Set(plan.ops.filter(o => o.op !== 'alias').map(o => o.uri))
    const stranded = [...nodes.values()]
      .filter(n => n.aliasOf === uri && !replaced.has(n.uri))
      .map(n => n.uri)
    if (stranded.length > 0) {
      throw new Error(`${at} deletes ${uri}, but ${stranded.join(', ')} still alias it — alias or delete those in this same plan`)
    }
    deleted.add(uri)
    ops.push({ op, uri, reason: raw.reason })
  }

  // Alias targets must land somewhere real. `readNode` resolves aliases by
  // recursing, so a cycle is a stack overflow rather than a soft failure, and a
  // doorway to a retired node is a read error the next audit cannot explain.
  const finalAlias = new Map([
    ...[...nodes.values()].filter(n => n.aliasOf).map(n => [n.uri, n.aliasOf]),
    ...ops.filter(o => o.op === 'alias').map(o => [o.uri, o.target]),
  ])
  for (const uri of [...deleted]) finalAlias.delete(uri)
  for (const [uri, target] of finalAlias) {
    if (!nodes.has(target) && !finalAlias.has(target)) {
      throw new Error(`alias ${uri} points at ${target}, which is not a node this plan leaves behind`)
    }
    // Every node reachable from uri must be distinct from uri itself.
    const seen = new Set()
    const walk = [target]
    while (walk.length > 0) {
      const at = walk.pop()
      if (at === uri) throw new Error(`alias cycle: ${uri} → … → ${uri}`)
      if (seen.has(at)) continue
      seen.add(at)
      const next = finalAlias.get(at)
      if (typeof next === 'string') walk.push(next)
    }
  }

  // A boot URI is a deliberate promise that a node loads at session start.
  // Retiring one is allowed, but it must be said out loud.
  for (const uri of deleted) {
    if (bootUris(personaDir).includes(uri)) {
      warnings.push(`deleted ${uri}, which is listed under Boot URIs in MEMORY.md — remove that line`)
    }
  }

  ops.sort((a, b) => APPLY_ORDER[a.op] - APPLY_ORDER[b.op])
  return { ops, warnings }
}

/**
 * Apply a validated plan and rebuild the index.
 *
 * Triggers are diffed against the snapshot rather than passed through: the
 * store's patch channel takes add/remove lists, so the exact replacement list
 * the model asked for has to be expressed as the delta that produces it.
 *
 * @param personaDir - persona archive root.
 * @param ops - ops from {@link validatePlan}.
 * @returns per-op results and the post-write index state.
 */
export function applyPlan(personaDir, ops) {
  const before = new Map(listNodes(personaDir).map(n => [n.uri, n]))
  const applied = []
  for (const o of ops) {
    if (o.op === 'update') {
      const current = before.get(o.uri)
      const nextTriggers = Array.isArray(o.triggers) ? o.triggers.map(String) : undefined
      rewriteNode(personaDir, o.uri, {
        content: o.content,
        priority: o.priority,
        disclosure: o.disclosure,
        triggers: nextTriggers,
      })
      const removed = (current?.triggers ?? []).filter(t => !(nextTriggers ?? []).includes(t))
      applied.push({ op: 'update', uri: o.uri, removedTriggers: removed, reason: o.reason })
      continue
    }
    if (o.op === 'alias') {
      deleteNode(personaDir, o.uri)
      createAlias(personaDir, o.uri, o.target, {
        priority: before.get(o.uri)?.priority ?? 3,
        disclosure: before.get(o.uri)?.disclosure ?? '',
      })
      applied.push({ op: 'alias', uri: o.uri, target: o.target, reason: o.reason })
      continue
    }
    deleteNode(personaDir, o.uri)
    applied.push({ op: 'delete', uri: o.uri, reason: o.reason })
  }
  const index = syncIndex(personaDir)
  return { applied, index }
}

/**
 * One operator-facing report line per applied op, plus the index outcome.
 * @param result - {@link applyPlan}'s result.
 * @param warnings - {@link validatePlan}'s warnings.
 * @returns the report body for the command reply.
 */
export function describePlan(result, warnings = []) {
  const counts = { update: 0, alias: 0, delete: 0 }
  const lines = []
  for (const a of result.applied) {
    counts[a.op] += 1
    const detail = a.op === 'alias' ? `→ ${a.target}` : a.removedTriggers?.length ? `(dropped triggers: ${a.removedTriggers.join(', ')})` : ''
    lines.push(`- ${a.op} ${a.uri} ${detail}${a.reason ? ` — ${a.reason}` : ''}`.replace(/\s+/g, ' ').trim())
  }
  const tally = `updated ${counts.update}, aliased ${counts.alias}, deleted ${counts.delete}; index rebuilt (${result.index.rows} rows)`
  const notes = [
    ...warnings,
    ...result.index.missingBoot.map(uri => `boot URI ${uri} no longer resolves — fix the Boot URIs section`),
  ]
  return [
    tally,
    ...(lines.length ? lines : ['- no edits: the tree was already clean']),
    ...notes.map(n => `! ${n}`),
  ].join('\n')
}

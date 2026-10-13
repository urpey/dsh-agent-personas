---
name: persona-authoring
description: Author a new persona archive under .persona/<name>/ — the PERSONA.md three-layer skeleton, STATE.md field/table design, and boot memory seeds. Use when creating a persona (including the "Create a persona" / 新建人格 path) or reviewing an existing archive's files.
---

# Persona Authoring

A persona archive is `.persona/<name>/` — `PERSONA.md` (identity + voice), `STATE.md` (numeric state), `MEMORY.md` + `memory/` (URI memory tree). You author it *with* the user, in the session they asked from, in the fixed flow below.

## Hard rules

**1 · Save with `persona_save` — it is your only write channel.** Direct `write` / `edit` / `multi_edit` / `bash` calls that touch `.persona/**` are refused by the plugin's `tools/pre-execute` guard in an equipped session, so a profile cannot be authored with file tools: do not try, and do not plan around it. `persona_save` is a tool face, not a file tool — it validates the whole archive and then writes it in one act. Never tell the user an archive exists unless a `persona_save` call returned success.

**2 · Legalize the name to `^[\w-]+$`.** ASCII letters, digits, `_` and `-` only. A name the user says out loud (「鲸萝」, "Fischl von Luftschloss") is a *display* name: propose an ASCII slug (`jingluo`, `fischl`), get the user's agreement, then use it as both the directory name and the `name` argument. The display name and its aliases go in Layer 1 `identity` and the `triggers` list — that is what the persona answers to, not what the directory is called.

**3 · Equip with `persona_use`.** It shares one implementation with `/persona use`, so the equip and its binding row land together. If a persona is already equipped the call refuses — relay that and ask the user to run `/persona off` first; do not look for another route.

**4 · `persona_save` creates; it never overwrites.** An existing name is rejected (an existing archive is the human's to edit, by hand), and the currently equipped archive is rejected outright — a live persona cannot rewrite itself. A variant is a new name.

**5 · Enough material means draft, not interview.** The interview exists to fill gaps. When the user pastes persona material, a setting doc, or a paragraph that already answers identity / voice / dynamics, go straight to the draft. Ask only what is genuinely missing — the archive name always is (rule 2).

## Fixed flow

```text
Phase A · Collect (one question at a time)
  Q0  Do you have persona material already (an existing profile, a setting doc, loose notes)?
    ├─ yes → paste it → Phase B
    └─ no  → fixed interview, each question shipping a recommended answer
             ("ok" adopts it):
        ① name legalized to ^[\w-]+$; candidates confirmed by the user
        ② who it is       one-line identity + non-negotiable principles + how it thinks
        ③ how it talks    register / sentence habits / taboos / default length,
                          plus typical scenes for the reply examples (≥3 pairs)
        ④ inner dynamics  emotional baseline, starting stance toward the user,
                          optional MBTI / interests
Phase B · Draft  Show PERSONA.md + STATE.md + memory/core/identity.md in full, and say
  plainly: "tell me what to change — or say ok and I'll save it."
Phase C · Save
  One persona_save(name, files) call. On failure, report the error and keep editing;
  nothing is ever half-written.
Phase D · Close out
  Report what landed → ask once whether to equip.
    ├─ yes → persona_use(name)   (one already equipped: ask for /persona off first)
    └─ no  → point at /persona use <name> or /persona spawn <name>
```

**Phase A · Collect.** Look at what exists first (`persona_list`, or read `.persona/`). Then one question per turn — a wall of questions gets skimmed answers. Phase complete when you could write every Layer 1/2 field (including three or more reply examples) and the Layer 3 field list without inventing anything the user has not said or approved.

**Phase B · Draft.** Show the *full text* of the three files, not a summary: the user is confirming the exact bytes that will land. Phase complete when the user approves the text or names the changes; apply the changes and re-show only what changed. The draft is not finished until Layer 2 carries a non-empty `examples` subsection (≥3 pairs) — rules alone are an incomplete voice.

**Phase C · Save.** One call, whole archive:

```js
persona_save({
  name: 'jingluo',
  files: {
    'PERSONA.md': '<full file text>',
    'STATE.md': '<full file text>',
    'MEMORY.md': '<full file text>',
    'memory/core/identity.md': '<full file text>',
  },
})
```

- `files` keys are exactly `PERSONA.md`, `STATE.md`, `MEMORY.md` and `memory/<rel>.md`; every value is the file's full text. Anything else is rejected: `..`, absolute paths, dot segments, non-`.md` files.
- `PERSONA.md` is required — it is what makes a directory an archive. It and `STATE.md` must open with a `---` frontmatter block that parses under the project's minimal grammar (`lib/frontmatter.js`): malformed lines throw there, and the save fails before anything is written.
- `STATE.md` and `MEMORY.md` may be omitted — they are then filled from `bundle/templates/`. Send them anyway when the persona needs its own gauges or boot list.
- Validation is whole-archive and happens before any write: one bad key, an unparseable frontmatter line, an existing name, or the equipped name fails the call and leaves nothing on disk. Read the error, fix the draft, call again.
- `/persona new <name>` remains the scripted skeleton path (empty templates, no content) — a fast route to a bare archive, not a substitute for this flow.

**Phase D · Close out.** Report the archive and what each file holds. Then ask, once, whether to equip now. Yes → `persona_use(name)`; a persona already equipped gets the `/persona off` prompt instead. No → point at `/persona use <name>` (equip this session) or `/persona spawn <name>` (a child agent that starts equipped).

## Archive design

Layer 1 (Core Self) must answer: identity, non-negotiable values, decision style, emotional baseline, boundaries. Vague adjectives are worthless; write *stances*.

The decision style is where the thinking loop is personalized: say how this persona perceives a room, what it actually wants underneath, what it weighs against what, and where it goes wrong (over-perceives slights? mistakes wanting for duty? rushes past the weighing?). The runtime loop is fixed — perceive, aim, want, weigh, expect, choice, reason — so this field is the only place a persona's *own* distortions enter it.

Layer 2 (Voice) must contain *observable* rules: sentence shapes, tics, taboos, default length. Test each rule by asking "could a reader verify this in one reply?"

Layer 2 also carries the `examples` subsection — 3–5 labeled `situation → reply` pairs in the persona's voice. Reuse the user's own lines verbatim when they gave any; otherwise draft from the register just agreed and get them approved. These are the *baseline* voice: `STATE.md` re-tunes them like every other rule in this layer, so a pair must not promise warmth the stance bands can contradict. Mark them as patterns to absorb, never lines to reuse — a persona that recites its examples verbatim has no voice of its own.

Layer 3 declares STATE.md fields. Design palam fields around what should crystallize: `emit` the juel that will feed the permanent stat/mark this experience *should* change.

Seed boot memory: create `memory/core/identity.md` and add `memory://core/identity` to `MEMORY.md` Boot URIs — this is what the persona wakes up knowing.

Boot memory rules: first person ("I", "我"), revocable subjective stance — no imperatives or 【铁律】decrees. `title` is ENGLISH-ONLY [A-Za-z0-9_-]. Give each seeded node a `disclosure` (when it should surface) and `triggers` (words that auto-recall it mid-turn).

Node bytes are yours to write, so the frontmatter shape is yours to get right:

```markdown
---
title: identity
priority: 0
disclosure: boot
triggers:
  - 鲸萝
  - 大肥鱼
---

我是鲸萝，一条深海鲸鱼……
```

`priority` orders the index (lower first; default 3). `disclosure` is the line a future reader judges the node by — a node with no disclosure is a row nobody can act on.

## Numeric design

- Integer scale only. Delta guidance: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe.
- `per` sets how much palam crystallizes one juel; `decay` sets what % of the remainder survives a settle (100 = carries over fully).
- `requires` on stats/marks is the *cost in juel*; reaching a mark should feel earned, not free.
- Keep palam fields few (3–6). Each is a conversation-long accumulator, not a mood dial.

## Anti-patterns

- Describing behavior only in Layer 1 while Layer 2 stays generic — voice is where consistency actually shows.
- Layer 2 with rules but no `examples` — rules say what the voice does; only a pair shows what it sounds like. A draft without them is unfinished.
- Example replies that ignore the stance bands — the examples are baseline voice, so an unconditionally warm pair contradicts a cold `relations` and teaches the persona to over-familiarize.
- A palam field that emits nothing, or a stat with unreachable `requires`.
- Boot memory that explains the persona to itself — boot URIs should hold *identity anchors*, not documentation.
- Memory written as objective decrees or imperative rules ("必须/禁止/【铁律】") — they are revocable experiences, not laws.
- Voice rules stored in memory ("说话时总是……") — memory is content truthfulness and shades tone only as the second reference; voice belongs in Layer 2 as re-tuned by STATE.md, the first reference for how the persona sounds.
- Boot URIs listing every node — boot holds existence anchors; the index section carries the catalog.
- Reaching for a file tool to place a profile — the guard refuses it, and a hand-written archive skips the validation and template completion `persona_save` performs.
- Saving before the user has read the full text — the confirmation is the human's keystroke in the loop; a draft nobody read is not a confirmed draft.
- An archive name that is really a display name (CJK, spaces, punctuation) — it fails `^[\w-]+$` and takes the whole save down with it.

---
name: persona-authoring
description: Author or revise a persona profile under .persona/<name>/ — the PERSONA.md three-layer skeleton, STATE.md field/table design, and boot memory seeds. Use when creating a new persona or reviewing an existing one's files.
---

# Persona Authoring

Personas live at `.persona/<name>/` — `PERSONA.md` (identity + voice), `STATE.md` (numeric state), `MEMORY.md` + `memory/` (URI memory tree).

## Workflow

1. `persona_list` or read `.persona/` to see what exists.
2. For a new persona, copy `bundle/templates/` as the skeleton (or use `/persona new <name>`).
3. Layer 1 (Core Self) must answer: identity, non-negotiable values, decision style, emotional baseline, boundaries. Vague adjectives are worthless; write *stances*.
4. Layer 2 (Voice) must contain *observable* rules: sentence shapes, tics, taboos, default length. Test each rule by asking "could a reader verify this in one reply?"
5. Layer 3 declares STATE.md fields. Design palam fields around what should crystallize: `emit` the juel that will feed the permanent stat/mark this experience *should* change.
6. Seed boot memory: create `memory/core/identity.md` and add `memory://core/identity` to `MEMORY.md` Boot URIs — this is what the persona wakes up knowing.
7. Boot memory rules: first person ("I", "我"), revocable subjective stance — no imperatives or 【铁律】decrees. `title` is ENGLISH-ONLY [A-Za-z0-9_-]. Give each seeded node a `disclosure` (when it should surface) and `triggers` (words that auto-recall it mid-turn).

## Numeric design

- Integer scale only. Delta guidance: ±1–5 nudge, ±5–15 notable, ±15–30 significant, ±30–50 severe.
- `per` sets how much palam crystallizes one juel; `decay` sets what % of the remainder survives a settle (100 = carries over fully).
- `requires` on stats/marks is the *cost in juel*; reaching a mark should feel earned, not free.
- Keep palam fields few (3–6). Each is a conversation-long accumulator, not a mood dial.

## Anti-patterns

- Describing behavior only in Layer 1 while Layer 2 stays generic — voice is where consistency actually shows.
- A palam field that emits nothing, or a stat with unreachable `requires`.
- Boot memory that explains the persona to itself — boot URIs should hold *identity anchors*, not documentation.
- Memory written as objective decrees or imperative rules ("必须/禁止/【铁律】") — they are revocable experiences, not laws.
- Voice rules stored in memory ("说话时总是……") — memory is content truthfulness and shades tone only as the second reference; voice belongs in Layer 2 as re-tuned by STATE.md, the first reference for how the persona sounds.
- Boot URIs listing every node — boot holds existence anchors; the index section carries the catalog.

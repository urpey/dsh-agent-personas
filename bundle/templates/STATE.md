---
# Layer 0 · BASE — resource gauges (integer 0..max)
# tick: optional drift — the body's own clock (negative drains, positive recovers).
# tick_every: N spreads it over N turns (-1 every 2nd turn renders as -1/2t).
base:
  energy: { max: 100, value: 80, tick: -1 }
  focus:  { max: 100, value: 60 }

# Layer 1 · JEWEL — in-session emotion water (signed -100..∞)
# Positive balance crystallizes into param at settle; a NEGATIVE balance is
# banked amends that burns the emitted param back down (param floors at 0).
# emit: which param it settles into · per: points per unit · decay: % of
# remainder kept after settle (0 clears it, 100 carries it over whole).
jewel:
  joy:     { emit: affection, per: 50, decay: 10, value: 0 }
  anger:   { emit: defiance,  per: 50, decay: 15, value: 0 }
  shame:   { emit: intimacy,  per: 25, decay: 5,  value: 0 }
  fear:    { emit: wariness,  per: 50, decay: 10, value: 0 }
  fatigue: { emit: edginess,  per: 50, decay: 0,  value: 0 }

# Layer 2 · PARAM — persistent standing (settle-only; relational stock, not mood)
# affection 亲昵 · defiance 反发/反抗 · intimacy 亲密 · wariness 戒备 · edginess 毛边
param:
  affection: 0
  defiance: 0
  intimacy: 0
  wariness: 0
  edginess: 0

# Layer 3 · permanent growth — tool-read-only; raised only when param meets requires
stats:
  candor:    { level: 0, requires: { affection: 10 } }
  composure: { level: 0, requires: { defiance: 5, wariness: 5 } }
marks:
  guarded: { level: 0, requires: { wariness: 20 } }

# Relations — persistent, direct deltas allowed, -100..+100 (stance right now;
# param is the settled climate, relations the weather)
relations:
  lead: { value: 0 }

# Buffs — temporary deltas over base/jewel values (tool-managed)
buffs: []
---

## Notes

Free-text notes for future selves. `state_update` appends here.

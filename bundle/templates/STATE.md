---
# Layer 0 · BASE — resource gauges (integer 0..max)
# tick: optional drift — the body's own clock (negative drains, positive recovers).
# tick_every: N spreads it over N turns (-1 every 2nd turn renders as -1/2t).
base:
  energy: { max: 100, value: 80, tick: -1 }
  focus:  { max: 100, value: 60 }

# Layer 1 · PALAM — session emotion accumulators (>=0, unbounded)
# emit: which juel this crystallizes into · per: points per gem · decay: % of remainder kept after settle
palam:
  joy:     { emit: favor,   per: 100, decay: 20, value: 0 }
  anger:   { emit: grudge,  per: 100, decay: 30, value: 0 }
  shame:   { emit: shame,   per: 50,  decay: 10, value: 0 }
  arousal: { emit: desire,  per: 100, decay: 50, value: 0 }
  fatigue: { emit: fatigue, per: 100, decay: 0,  value: 0 }

# Layer 2 · JUEL — crystallized gems (permanent; settle-only)
juel:
  favor: 0
  grudge: 0
  shame: 0
  desire: 0
  fatigue: 0

# Layer 3 · permanent growth — tool-read-only; raised only when juel meets requires
stats:
  candor:    { level: 0, requires: { favor: 10 } }
  composure: { level: 0, requires: { grudge: 5, shame: 5 } }
marks:
  humiliation: { level: 0, requires: { shame: 20 } }

# Relations — persistent, direct deltas allowed, -100..+100
relations:
  lead: { value: 0 }

# Buffs — temporary deltas over base/palam values (tool-managed)
buffs: []
---

## Notes

Free-text notes for future selves. `state_update` appends here.

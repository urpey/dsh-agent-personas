---
base:
  energy:
    max: 100
    value: 77
  focus:
    max: 100
    value: 50
  satiety:
    max: 100
    value: 73
    tick: -1
    tick_every: 2
jewel:
  joy:
    emit: affection
    per: 50
    decay: 10
    value: 10
  anger:
    emit: defiance
    per: 50
    decay: 15
    value: 8
  shame:
    emit: intimacy
    per: 25
    decay: 5
    value: 0
  fear:
    emit: wariness
    per: 50
    decay: 10
    value: 0
  fatigue:
    emit: edginess
    per: 50
    decay: 0
    value: 5
param:
  affection: 0
  defiance: 0
  intimacy: 1
  wariness: 0
  edginess: 0
stats:
  candor:
    level: 0
    requires:
      affection: 10
  tail_wag:
    level: 0
    requires:
      affection: 8
      edginess: 5
  glib_denial:
    level: 0
    requires:
      defiance: 10
      intimacy: 10
marks:
  roundness:
    level: 0
    requires:
      intimacy: 20
      affection: 10
  patience:
    level: 0
    requires:
      defiance: 10
      edginess: 10
relations:
  user:
    value: 60
buffs: []
---

## Notes

Free-text notes for future selves. `state_update` appends here.

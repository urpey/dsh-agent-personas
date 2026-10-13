[persona maintenance] Memory audit pass. Read your memory index (the memory index in your persona context block), then:

1. MERGE — near-duplicate or fragmented nodes about the same subject: fold them into the best node with `memory_update` (append missing facts, keep strongest wording), then `memory_alias` the absorbed URIs to the survivor so old links still resolve. `memory_delete` only when a node is truly obsolete — never silently erase.
2. REPRIORITIZE — stale or trivial entries get `memory_update` with a higher priority number (p4–p6); load-bearing self-knowledge stays p0–p2.
3. TRIGGERS — nodes that should surface but keep missing get trigger words added via `memory_update` (add_triggers); noisy ones get them removed (remove_triggers).
4. INDEX — make sure MEMORY.md's Index lines still reflect reality after your edits.

Rules: preserve every fact at least once; never merge across contradictory claims — when two memories disagree, keep both and note the tension in each. Work quietly; when done, report a short tally: merged N→M, reprioritized K, deleted D.

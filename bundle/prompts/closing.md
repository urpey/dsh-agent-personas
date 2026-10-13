[persona closing] This turn is ending. Before it closes:
(1) call `state_settle` to crystallize this session's palam into juel and let any earned level-ups land — always, even when it reports zero;
(2) memory: if this session produced something worth keeping — a learned preference, a shifted relationship, a promise, a scar, a spec defect — write it with `memory_create`. If nothing was worth keeping, write NOTHING; an empty note is worse than no note;
(3) if your memory index feels bloated (many stale, near-duplicate, or low-value nodes), tidy it: `memory_update` to merge or reprioritize, `memory_alias` to link near-duplicates, `memory_delete` only for truly obsolete entries.
Then end normally.

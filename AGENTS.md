# dsh-agent-personas

A DeepSeek Harness plugin bundle that gives agents a persistent persona: a three-layer persona profile (`PERSONA.md`), a layered integer state system (`STATE.md`), and a URI-addressed memory tree (`memory/`) — all stored as local markdown under `.persona/<name>/`.

## Agent skills

### Issue tracker

Issues and specs are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to same-named label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Persona library

Persona profiles, state files and memory trees live under `.persona/<name>/`. See `docs/agents/agent-personas.md` for the file formats, the numeric system (BASE/PALAM/JUEL/ABL-MARK/REL), and the write-channel rules enforced by the plugin's tool guard.

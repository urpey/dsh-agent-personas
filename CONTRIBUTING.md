# Contributing

Thanks for your interest! This is a small personal project — issues and pull
requests are welcome.

## Reporting issues

- Reproduce against the latest `main` and a current DeepSeek Harness runtime
  (`dsh --version`; the bundle declares `@deepseek-ai/dsh >= 0.2.0-rc.1` as a
  peer).
- Include the persona archive shape (an anonymized `PERSONA.md`/`STATE.md`
  frontmatter block is enough — never post private memory nodes), the
  `/persona` command or tool call involved, and any `.persona/.routes/` verdict
  line that looks wrong.

## Development

```sh
cd bundle
node --test tests/*.test.js   # the whole suite — zero deps, node built-in runner
node --check lib/<file>.js    # syntax check a single file you touched
```

Conventions that matter here:

- **Pure JS, zero dependencies, zero build.** Git installs fetch sources, so
  whatever you commit is what runs. No TypeScript, no bundler, no deps.
- **`lib/` holds pure logic; `index.js`/`client.js` are thin shells.** If it
  can be tested without Cordis, it lives in `lib/` and gets a `node:test` test.
- **Client code is browser-raw**: no imports/JSX — `React.createElement` only.
- **Every registered listener/tool returns its disposer.** Lifecycle is
  reversible; the unload path must leave nothing behind.
- **`persona_save` is the only write channel into `.persona/**`.** Don't add
  bypasses; the `tools/pre-execute` guard exists so an equipped agent cannot
  rewrite the persona it is currently running as.
- Patch rows in `cordis.patch.yml` carry unique `id`s; a user-side override
  restates the whole `config` — keep defaults people want to keep.

Docs: the persona file-format contract is [docs/persona-format.md](docs/persona-format.md);
agent-facing workflow conventions are [AGENTS.md](AGENTS.md) + `docs/agents/`.

## Pull requests

Small, focused PRs. If a change alters the per-turn pipeline, the state model,
or the memory URI grammar, update `docs/persona-format.md` and `AGENTS.md` in
the same commit — they are the contract, not an afterthought.

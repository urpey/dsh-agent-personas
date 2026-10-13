/**
 * dsh-agent-personas — browser half of the persona bundle.
 *
 * The `/` menu's command rows are rendered by `@deepseek-ai/dsh-client-ui-commands`.
 * A HOST command row (`/persona`, registered in `lib/commands.js`) can only carry
 * its registered name plus a static `description` — the localized label, the
 * description and the glyph exist only for the first-party commands that package
 * hard-codes by `definitionId`, and a client contribution may not reuse a host
 * command's name (candidate synthesis fails loud on a collision).
 *
 * So this half contributes a SECOND, client-owned row: `personas`, whose entire
 * face (中文名 / 描述 / 图标) and whose bare-invocation picker live here, while the
 * host `/persona` command keeps its arguments, its lifecycle logging and its
 * scripted use. Every mutating picker row runs the host command through the
 * session's own `command()` face, so there is exactly one implementation of each
 * operation — except `new`, whose persona name is free text no popup can
 * collect: it submits a kickoff message and lets the agent author the archive
 * through the `persona-authoring` skill.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-personas',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Persona glyph: a masked head with a spark, drawn at the shared 1px stroke. */
    function IconPersona(props) {
      const { size = 16, className } = props || {}
      return h('svg', {
        width: size, height: size, className,
        viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true, strokeWidth: 1,
      },
        h('circle', { cx: 6.75, cy: 5.25, r: 2.5, stroke: 'currentColor' }),
        h('path', {
          d: 'M2.25 13.25C2.25 10.7647 4.26472 8.75 6.75 8.75C9.23528 8.75 11.25 10.7647 11.25 13.25',
          stroke: 'currentColor',
        }),
        h('path', {
          d: 'M13 1.5C13 3.33333 13.9167 4.25 15.75 4.25C13.9167 4.25 13 5.16667 13 7C13 5.16667 12.0833 4.25 10.25 4.25C12.0833 4.25 13 3.33333 13 1.5Z',
          stroke: 'currentColor',
        }),
      )
    }

    /** Library directory relative to the Session workspace root (host `libraryDir`). */
    const LIBRARY = '.persona'
    /** Archive filename whose presence marks a directory as a persona. */
    const PROFILE_FILE = 'PERSONA.md'
    /** Line cap for the frontmatter read: `description` sits in the opening block. */
    const FRONTMATTER_LINES = 40

    /**
     * The picker's own action rows: localized copy plus the exact HOST command
     * line each runs. `list` and `status` are NOT here — the popup shows the
     * library and the bound persona directly, so a flow node would only repeat
     * what the panel already says. Every row here mutates real state, which
     * only the host command can do, so each one logs its own flow node.
     * `new` is the exception: its persona name is free text no popup shell can
     * collect, so instead of a doomed `/persona new` line the row carries a
     * `kickoff` message key — a pick hands the fixed authoring flow to the
     * agent in this very session (see `submitKickoff`).
     */
    const ACTION_ROWS = [
      { id: 'action:off', label: 'label.off', detail: 'detail.off', line: '/persona off' },
      { id: 'action:new', label: 'label.new', detail: 'detail.new', kickoff: 'prompt.new' },
    ]

    /** Dictionary namespace owned by this bundle's browser half. */
    const NS = 'persona'

    const zh = {
      'command.label': '人格',
      'command.description': '管理持久人格：列表、装备、卸下、新建、派生、压缩',
      'group.library': '人格库',
      'group.actions': '操作',
      'label.status': '查看当前状态',
      'label.new': '新建人格档案…',
      'label.off': '卸下当前人格',
      'label.spawnFor': '派生「{name}」',
      'label.compactFor': '压缩「{name}」的记忆',
      'detail.new': '由 agent 引导创建：提供要求或粘贴人设资料',
      'detail.off': '撤销本会话的装备与工具注册',
      'detail.spawnFor': '以该人格派生一个子智能体',
      'detail.compactFor': '整理该人格的记忆树',
      'detail.equipped': '已装备',
      'detail.statusBound': '已装备「{name}」 · 库内 {count} 个人格',
      'detail.statusNone': '本会话未装备人格 · 库内 {count} 个人格',
      'detail.noDescription': '（无描述）',
      'search.placeholder': '搜索人格…',
      'search.empty': '本工作区还没有人格——选「新建人格档案…」，由 agent 引导创建一个',
      'search.noResults': '没有匹配的人格',
      'error.notRetained': '本会话尚未保留，无法执行人格指令',
      'error.unknownCommand': '未识别的命令：{line}',
      'prompt.new': '新建人格。请加载 persona-authoring 技能，按其固定流程引导我：我没有资料就从访谈开始，我贴资料就直接生成草稿，经我确认后用 persona_save 落盘，最后询问是否装备。',
    }

    const en = {
      'command.label': 'Persona',
      'command.description': 'Manage persistent personas: list, equip, unequip, create, spawn, compact',
      'group.library': 'Persona library',
      'group.actions': 'Actions',
      'label.status': 'Show current status',
      'label.new': 'Create a persona archive…',
      'label.off': 'Unequip the current persona',
      'label.spawnFor': 'Spawn "{name}"',
      'label.compactFor': 'Compact "{name}" memory',
      'detail.new': 'Agent-guided: describe what you want or paste persona material',
      'detail.off': 'Drop this session\'s equipping and tool registrations',
      'detail.spawnFor': 'Spawn a subagent running as that persona',
      'detail.compactFor': 'Tidy that persona\'s memory tree',
      'detail.equipped': 'equipped',
      'detail.statusBound': 'equipped "{name}" · {count} in library',
      'detail.statusNone': 'nothing equipped · {count} in library',
      'detail.noDescription': '(no description)',
      'search.placeholder': 'Search personas…',
      'search.empty': 'No personas in this workspace yet — pick "Create a persona archive…" and the agent authors one with you',
      'search.noResults': 'No matching persona',
      'error.notRetained': 'This session is not retained; persona commands cannot run yet',
      'error.unknownCommand': 'Unrecognized command: {line}',
      'prompt.new': 'Create a persona. Load the persona-authoring skill and guide me through its fixed flow: start with the interview when I have no material, draft straight from what I paste when I do, save with persona_save once I confirm, and ask about equipping at the end.',
    }

    /** Identity translate: the plugin still loads when no locale service exists. */
    const identity = (key) => key

    /** First `description:` scalar of a markdown frontmatter block, unquoted. */
    function frontmatterDescription(text) {
      const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? '')
      if (block === null) return ''
      for (const rawLine of block[1].split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/u, '').trim()
        if (!line.startsWith('description:')) continue
        const value = line.slice('description:'.length).trim()
        if (value.length >= 2
          && ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith('\'') && value.endsWith('\'')))) {
          return value.slice(1, -1)
        }
        return value
      }
      return ''
    }

    /** The `name` field of one binding ledger entry, or undefined when absent. */
    function bindingName(text) {
      try {
        const parsed = JSON.parse(text ?? '')
        return typeof parsed?.name === 'string' ? parsed.name : undefined
      } catch {
        return undefined
      }
    }

    return {
      inject: ['commandUi'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, { zh, en }), 'agent-personas: dictionaries')
        }
        const t = locale === undefined ? identity : locale.bind(NS)

        // `remote.<namespace>` is a FLAT Cordis service key, not a property of a
        // `remote` service: `scope.get('remote')?.workspaceFiles` is resolved as
        // one lookup named `remote.workspaceFiles` and throws without this
        // inject. Declaring the dotted key parks the contribution until the
        // Host's workspace-files namespace is mounted.
        ctx.inject(['commandUi', 'sessions', 'remote.workspaceFiles'], (scope) => {
          const commandUi = scope.get('commandUi')
          const sessions = scope.get('sessions')
          const files = scope.get('remote.workspaceFiles')
          if (commandUi === undefined || sessions === undefined) return

          /** Run one host command line through the session's own command face. */
          const runHostLine = async (session, line) => {
            const binding = sessions.binding(session.sessionId)
            if (binding === undefined) throw new Error(t('error.notRetained'))
            const result = await binding.session.command(line)
            if (!result.ok) throw result.error
            if (!result.value.matched) throw new Error(t('error.unknownCommand', { line }))
          }

          /**
           * Hand the authoring flow to the agent as ONE normal queued user
           * message: it appears in the transcript, waits its turn behind a busy
           * session and can be cancelled like anything else the user sends. A
           * popup shell can only offer canned choices, so a message is the only
           * channel through which the row can hand over the free-text
           * requirements it cannot collect — the agent loads the
           * `persona-authoring` skill and runs its fixed interview → draft →
           * `persona_save` → equip-ask sequence in this very session.
           */
          const submitKickoff = async (session, key) => {
            const binding = sessions.binding(session.sessionId)
            if (binding === undefined) throw new Error(t('error.notRetained'))
            const result = await binding.session.prompt([{ type: 'text', text: t(key) }], 'queue')
            if (!result.ok) throw result.error
          }

          /**
           * The personas of THIS session's workspace, in the host library's own
           * semantics: a direct child of `<libraryDir>/` that is a directory and
           * holds `PERSONA.md`. `.bindings/` therefore never qualifies. A missing
           * library, an unreadable archive or an unparseable ledger degrades to
           * an empty field instead of failing the whole popup.
           */
          const listLibrary = async (session, signal) => {
            if (files === undefined) return { personas: [], bound: undefined }
            const listing = await files.list(session.sessionId, LIBRARY, signal)
            if (!listing.ok) return { personas: [], bound: undefined }
            const rows = []
            for (const entry of listing.value.entries) {
              // Dot entries are library infrastructure (`.bindings/`, `.routes/`),
              // never archives — skip them before spending a read on each.
              if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
              // The host command splits its arguments on whitespace, so a name
              // holding any cannot round-trip through `/persona use <name>`.
              if (/\s/u.test(entry.name)) continue
              const archive = `${LIBRARY}/${entry.name}`
              const profile = await files.read(
                session.sessionId,
                `${archive}/${PROFILE_FILE}`,
                { offset: 1, limit: FRONTMATTER_LINES },
                signal,
              )
              if (!profile.ok) continue
              rows.push({
                name: entry.name,
                description: frontmatterDescription(profile.value.text),
              })
            }
            const ledger = await files.read(
              session.sessionId,
              `${LIBRARY}/.bindings/${session.sessionId}.json`,
              { offset: 1, limit: 1 },
              signal,
            )
            return { personas: rows, bound: ledger.ok ? bindingName(ledger.value.text) : undefined }
          }

          scope.effect(() => commandUi.register({
            name: 'personas',
            label: () => t('command.label'),
            description: () => t('command.description'),
            icon: IconPersona,
            available: session => sessions.binding(session.sessionId) !== undefined,
            ui: {
              kind: 'popupSelect',
              searchLabels: () => ({
                placeholder: t('search.placeholder'),
                // `empty` is unreachable in this popup: the shell shows it only
                // when the UNFILTERED option list is empty, and the action rows
                // below are always present. It stays a required interface field,
                // so keep it accurate — but never treat it as the empty-state UX.
                // The 「新建人格档案…」 row IS the empty-state affordance.
                empty: t('search.empty'),
                noResults: t('search.noResults'),
              }),
              options: async (session, signal) => {
                const library = t('group.library')
                const actions = t('group.actions')
                const { personas, bound } = await listLibrary(session, signal)
                const sorted = personas
                  .slice()
                  .sort((left, right) => left.name.localeCompare(right.name))
                // `list` and `status` are views here, not commands: the panel
                // already carries every archive and the bound one, so running
                // the host subcommand would only add a redundant flow node.
                const libraryRows = sorted.map(persona => ({
                  id: `use:${persona.name}`,
                  label: persona.name,
                  detail: persona.description === '' ? t('detail.noDescription') : persona.description,
                  group: { name: 'library', label: library },
                  ...(persona.name === bound ? { active: true, badge: t('detail.equipped') } : {}),
                }))
                // Per-persona mutations that take only a name are answerable
                // from the row itself, so the argument never has to be typed.
                const perPersona = sorted.flatMap(persona => ([
                  {
                    id: `spawn:${persona.name}`,
                    label: t('label.spawnFor', { name: persona.name }),
                    detail: t('detail.spawnFor'),
                    group: { name: 'actions', label: actions },
                  },
                  {
                    id: `compact:${persona.name}`,
                    label: t('label.compactFor', { name: persona.name }),
                    detail: t('detail.compactFor'),
                    group: { name: 'actions', label: actions },
                  },
                ]))
                return [
                  ...libraryRows,
                  {
                    id: 'action:status',
                    label: t('label.status'),
                    detail: bound === undefined
                      ? t('detail.statusNone', { count: sorted.length })
                      : t('detail.statusBound', { name: bound, count: sorted.length }),
                    group: { name: 'actions', label: actions },
                  },
                  ...perPersona,
                  ...ACTION_ROWS.map(row => ({
                    id: row.id,
                    label: t(row.label),
                    detail: t(row.detail),
                    group: { name: 'actions', label: actions },
                  })),
                ]
              },
              onSelect: async (option, session) => {
                // View rows (`action:status`) only report what the panel
                // already shows; picking one is a no-op, never a command.
                if (option.id === 'action:status') return
                const split = (prefix) => option.id.startsWith(prefix)
                  ? option.id.slice(prefix.length)
                  : undefined
                const use = split('use:')
                if (use !== undefined) {
                  await runHostLine(session, `/persona use ${use}`)
                  return
                }
                const spawn = split('spawn:')
                if (spawn !== undefined) {
                  await runHostLine(session, `/persona spawn ${spawn}`)
                  return
                }
                const compact = split('compact:')
                if (compact !== undefined) {
                  await runHostLine(session, `/persona compact ${compact}`)
                  return
                }
                const row = ACTION_ROWS.find(candidate => candidate.id === option.id)
                if (row === undefined) throw new Error(t('search.noResults'))
                // The kickoff row hands the free-text flow to the agent rather
                // than running a command whose argument nobody collected.
                if (row.kickoff !== undefined) {
                  await submitKickoff(session, row.kickoff)
                  return
                }
                await runHostLine(session, row.line)
              },
            },
          }), 'agent-personas: /personas contribution')
        })
      },
    }
  },
})

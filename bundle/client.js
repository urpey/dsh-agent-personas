/**
 * dsh-agent-personas — browser half of the persona bundle.
 *
 * The `/` menu's command rows are rendered by `@deepseek-ai/dsh-client-ui-commands`,
 * and neither that package nor the Host command registry can hide a registered
 * command: every registration becomes a row. So the bundle ships ONE row — this
 * client-owned `personas` contribution, whose face (中文名 / 描述 / 图标) and whose
 * bare-invocation picker live here — and leaves the Host `/persona` command
 * unregistered by default (`slashCommand: false`), which is the only way to keep
 * it off the menu.
 *
 * That makes this half the only human entry point, so it cannot submit command
 * lines: `session.command()` resolves against the same registry and would report
 * an unknown command. It drives the Host through the `personaInternals` Remote
 * service instead (`connection.rpc.call` → `lib/remote.js`), which runs the very
 * same operation bodies the command would have run. Every outcome — success or
 * refusal — lands as a composer notice, the sanctioned channel for a command
 * result that carries no session event.
 *
 * `new` is the exception: its persona name is free text no popup can collect, so
 * the row submits a kickoff message and lets the agent author the archive
 * through the `persona-authoring` skill.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-personas',
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
     * The picker's own action rows: localized copy plus the `personaInternals`
     * endpoint each one calls. `list` and `status` are NOT here — the popup shows
     * the library and the bound persona directly, so a round trip would only
     * repeat what the panel already says. Every row here mutates real Host state,
     * and every mutation goes through the Remote channel (`callHost`), never
     * through a `/persona` line: that command is unregistered by default, so a
     * submitted line would come back unknown.
     *
     * `new` is the exception: its persona name is free text no popup shell can
     * collect, so instead of a doomed create call the row carries a `kickoff`
     * message key — a pick hands the fixed authoring flow to the agent in this
     * very session (see `submitKickoff`).
     */
    const ACTION_ROWS = [
      { id: 'action:off', label: 'label.off', detail: 'detail.off', method: 'off' },
      { id: 'action:new', label: 'label.new', detail: 'detail.new', kickoff: 'prompt.new' },
      { id: 'action:newExample', label: 'label.newExample', detail: 'detail.newExample', method: 'newFromExample', args: { example: 'deepseek' } },
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
      'label.newExample': '从范例创建「deepseek」',
      'label.off': '卸下当前人格',
      'label.spawnFor': '派生「{name}」',
      'label.compactFor': '压缩「{name}」的记忆',
      'detail.new': '由 agent 引导创建：提供要求或粘贴人设资料',
      'detail.newExample': '复制内置的鲸鱼少女人格示例（含记忆树）',
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
      'error.hostReply': '人格操作返回了无法识别的结果',
      'prompt.new': '新建人格。请加载 persona-authoring 技能，按其固定流程引导我：我没有资料就从访谈开始，我贴资料就直接生成草稿，经我确认后用 persona_save 落盘，最后询问是否装备。',
    }

    const en = {
      'command.label': 'Persona',
      'command.description': 'Manage persistent personas: list, equip, unequip, create, spawn, compact',
      'group.library': 'Persona library',
      'group.actions': 'Actions',
      'label.status': 'Show current status',
      'label.new': 'Create a persona archive…',
      'label.newExample': 'Create the "deepseek" example',
      'label.off': 'Unequip the current persona',
      'label.spawnFor': 'Spawn "{name}"',
      'label.compactFor': 'Compact "{name}" memory',
      'detail.new': 'Agent-guided: describe what you want or paste persona material',
      'detail.newExample': 'Copy the bundled whale-girl example persona (memory tree included)',
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
      'error.hostReply': 'The persona operation returned an unrecognized result',
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
        ctx.inject(['commandUi', 'sessions', 'connection', 'remote.workspaceFiles'], (scope) => {
          const commandUi = scope.get('commandUi')
          const sessions = scope.get('sessions')
          const connection = scope.get('connection')
          const files = scope.get('remote.workspaceFiles')
          if (commandUi === undefined || sessions === undefined || connection === undefined) return

          /**
           * Report one landed operation to the composer.
           *
           * A Remote call produces no session event, so the `command/run` /
           * `command/done` flow node that used to carry a picker result no longer
           * exists; `notify` is the surface the client reserves for exactly this
           * case ("detached command results"). It is best-effort on purpose: the
           * operation has ALREADY landed, so a missing notice surface must not be
           * reported as a failed operation.
           */
          const notify = (sessionId, level, text) => {
            if (typeof text !== 'string' || text === '') return
            try {
              const actx = sessions.scope(sessionId)
              const conversation = actx === undefined ? undefined : actx.get('conversation')
              if (conversation === undefined) {
                console.warn(`[agent-personas] no conversation surface for: ${text}`)
                return
              }
              conversation.input.for(actx).notify(level, text)
            } catch (error) {
              console.warn('[agent-personas] could not surface the operation result:', error)
            }
          }

          /**
           * Run one persona operation on the Host.
           *
           * These are Remote endpoints (`lib/remote.js`), NOT `/persona`
           * subcommands: the Host command registry has no hidden flag, so hiding
           * the menu row means not registering the command — and a row that
           * submitted a command line would then be answered "unknown command".
           * The Gateway resolves the method's `agent` parameter from the
           * `agentId` sent here, so the caller only needs the id it already has.
           *
           * A business refusal comes back as `{ ok: false, text }` and is thrown
           * so the popup shell renders it; a carrier failure is thrown as-is.
           */
          const callHost = async (session, method, args = {}) => {
            if (sessions.binding(session.sessionId) === undefined) throw new Error(t('error.notRetained'))
            const result = await connection.rpc.call(
              '/api',
              `personaInternals/${method}`,
              { args: { agentId: session.sessionId, ...args } },
            )
            if (!result.ok) throw new Error(result.error.message)
            const value = result.value
            if (value === undefined || value.ok !== true) {
              const text = value === undefined ? undefined : value.text
              throw new Error(typeof text === 'string' && text !== '' ? text : t('error.hostReply'))
            }
            return typeof value.text === 'string' ? value.text : ''
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
              // A name holding whitespace stays out of the library rows: the
              // `/persona` command splits its arguments on whitespace, so such a
              // name is not reachable from every surface. The picker itself sends
              // the name as a JSON argument and could carry it — this keeps the
              // two faces offering the same set.
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
                // `list` and `status` are views here, not operations: the panel
                // already carries every archive and the bound one, so a round
                // trip would only repeat what the row itself says.
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
                // already shows; picking one is a no-op, never a Host call.
                if (option.id === 'action:status') return
                const split = (prefix) => option.id.startsWith(prefix)
                  ? option.id.slice(prefix.length)
                  : undefined
                const use = split('use:')
                if (use !== undefined) {
                  notify(session.sessionId, 'info', await callHost(session, 'use', { name: use }))
                  return
                }
                const spawn = split('spawn:')
                if (spawn !== undefined) {
                  notify(session.sessionId, 'info', await callHost(session, 'spawn', { name: spawn }))
                  return
                }
                const compact = split('compact:')
                if (compact !== undefined) {
                  notify(session.sessionId, 'info', await callHost(session, 'compact', { name: compact }))
                  return
                }
                const row = ACTION_ROWS.find(candidate => candidate.id === option.id)
                if (row === undefined) throw new Error(t('search.noResults'))
                // The kickoff row hands the free-text flow to the agent rather
                // than running an operation whose argument nobody collected.
                if (row.kickoff !== undefined) {
                  await submitKickoff(session, row.kickoff)
                  return
                }
                notify(session.sessionId, 'info', await callHost(session, row.method, row.args))
              },
            },
          }), 'agent-personas: /personas contribution')
        })
      },
    }
  },
})

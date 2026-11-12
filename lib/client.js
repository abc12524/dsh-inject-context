/**
 * dsh-inject-context — browser half.
 *
 * Registers this bundle's settings card on the Plugins page. The card is the
 * master switch plus one switch per injected block — OpenViking memories, the
 * skill list, and user tips — so a deployment can silence a single block
 * without touching a profile patch or unmounting a plugin.
 *
 * Nothing here reaches the network, the filesystem, or OpenViking: the card
 * writes volatile fields and the host half reads them per step. OpenViking's
 * own connection settings (host, port, key, threshold, hit count) live on
 * `dsh-openviking`'s card, which owns that half of the pipeline.
 *
 * Why this is hand-written: `@deepseek-ai/dsh-settings` publishes `autoGenerate`
 * for clients that build pages straight from a plugin's schema, but no shipped
 * client does that yet — every settings page in the tree is its own package
 * registering into the Plugins page's slot. This half is the same shape as
 * `@deepseek-ai/dsh-client-ui-settings-web-search`, minus the build step: the
 * bundle is plain JavaScript behind the Client module loader's
 * `load({ id, factory })` envelope, and every dependency arrives through the
 * injected `require`.
 *
 * @module dsh-inject-context/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-inject-context',
  factory: (require) => {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const module = { exports: {} }
    const exports = module.exports

    // -----------------------------------------------------------------------
    // Identity
    // -----------------------------------------------------------------------

    /**
     * The profile entry id this page configures. It is also the key the bundle's
     * own page dispatches into `plugins.bundle.config`, so the card must name the
     * package exactly.
     */
    const NS = 'dsh-inject-context'

    /** Dictionary namespace owned by this plugin. */
    const LOCALE_NS = 'settings.injectContext'

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    /** English copy. */
    const en = {
      title: 'Context injection',
      description: 'Insert the skill list, recalled OpenViking memories, and user tips below the question.',
      enabled: 'Enable injection',
      enabledHint: 'When off, nothing is collected and no message is inserted.',
      blocks: 'Injected blocks',
      ov: 'OpenViking memories',
      ovHint: 'Recall memories for the question. Needs the dsh-openviking plugin and its connection settings.',
      ovProfile: 'Memory index',
      ovProfileHint: 'Insert the list of memory topics once per session, before the first recall.',
      skills: 'Skill list',
      skillsHint: 'Insert the available-skills list once per session. Turn off when the harness tool-skill plugin also publishes it.',
      tips: 'User tips',
      tipsHint: 'Insert the per-session tips block once per session.',
      tipsText: 'Tips text',
      tipsTextHint: 'Leave blank to use the user_tips environment variable (what an API gateway sets).',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
    }

    /** Simplified Chinese copy. */
    const zh = {
      title: '上下文注入',
      description: '在提问下方插入 skill 列表、OpenViking 检索到的记忆与 user tips。',
      enabled: '启用注入',
      enabledHint: '关闭后不采集、不插入任何内容。',
      blocks: '注入内容',
      ov: 'OpenViking 记忆',
      ovHint: '按提问召回相关记忆。需要 dsh-openviking 插件及其连接设置。',
      ovProfile: '记忆索引',
      ovProfileHint: '会话首次插入记忆主题索引，让模型知道有哪些主题可查。',
      skills: 'Skill 列表',
      skillsHint: '会话首次插入可用 skill 名单。若 harness 的 tool-skill 插件也在发名单，请关闭。',
      tips: '用户提示',
      tipsHint: '会话首次插入 user tips 区块。',
      tipsText: '提示内容',
      tipsTextHint: '留空则使用 user_tips 环境变量（API 网关通常这样传）。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
    }

    /**
     * The shared form frame's copy.
     * @param t - the page's locale reader.
     * @returns the labels the shared settings form renders.
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    // -----------------------------------------------------------------------
    // Field specs
    // -----------------------------------------------------------------------

    /**
     * A switch-shaped field.
     *
     * The shared form model has no boolean spec, but a spec is only a
     * `format`/`parse` pair over staged text — so this one carries `on`/`off` and
     * lets the control be a real `Switch`. The toggle then rides the same staged
     * save as every text field instead of writing on click.
     *
     * @param field - field name inside the namespace section.
     * @returns the field's conversion spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'on' : 'off'),
        parse: (text) => ({ kind: 'set', value: text === 'on' }),
      }
    }

    /** The switch fields, in the order the card renders them. */
    const SWITCHES = [
      ['enabled', 'enabled'],
      ['ovEnabled', 'ov'],
      ['ovProfile', 'ovProfile'],
      ['skillList', 'skills'],
      ['userTipsEnabled', 'tips'],
    ]

    // -----------------------------------------------------------------------
    // Card controller
    // -----------------------------------------------------------------------

    /**
     * The card's staged form over the `dsh-inject-context` settings namespace.
     *
     * Every control is a volatile Config field, so it arrives as a live
     * reference, survives a save fence, and applies from the next turn.
     */
    class CardController {
      /**
       * @param scope - the bound settings scope for the `dsh-inject-context` namespace.
       */
      constructor(scope) {
        this.scope = scope
        this.form = new P.SettingsFormModel(scope, [
          ...SWITCHES.map(([field]) => settingsBooleanField(field)),
          P.settingsTextField('userTips'),
        ])
        this.store = this.form.bind(() => this.projection())
      }

      /**
       * Build the snapshot the card reads.
       * @returns the shell state plus every control's state.
       */
      projection() {
        const snapshot = {
          ...this.form.shell(),
          tipsText: this.form.field('userTips'),
        }
        for (const [field, key] of SWITCHES) {
          const control = this.form.field(field)
          snapshot[key] = control.text === 'on'
          snapshot[`${key}Overridden`] = control.overridden
        }
        return snapshot
      }

      /**
       * Build the face the page's slot registration injects.
       * @returns the page's snapshot store and the form's actions.
       */
      inject() {
        return {
          hooks: { injectSettingsCard: this.store },
          ...this.form.actions(),
        }
      }

      /** Release configuration subscriptions. */
      dispose() {
        this.form.dispose()
      }
    }

    // -----------------------------------------------------------------------
    // Card component
    // -----------------------------------------------------------------------

    /**
     * Row around one switch.
     *
     * `Switch` renders the control and nothing else — its `label` is an
     * accessible name (`aria-label`), not text — so on its own every switch on
     * this card reads as an anonymous toggle. The visible name and its
     * one-line explanation are this row's job. Styles are inline because the
     * bundle is plain JavaScript behind the module loader: there is no build
     * step, so no CSS module to import.
     *
     * @param t - the page's locale reader.
     * @param spec - the switch's state, copy keys, and change handler.
     * @returns the labelled row.
     */
    function switchRow(t, { checked, label, hint, disabled, onChange }) {
      return jsxs('div', {
        className: 'dsh-inject-context-switch',
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', padding: '10px 0' },
        children: [
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' },
            children: [
              jsx('span', {
                style: { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' },
                children: t(label),
              }),
              jsx('span', {
                style: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
                children: t(hint),
              }),
            ],
          }),
          jsx(P.Switch, {
            checked,
            disabled,
            label: t(label),
            title: t(hint),
            onChange,
          }),
        ],
      })
    }

    /**
     * One sub-toggle row.
     * @param props - the card props plus the control's key, label, and hint.
     * @returns the switch row.
     */
    function blockSwitch(props, key, label, hint, disabled) {
      return switchRow(props.t, {
        checked: props.state[key],
        label,
        hint,
        disabled,
        onChange: (next) => {
          props.edit(fieldOf(key), next ? 'on' : 'off')
        },
      })
    }

    /**
     * The Config field behind a snapshot key.
     * @param key - the snapshot key.
     * @returns the field name.
     */
    function fieldOf(key) {
      for (const [field, snapshotKey] of SWITCHES) {
        if (snapshotKey === key) return field
      }
      return key
    }

    /**
     * Render the one-liner or the settings form, as the Plugins page asks.
     * @param props - the view asked for, locale reader, snapshot, and form actions.
     * @returns the one-liner, or the form.
     */
    function InjectSettingsCard(props) {
      const { t } = props
      const value = props.useInjectSettingsCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const view = { ...props, t, state: value }
      const disabled = !value.writable
      const section = (label) =>
        jsx('div', {
          className: 'dsh-inject-context-section',
          style: { margin: '14px 0 4px', fontSize: '12px', fontWeight: 600, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
          children: t(label),
        })
      return jsxs(P.SettingsForm, {
        labels: formLabels(t),
        state: value,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          switchRow(t, {
            checked: value.enabled,
            label: 'enabled',
            hint: 'enabledHint',
            disabled,
            onChange: (next) => {
              props.edit('enabled', next ? 'on' : 'off')
            },
          }),
          section('blocks'),
          blockSwitch(view, 'ov', 'ov', 'ovHint', disabled),
          blockSwitch(view, 'ovProfile', 'ovProfile', 'ovProfileHint', disabled),
          blockSwitch(view, 'skills', 'skills', 'skillsHint', disabled),
          blockSwitch(view, 'tips', 'tips', 'tipsHint', disabled),
          jsx(P.SettingsValueField, {
            id: 'inject-config-user-tips',
            label: t('tipsText'),
            hint: t('tipsTextHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...value.tipsText,
            onEdit: (text) => {
              props.edit('userTips', text)
            },
            onReset: () => {
              props.resetField('userTips')
            },
          }),
        ],
      })
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------

    /** Required client services. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the settings card while the Host serves this bundle's namespace.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh, en }),
        'dsh-inject-context: dictionaries',
      )
      const scope = ctx.configForms.get(NS)
      const card = new CardController(scope)
      ctx.effect(() => () => {
        card.dispose()
      }, 'dsh-inject-context: form subscription')
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: NS,
                  label: () => t('title'),
                  locale: LOCALE_NS,
                  inject: () => card.inject(),
                },
                InjectSettingsCard,
              ),
            ),
          ),
        'dsh-inject-context: settings page',
      )
    }

    exports.NS = LOCALE_NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

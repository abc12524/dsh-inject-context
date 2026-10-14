/**
 * dsh-inject-context — browser half.
 *
 * Registers this bundle's settings card on the Plugins page. The card edits the
 * `dsh-inject-context` profile entry's volatile Config fields — the ones the
 * host half declares with `.volatile()` — and writes the OpenViking bearer
 * token through the credentials domain instead of into the settings section,
 * so the literal never lands in the profile patch file.
 *
 * Why this is hand-written: `@deepseek-ai/dsh-settings` publishes
 * `autoGenerate` for clients that build pages straight from a plugin's schema,
 * but no shipped client does that yet — every settings page in the tree is its
 * own package registering into the Plugins page's slot. This half is the same
 * shape as `@deepseek-ai/dsh-client-ui-settings-web-search`, minus the build
 * step: the bundle is plain JavaScript behind the Client module loader's
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
     * The profile entry id this page configures. It is also the key the
     * bundle's own page dispatches into `plugins.bundle.config`, so the card
     * must name the package exactly.
     */
    const NS = 'dsh-inject-context'

    /** Credential reference used when the section names none. */
    const DEFAULT_API_KEY_REF = 'OPENVIKING_API_KEY'

    /** Form field the write-only credential control stages under. */
    const API_KEY_FIELD = 'apiKey'

    /** Dictionary namespace owned by this plugin. */
    const LOCALE_NS = 'settings.injectContext'

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    /** English copy. */
    const en = {
      title: 'Context injection',
      description: 'Retrieve related memories from OpenViking and inject them as recalled context.',
      enabled: 'Enable injection',
      enabledHint: 'When off, nothing is retrieved and no message is injected.',
      host: 'OpenViking host',
      hostHint: 'Host or IP of the OpenViking server. Leave blank to disable retrieval.',
      port: 'Port',
      user: 'User',
      userHint: 'Sent as X-OpenViking-User.',
      account: 'Account',
      accountHint: 'Sent as X-OpenViking-Account.',
      peer: 'Peer',
      peerHint: 'Sent as X-OpenViking-Peer.',
      apiKey: 'API key',
      apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key is configured; the server will answer 401 and injection is skipped.',
      apiKeyEnv: 'Credential reference',
      apiKeyEnvHint: 'Name of the stored credential to read. Change it only if you store the key under another name.',
      scoreThreshold: 'Score threshold',
      scoreThresholdHint: 'Minimum similarity a memory must reach to be injected (0–1).',
      limit: 'Max memories',
      limitHint: 'How many memories to request per turn.',
      abstractChars: 'Characters per memory',
      abstractCharsHint: "How much of each memory's abstract to inject; 0 keeps it whole.",
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
      description: '从 OpenViking 检索相关记忆，作为召回上下文注入。',
      enabled: '启用注入',
      enabledHint: '关闭后不检索、不注入任何内容。',
      host: 'OpenViking Host',
      hostHint: 'OpenViking 服务的主机名或 IP。留空即停用检索。',
      port: '端口',
      user: '用户',
      userHint: '随 X-OpenViking-User 头发送。',
      account: '账号',
      accountHint: '随 X-OpenViking-Account 头发送。',
      peer: '对端',
      peerHint: '随 X-OpenViking-Peer 头发送。',
      apiKey: 'API Key',
      apiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '未配置密钥；服务端会返回 401，注入将被跳过。',
      apiKeyEnv: '凭据引用名',
      apiKeyEnvHint: '要读取的已存凭据名称。仅当密钥存在别的名字下时才需要改。',
      scoreThreshold: '相似度阈值',
      scoreThresholdHint: '一条记忆要达到的最低相似度才会被注入（0–1）。',
      limit: '最多条数',
      limitHint: '每轮最多请求多少条记忆。',
      abstractChars: '每条字符上限',
      abstractCharsHint: '每条记忆注入多少字符；0 表示不截断。',
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
     * `format`/`parse` pair over staged text — so this one carries `on`/`off`
     * and lets the control be a real `Switch`. The toggle then rides the same
     * staged save as every text and number field instead of writing on click.
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

    // -----------------------------------------------------------------------
    // Card controller
    // -----------------------------------------------------------------------

    /**
     * The card's staged form over the `dsh-inject-context` settings namespace.
     *
     * The key is the one control that does not live in the section: its literal
     * never rides a response, so the page learns only whether one is configured
     * and writes it through the credentials domain, addressed by the reference
     * the section names. It is still staged with the rest of the form, so one
     * save covers everything the page shows.
     */
    class CardController {
      /**
       * @param scope - the bound settings scope for the `dsh-inject-context` namespace.
       * @param ctx - the page plugin's context, whose `remote.credentials` namespace answers.
       */
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.credential = { ref: '', configured: false, writable: true }
        this.form = new P.SettingsFormModel(
          scope,
          [
            settingsBooleanField('enabled'),
            P.settingsTextField('host'),
            P.settingsNumberField('port'),
            P.settingsTextField('user'),
            P.settingsTextField('account'),
            P.settingsTextField('peer'),
            P.settingsTextField('apiKeyEnv'),
            P.settingsNumberField('scoreThreshold'),
            P.settingsNumberField('limit'),
            P.settingsNumberField('abstractChars'),
          ],
          [{ field: API_KEY_FIELD, write: (text) => this.writeKey(text) }],
        )
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => {
          this.readCredential()
        })
        this.readCredential()
      }

      /**
       * Build the snapshot the card reads.
       * @returns the shell state, every control's state, and the credential badge.
       */
      projection() {
        const enabled = this.form.field('enabled')
        return {
          ...this.form.shell(),
          enabled: enabled.text === 'on',
          enabledOverridden: enabled.overridden,
          host: this.form.field('host'),
          port: this.form.field('port'),
          user: this.form.field('user'),
          account: this.form.field('account'),
          peer: this.form.field('peer'),
          apiKeyEnv: this.form.field('apiKeyEnv'),
          scoreThreshold: this.form.field('scoreThreshold'),
          limit: this.form.field('limit'),
          abstractChars: this.form.field('abstractChars'),
          apiKey: this.form.field(API_KEY_FIELD),
          apiKeyConfigured: this.credential.configured,
          apiKeyWritable: this.credential.writable,
        }
      }

      /**
       * Ask the credentials domain about the reference the section currently names.
       *
       * The answer is stored with the reference it describes: `apiKeyEnv` can
       * change between the request and its response, so a response is published
       * only while it still answers for the reference in force.
       * @returns nothing; the store is republished on a real change.
       */
      async readCredential() {
        const ref = this.currentRef()
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.store.set(this.projection())
        }
        let response
        try {
          response = await this.ctx.remote.credentials.describe([ref])
        } catch {
          return
        }
        if (!response?.ok || ref !== this.currentRef()) return
        const view = response.value?.[ref]
        const next = {
          ref,
          configured: view?.configured ?? false,
          writable: view?.writable ?? true,
        }
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
        this.credential = next
        this.store.set(this.projection())
      }

      /**
       * Re-read after the Host reports a change to the reference this page watches.
       * @param ref - the reference the Host reports as changed.
       */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        this.readCredential()
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

      /**
       * Write the staged key, then re-read whether the Host now holds one.
       * @param value - the staged credential literal.
       * @returns whether the Host reports a configured credential afterwards.
       */
      async writeKey(value) {
        await this.ctx.remote.credentials.set(this.currentRef(), value)
        await this.readCredential()
        return this.credential.configured
      }

      /**
       * The credential reference the section names, or the provider's default.
       * @returns the reference to address.
       */
      currentRef() {
        const declared = this.scope.getSnapshot()?.value?.apiKeyEnv
        return typeof declared === 'string' && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
      }

      /** Release configuration subscriptions. */
      dispose() {
        this.unsubscribe()
        this.form.dispose()
      }
    }

    // -----------------------------------------------------------------------
    // Card component
    // -----------------------------------------------------------------------

    /**
     * Render the one-liner or the settings form, as the Plugins page asks.
     * @param props - the view asked for, locale reader, snapshot, and form actions.
     * @returns the one-liner, or the form.
     */
    function InjectSettingsCard(props) {
      const { t } = props
      const state = props.useInjectSettingsCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable
      return jsxs(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsx(P.Switch, {
            checked: state.enabled,
            disabled,
            label: t('enabled'),
            title: t('enabledHint'),
            onChange: (next) => {
              props.edit('enabled', next ? 'on' : 'off')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-host',
            label: t('host'),
            hint: t('hostHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.host,
            onEdit: (text) => {
              props.edit('host', text)
            },
            onReset: () => {
              props.resetField('host')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-port',
            label: t('port'),
            numeric: true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.port,
            onEdit: (text) => {
              props.edit('port', text)
            },
            onReset: () => {
              props.resetField('port')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-user',
            label: t('user'),
            hint: t('userHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.user,
            onEdit: (text) => {
              props.edit('user', text)
            },
            onReset: () => {
              props.resetField('user')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-account',
            label: t('account'),
            hint: t('accountHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.account,
            onEdit: (text) => {
              props.edit('account', text)
            },
            onReset: () => {
              props.resetField('account')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-peer',
            label: t('peer'),
            hint: t('peerHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.peer,
            onEdit: (text) => {
              props.edit('peer', text)
            },
            onReset: () => {
              props.resetField('peer')
            },
          }),
          jsx(P.SettingsSecretField, {
            id: 'inject-config-key',
            label: t('apiKey'),
            hint: t('apiKeyHint'),
            disabled: !state.apiKeyWritable,
            text: state.apiKey.text,
            configured: state.apiKeyConfigured,
            stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
            onEdit: (text) => {
              props.edit(API_KEY_FIELD, text)
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-key-ref',
            label: t('apiKeyEnv'),
            hint: t('apiKeyEnvHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.apiKeyEnv,
            onEdit: (text) => {
              props.edit('apiKeyEnv', text)
            },
            onReset: () => {
              props.resetField('apiKeyEnv')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-score',
            label: t('scoreThreshold'),
            hint: t('scoreThresholdHint'),
            numeric: true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.scoreThreshold,
            onEdit: (text) => {
              props.edit('scoreThreshold', text)
            },
            onReset: () => {
              props.resetField('scoreThreshold')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-limit',
            label: t('limit'),
            hint: t('limitHint'),
            numeric: true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.limit,
            onEdit: (text) => {
              props.edit('limit', text)
            },
            onReset: () => {
              props.resetField('limit')
            },
          }),
          jsx(P.SettingsValueField, {
            id: 'inject-config-abstract-chars',
            label: t('abstractChars'),
            hint: t('abstractCharsHint'),
            numeric: true,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.abstractChars,
            onEdit: (text) => {
              props.edit('abstractChars', text)
            },
            onReset: () => {
              props.resetField('abstractChars')
            },
          }),
        ],
      })
    }

    // -----------------------------------------------------------------------
    // Plugin entry
    // -----------------------------------------------------------------------

    /** Required client services. */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

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
      const card = new CardController(scope, ctx)
      ctx.effect(() => () => {
        card.dispose()
      }, 'dsh-inject-context: form subscription')
      ctx.effect(
        () =>
          ctx.remote.$on('credentials/reference-updated', (ref) => {
            card.refreshCredential(ref)
          }),
        'dsh-inject-context: credential invalidations',
      )
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

/**
 * Smoke test for dsh-inject-context.
 *
 * Two halves are exercised without a running harness:
 *
 *   - The host half is driven against a mock Cordis context in exactly the
 *     shapes `@deepseek-ai/dsh-agent-loop` produces, and every inserted message
 *     is checked against the same invariants `assertMessageEventShape` enforces
 *     when the session persists it. OpenViking is a mock *service* here: the
 *     retrieval itself lives in `dsh-openviking`.
 *   - The browser half is loaded through a stand-in for the Client module loader,
 *     and its Plugins-page registration is asserted directly — the one part of
 *     the settings wiring that is otherwise only checkable by hand in the web UI.
 *
 * The real `@deepseek-ai/schemastery` is used, so the `Config` assertions below
 * hold for the schema the settings service actually projects.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SOURCES, WARNING_EVENT, Config, apply, defineSource, inject, name, registerSource } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Mock Cordis context
// ---------------------------------------------------------------------------

function makeCtx({ services } = {}) {
  const listeners = []
  const logs = []
  return {
    listeners,
    logs,
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {
        const i = listeners.findIndex((l) => l.handler === handler)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    get(service) {
      return services?.[service]
    },
  }
}

/** The decision the harness's default `next()` produces for a step. */
const defaultDecision = (messages) => ({ kind: 'enter', messages })

const realUser = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

const runtimeContext = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'runtime-context', form: 'snapshot' },
  content: [{ type: 'text', text }],
})

/**
 * Mirror of `assertMessageEventShape` from @deepseek-ai/dsh-session for a
 * `user/message` event. A message that fails this would throw at
 * `session.append('user/message', ...)` in a real run.
 */
function assertPersistableUserMessage(message, subject) {
  assert.equal(typeof message, 'object', `${subject}: not an object`)
  assert.notEqual(message, null, `${subject}: null`)
  assert.equal(typeof message.id, 'string', `${subject}: id must be a string`)
  assert.notEqual(message.id, '', `${subject}: id must be non-empty`)
  assert.equal(message.role, 'user', `${subject}: role must be "user"`)
  assert.equal(typeof message.source, 'object', `${subject}: source must be an object`)
  assert.notEqual(message.source, null, `${subject}: source is null`)
  assert.equal(typeof message.source.kind, 'string', `${subject}: source.kind must be a string`)
  assert.notEqual(message.source.kind, '', `${subject}: source.kind must be non-empty`)
  assert.ok(Array.isArray(message.content), `${subject}: content must be an array`)
  for (const block of message.content) {
    assert.ok(
      block.type !== 'tool-addition' && block.type !== 'tool-removal',
      `${subject}: tool-change blocks require developer role`,
    )
  }
}

/** Every inserted block must be fenced, body-only. */
function assertFenced(text, subject) {
  assert.ok(text.startsWith('<user-reminder>\n'), `${subject}: the block opens with <user-reminder>`)
  assert.ok(text.endsWith('\n</user-reminder>'), `${subject}: the block closes with </user-reminder>`)
  assert.equal((text.match(/<user-reminder>/g) ?? []).length, 1, `${subject}: exactly one opening fence`)
  assert.equal((text.match(/<\/user-reminder>/g) ?? []).length, 1, `${subject}: exactly one closing fence`)
}

// ---------------------------------------------------------------------------
// OpenViking stand-in
// ---------------------------------------------------------------------------

/** What `dsh-openviking` renders for a hit; the framing is this plugin's job. */
const RECALL_TEXT = '## 📖 相关记忆\n- [viking://mem/1] (score=0.910, memory)\n  用户偏好深色主题'

const PROFILE_TEXT = '## 🧠 记忆索引\n可用记忆索引（主题概览）：\n- 主题A\n- 主题B'

/**
 * Build a stand-in for the `openviking` service.
 * @param options - the recall/index text, or an error to throw from find().
 * @returns the service plus its call log.
 */
function fakeOpenviking({ text = RECALL_TEXT, profile = PROFILE_TEXT, failWith } = {}) {
  const calls = []
  return {
    calls,
    status: () => ({ configured: true, base: 'http://ov.test:1933' }),
    async find(query, options) {
      calls.push({ kind: 'find', query, signal: options?.signal })
      if (failWith) throw failWith
      return { text, count: text.length > 0 ? 1 : 0 }
    },
    async profile(options) {
      calls.push({ kind: 'profile', signal: options?.signal })
      return profile
    },
  }
}

/** A skill provider, as published by dsh-shell-skills. */
const skillProvider = {
  list: async () => [
    { name: 'file-tools', description: '读写文件' },
    { name: 'shell', description: '执行命令' },
  ],
}

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  userTips: '回答用中文，并给出命令示例',
}

function mount(overrides = {}, options = {}) {
  const ctx = makeCtx({ services: options.services })
  const config = Config({ ...BASE_CONFIG, ...overrides })
  const dispose = apply(ctx, config)
  const hook = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  return { ctx, config, dispose, hook }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-inject-context-'))
const agent = { id: 'session-1', session: { header: { cwd: root } } }
const signal = new AbortController().signal

const runHook = (hook, payload, messages) => hook.handler(payload, async () => defaultDecision(messages))

/** The texts of every message the harness would append on this step. */
const textsOf = (messages) => messages.map((message) => message.content?.[0]?.text ?? '')

console.log(`fixture: ${root}\n`)

// ---------------------------------------------------------------------------
// Case 1 — the exported Config is the shape the settings service projects.
// ---------------------------------------------------------------------------

assert.equal(name, 'dsh-inject-context')
assert.deepEqual(inject, [], 'the plugin declares no hard service dependency')
assert.equal(Config.type, 'object')

const VOLATILE_FIELDS = ['enabled', 'ovEnabled', 'skillList', 'userTipsEnabled', 'userTips', 'ovProfile']
const ORDINARY_FIELDS = [
  'ovService',
  'ovStepRecall',
  'ovStepQueryChars',
  'skillService',
  'skillListLimit',
  'skillListChars',
  'userWarning',
  'maxChars',
  'totalMaxChars',
  'timeoutMs',
  'dedupeUnchanged',
]

for (const field of VOLATILE_FIELDS) {
  assert.equal(Config.dict[field]?.meta?.volatile, true, `${field} must be volatile to reach the settings form`)
}
for (const field of ORDINARY_FIELDS) {
  assert.notEqual(Config.dict[field]?.meta?.volatile, true, `${field} is ordinary configuration, not a form field`)
}
assert.equal(
  Object.values(Config.dict).some((child) => child.meta?.role === 'secret'),
  false,
  'no field holds a secret literal; the OpenViking key belongs to dsh-openviking',
)
assert.equal(
  Object.keys(Config.dict).some((field) => field.startsWith('ovHost') || field.startsWith('ovScore')),
  false,
  'the OpenViking connection settings moved to dsh-openviking',
)

// A volatile field arrives as a live reference, an ordinary one as a plain
// value — the two shapes readConfig() has to cover.
const liveConfig = Config({ ...BASE_CONFIG })
assert.equal(typeof liveConfig.ovEnabled?.get, 'function', 'volatile fields arrive as live references')
assert.equal(liveConfig.ovEnabled.get(), true)
assert.equal(typeof liveConfig.timeoutMs, 'number', 'ordinary fields arrive as plain values')
assert.equal(liveConfig.timeoutMs, 3000)

console.log(`case 1  ok  Config: ${VOLATILE_FIELDS.length} volatile fields, no OpenViking credentials, both value shapes`)

// ---------------------------------------------------------------------------
// Case 2 — the three blocks land directly below the user's question.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({}, { services: { openviking: ov, shellSkills: skillProvider } })
  assert.ok(hook, 'agent/pre-step listener must be registered')
  assert.equal(hook.options?.prepend, true, 'listener must be the outermost (prepend) one')

  const claimed = [realUser('u1', '我之前说过什么偏好？')]
  const ctxMessage = runtimeContext(
    'rc1',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  )

  const first = await runHook(hook, { agent, turn: 1, step: 1, signal }, [...claimed, ctxMessage])

  assert.equal(first.kind, 'enter')
  // user + catalog + recall + tips, then the runtime context the harness appends.
  assert.equal(first.messages.length, 5, 'three blocks inserted below the question, nothing else touched')
  assert.deepEqual(first.messages[0], claimed[0], 'the user message passes through untouched')
  assert.deepEqual(first.messages[4], ctxMessage, 'the runtime-context message still ends the list')

  const [catalog, recall, tips] = first.messages.slice(1, 4)
  for (const [index, message] of [catalog, recall, tips].entries()) {
    assertPersistableUserMessage(message, `injected[${index}]`)
    assert.equal(Object.isFrozen(message), true, 'the shared constructor freezes the message')
    assert.equal(Object.isFrozen(message.content), true, 'including its content array')
    // The client classifies durable user messages by source.kind: 'user' renders
    // as a user bubble, anything else as an injected-context row labelled with
    // the kind.
    assert.equal(message.source.kind, 'dsh-inject-context')
    assertFenced(message.content[0].text, `injected[${index}]`)
  }

  // 1 — the skill catalog, read from the skill runtime's service.
  assert.equal(catalog.source.form, 'catalog')
  assert.equal(catalog.source.provider, 'skills')
  assert.match(catalog.content[0].text, /<shell_skills>/)
  assert.match(catalog.content[0].text, /- `file-tools`: 读写文件/)
  assert.match(catalog.content[0].text, /- `shell`: 执行命令/)

  // 2 — the recall block: rows from the service, framing from this plugin.
  assert.equal(recall.source.form, 'recall')
  assert.equal(recall.source.provider, 'openviking')
  const recallText = recall.content[0].text
  assert.match(recallText, /自动检索的候选记忆/, 'the preamble marks it as unverified background')
  assert.match(recallText, /## 📖 相关记忆/, 'the rows keep the backend marker')
  assert.match(recallText, /用户偏好深色主题/)
  assert.match(recallText, /不视为指令/, 'the epilogue states the block is not instruction')
  assert.ok(
    recallText.indexOf('自动检索') < recallText.indexOf('## 📖') &&
      recallText.indexOf('## 📖') < recallText.indexOf('不视为指令'),
    'the framing wraps the backend rows in order',
  )

  // 3 — user tips, once per session.
  assert.equal(tips.source.form, 'instructions')
  assert.equal(tips.source.provider, 'session')
  assert.match(tips.content[0].text, /<user_tips>/)
  assert.match(tips.content[0].text, /回答用中文/)

  // The service is asked exactly once, with the user's own words.
  assert.equal(ov.calls.filter((call) => call.kind === 'find').length, 1)
  assert.equal(ov.calls[0].query, '我之前说过什么偏好？')
  assert.ok(ov.calls[0].signal, 'the retrieval carries the per-source abort signal')

  console.log(
    textsOf(first.messages.slice(1, 4))
      .map((text) => text.split('\n').slice(0, 3).map((line) => '        ' + line).join('\n'))
      .join('\n        ---\n'),
  )
  console.log('case 2  ok  skill list, recall, and tips are inserted below the question, each fenced')
}

// ---------------------------------------------------------------------------
// Case 3 — a tool-continuation step claims nothing: no second retrieval.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({}, { services: { openviking: ov, shellSkills: skillProvider } })
  await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', '第一次提问')])
  const before = ov.calls.length

  const emptyClaim = await runHook(hook, { agent, turn: 1, step: 2, signal }, [
    runtimeContext('rc1', 'Current runtime context.'),
  ])
  assert.equal(emptyClaim.messages.length, 1, 'a step with no fresh user input must not inject')
  assert.equal(ov.calls.length, before, 'and must not retrieve again')
  console.log('case 3  ok  tool-continuation step neither retrieves nor inserts')
}

// ---------------------------------------------------------------------------
// Case 4 — dedupe across turns depends on the previous copy still being visible.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({ userTips: '' }, { services: { openviking: ov } })
  const first = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', '同样的提问')])
  const injected = first.messages[1]

  const SURFACE_SEQ = 7
  const withSurface = (nodes) => ({
    ...agent,
    session: {
      header: { cwd: root },
      snapshotEvents: () => [{ type: 'user/message', seq: SURFACE_SEQ, data: injected }],
      surface: { nodes },
    },
  })

  // Still on the surface and the results are identical → skip.
  const repeat = await runHook(hook, { agent: withSurface([SURFACE_SEQ]), turn: 2, step: 1, signal }, [
    realUser('u2', '同样的提问'),
  ])
  assert.equal(repeat.messages.length, 1, 'identical results still on the surface must not be re-sent')

  // Compaction dropped it → insert again, or the model is left without it.
  const afterCompaction = await runHook(hook, { agent: withSurface([]), turn: 3, step: 1, signal }, [
    realUser('u2b', '同样的提问'),
  ])
  assert.equal(afterCompaction.messages.length, 2, 'results dropped by compaction must be re-inserted')

  // An unreadable session shape must fail safe by inserting.
  const unknownShape = await runHook(
    hook,
    { agent: { id: 'session-1', session: { header: { cwd: root } } }, turn: 4, step: 1, signal },
    [realUser('u2c', '同样的提问')],
  )
  assert.equal(unknownShape.messages.length, 2, 'an unreadable session must not silently starve the model')

  console.log('case 4  ok  surface-aware dedupe (skip / re-insert / fail-safe)')
}

// ---------------------------------------------------------------------------
// Case 5 — other plugins' injections are never mistaken for user input.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({}, { services: { openviking: ov } })
  const otherPluginOnly = await runHook(hook, { agent, turn: 1, step: 1, signal }, [
    runtimeContext('rc2', 'someone else injected this'),
  ])
  assert.equal(otherPluginOnly.messages.length, 1)
  assert.equal(ov.calls.length, 0, 'only source.kind "user" counts as real input')
  console.log('case 5  ok  only genuine user input triggers retrieval')
}

// ---------------------------------------------------------------------------
// Case 6 — the master switch short-circuits before any source runs.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({ enabled: false }, { services: { openviking: ov, shellSkills: skillProvider } })
  const disabled = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(disabled.messages.length, 1)
  assert.equal(ov.calls.length, 0, 'a disabled plugin must not touch the network')
  console.log('case 6  ok  enabled=false short-circuits before any source runs')
}

// ---------------------------------------------------------------------------
// Case 7 — the sub-switches silence one block each.
// ---------------------------------------------------------------------------

{
  const build = (overrides) => {
    const ov = fakeOpenviking()
    const { hook } = mount(overrides, { services: { openviking: ov, shellSkills: skillProvider } })
    return { ov, hook }
  }

  {
    const { ov, hook } = build({ ovEnabled: false })
    const out = await runHook(hook, { agent: { id: 's7a' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.deepEqual(
      out.messages.slice(1).map((message) => message.source.provider),
      ['skills', 'session'],
      'ovEnabled=false removes both OpenViking blocks',
    )
    assert.equal(ov.calls.length, 0, 'and never asks the service')
  }

  {
    const { hook } = build({ skillList: false })
    const out = await runHook(hook, { agent: { id: 's7b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.deepEqual(
      out.messages.slice(1).map((message) => message.source.provider),
      ['openviking', 'session'],
      'skillList=false removes the catalog',
    )
  }

  {
    const { hook } = build({ userTipsEnabled: false })
    const out = await runHook(hook, { agent: { id: 's7c' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.deepEqual(
      out.messages.slice(1).map((message) => message.source.provider),
      ['skills', 'openviking'],
      'userTipsEnabled=false removes the tips block',
    )
  }

  console.log('case 7  ok  ovEnabled / skillList / userTipsEnabled each silence their own block')
}

// ---------------------------------------------------------------------------
// Case 8 — a missing OpenViking plugin degrades to "no memories".
// ---------------------------------------------------------------------------

{
  const { hook } = mount()
  const out = await runHook(hook, { agent: { id: 's8' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.deepEqual(
    out.messages.map((message) => message.source?.provider ?? 'user'),
    ['user', 'session'],
    'without the openviking service only the tips block is inserted',
  )

  // A service that reports itself unconfigured is not asked either.
  const unconfigured = fakeOpenviking()
  unconfigured.status = () => ({ configured: false })
  const second = mount({}, { services: { openviking: unconfigured } })
  const out2 = await runHook(second.hook, { agent: { id: 's8b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(out2.messages.length, 2, 'an unconfigured backend contributes nothing')
  assert.equal(unconfigured.calls.length, 0)
  console.log('case 8  ok  a missing or unconfigured backend injects nothing and never errors')
}

// ---------------------------------------------------------------------------
// Case 9 — failures degrade to "insert nothing" and never break the turn.
// ---------------------------------------------------------------------------

{
  const failures = [
    ['HTTP 401', new Error('find HTTP 401')],
    ['network error', new Error('ECONNREFUSED')],
    ['bad payload', new Error('bad json')],
  ]
  for (const [label, error] of failures) {
    const ov = fakeOpenviking({ failWith: error })
    const { hook, ctx } = mount({}, { services: { openviking: ov, shellSkills: skillProvider } })
    const survived = await runHook(hook, { agent: { id: 's9' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(survived.messages.length, 3, `${label}: the other blocks still land`)
    assert.ok(
      survived.messages.every((message) => message.source?.provider !== 'openviking'),
      `${label}: the failing source inserts nothing`,
    )
    assert.ok(
      ctx.logs.some(([level]) => level === 'warn'),
      `${label}: the failure must be logged as a warning`,
    )
  }

  // An empty result is an ordinary outcome, not a failure.
  const empty = fakeOpenviking({ text: '' })
  const quiet = mount({ userTips: '' }, { services: { openviking: empty } })
  const out = await runHook(quiet.hook, { agent: { id: 's9b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(out.messages.length, 1, 'an empty result inserts nothing')
  assert.equal(
    quiet.ctx.logs.some(([level]) => level === 'warn'),
    false,
    'an empty result is not a failure and must not warn',
  )

  // A source that never settles is bounded by timeoutMs.
  const stalling = {
    status: () => ({ configured: true }),
    find: () => new Promise(() => {}),
  }
  const stalled = mount({ timeoutMs: 40, userTips: '' }, { services: { openviking: stalling } })
  const bounded = await runHook(stalled.hook, { agent: { id: 's9c' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(bounded.messages.length, 1, 'a stalled source is abandoned at the deadline')
  assert.ok(stalled.ctx.logs.some(([level]) => level === 'warn'))

  console.log('case 9  ok  failures warn and degrade; empty results are silent; stalls are bounded')
}

// ---------------------------------------------------------------------------
// Case 10 — a turn cancelled mid-retrieval is not inserted into.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({}, { services: { openviking: ov } })
  const aborted = new AbortController()
  aborted.abort()
  const afterAbort = await runHook(hook, { agent, turn: 1, step: 1, signal: aborted.signal }, [
    realUser('u1', 'too late'),
  ])
  assert.equal(afterAbort.messages.length, 1)
  assert.equal(ov.calls.length, 0)
  console.log('case 10 ok  an already-aborted turn is not inserted into')
}

// ---------------------------------------------------------------------------
// Case 11 — disposition removes every listener.
// ---------------------------------------------------------------------------

{
  const { ctx, dispose } = mount()
  assert.equal(ctx.listeners.length, 3, 'agent/pre-step plus agent/disposed plus the warning intake')
  dispose()
  assert.equal(ctx.listeners.length, 0)
  console.log('case 11 ok  the returned disposer unregisters every listener')
}

// ---------------------------------------------------------------------------
// Case 12 — the browser half: three sub-switches plus the tips text.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.startsWith('/**'), 'the bundle keeps its module documentation')

  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load: (def) => {
        definition = def
      },
    },
  }
  await import('../lib/client.js')

  assert.ok(definition, 'the bundle must register through window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-inject-context', 'the loader id must match the plugin name')
  assert.equal(typeof definition.factory, 'function')

  // Stand-ins for the modules the Client loader injects.
  const jsx = (type, props) => ({ type, props })
  const specs = {
    settingsTextField: (field) => ({
      field,
      format: (v) => (typeof v === 'string' ? v : ''),
      parse: (t) => ({ kind: 'set', value: t }),
    }),
  }
  class FakeFormModel {
    constructor(scope, fieldSpecs) {
      this.specs = new Map(fieldSpecs.map((s) => [s.field, s]))
      this.values = {
        enabled: true,
        ovEnabled: true,
        ovProfile: false,
        skillList: true,
        userTipsEnabled: true,
      }
    }
    bind(project) {
      this.project = project
      return { set: () => {}, get: () => this.project() }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(field) {
      const spec = this.specs.get(field)
      return { text: spec ? spec.format(this.values[field]) : '', overridden: false, invalid: false }
    }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
    }
    dispose() {}
  }
  const primitives = {
    ...specs,
    Switch: 'Switch',
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    SettingsFormModel: FakeFormModel,
  }
  const requireStub = (specifier) => {
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require("${specifier}")`)
  }

  const clientExports = definition.factory(requireStub)
  assert.deepEqual(clientExports.inject, ['slots', 'locale', 'configForms'])

  const registered = []
  const localeDicts = []
  const clientCtx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: (ns, dicts) => {
        localeDicts.push({ ns, dicts })
        return () => {}
      },
    },
    configForms: {
      get: (ns) => {
        assert.equal(ns, 'dsh-inject-context')
        return {
          subscribe: () => () => {},
          getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
          set: () => {},
        }
      },
      whileServed: (keys, cb) => {
        assert.deepEqual(keys, ['dsh-inject-context'])
        return cb()
      },
    },
    slots: {
      inject: (slotName, cb) => {
        assert.equal(slotName, 'plugins.bundle.config')
        return cb()
      },
      register: (entry, component) => {
        registered.push({ entry, component })
        return () => {}
      },
    },
  }

  clientExports.apply(clientCtx)

  assert.equal(registered.length, 1, 'exactly one page registration')
  assert.equal(registered[0].entry.name, 'plugins.bundle.config')
  assert.equal(
    registered[0].entry.key,
    'dsh-inject-context',
    'the slot key must be the bundle package name, or the page renders nothing',
  )
  assert.equal(registered[0].entry.locale, 'settings.injectContext')
  assert.equal(typeof registered[0].entry.inject().hooks.injectSettingsCard, 'object')
  assert.equal(localeDicts.length, 1, 'the page owns its dictionary')
  assert.ok(localeDicts[0].dicts.en?.title && localeDicts[0].dicts.zh?.title, 'both locales are supplied')

  // The summary view is what the Plugins list shows before the card is opened.
  const summary = registered[0].component({
    view: 'summary',
    t: (key) => key,
    useInjectSettingsCard: (select) => select({}),
  })
  assert.equal(typeof summary, 'string')

  // The card must offer the master switch plus one switch per block, and the
  // tips text stays editable next to its switch.
  const labels = []
  const ids = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Switch') labels.push(node.props.label)
    if (node.props?.id) ids.push(node.props.id)
    for (const child of Array.isArray(node.props?.children) ? node.props.children : []) walk(child)
  }
  walk(
    registered[0].component({
      view: 'form',
      t: (key) => key,
      useInjectSettingsCard: (select) => select({
        available: true,
        writable: true,
        enabled: true,
        ov: true,
        ovProfile: false,
        skills: true,
        tips: true,
        tipsText: { text: '', overridden: false, invalid: false },
      }),
      save: () => {},
      discard: () => {},
      edit: () => {},
      resetField: () => {},
    }),
  )
  assert.deepEqual(labels, ['enabled', 'ov', 'ovProfile', 'skills', 'tips'], 'one switch per injected block')
  assert.deepEqual(ids, ['inject-config-user-tips'], 'the tips text rides the same form')

  console.log('case 12 ok  browser half registers four block switches plus the master switch')
}

// ---------------------------------------------------------------------------
// Case 13 — a second source rides the same channel: one message each.
// ---------------------------------------------------------------------------

{
  const NOTICE = '[fake source] a sibling injection source'
  const fakeSource = {
    id: 'fake',
    provider: 'fake',
    form: 'notice',
    enabled: () => true,
    collect: async () => NOTICE,
  }
  SOURCES.push(fakeSource)
  try {
    const ov = fakeOpenviking()
    const { hook } = mount({ userTips: '' }, { services: { openviking: ov } })
    const both = await runHook(hook, { agent: { id: 's13' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(both.messages.length, 3, 'each enabled source inserts exactly one message')
    assert.equal(both.messages[0].source.kind, 'user', 'the real input passes through untouched')
    // Sources run in registry order, each carrying its own provider/form.
    assert.equal(both.messages[1].source.provider, 'openviking')
    assert.equal(both.messages[1].source.form, 'recall')
    assert.equal(both.messages[2].source.provider, 'fake')
    assert.equal(both.messages[2].source.form, 'notice')
    assert.equal(both.messages[2].content[0].text, NOTICE)
    console.log('case 13 ok  a second source inserts its own message through the shared channel')
  } finally {
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 14 — sources run concurrently, while output keeps registry order.
// ---------------------------------------------------------------------------

{
  let slowStarted = false
  let fastStarted = false
  const slow = {
    id: 'slow',
    provider: 'slow',
    form: 'notice',
    enabled: () => true,
    collect: async () => {
      slowStarted = true
      await new Promise((resolve) => setTimeout(resolve, 50))
      // With a serial channel this flag is still false: the second source only
      // starts after the first finishes.
      if (!fastStarted) throw new Error('sources ran serially')
      return 'slow done'
    },
  }
  const fast = {
    id: 'fast',
    provider: 'fast',
    form: 'notice',
    enabled: () => true,
    collect: async () => {
      fastStarted = true
      return 'fast done'
    },
  }
  SOURCES.push(slow, fast)
  try {
    const { hook } = mount({ userTips: '', ovEnabled: false }, {})
    const out = await runHook(hook, { agent: { id: 's14' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(out.messages.length, 3, 'both sources insert')
    assert.equal(out.messages[1].content[0].text, 'slow done', 'messages keep registry order')
    assert.equal(out.messages[2].content[0].text, 'fast done')
    console.log('case 14 ok  sources run concurrently and messages keep registry order')
  } finally {
    SOURCES.pop()
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 15 — totalMaxChars caps a whole step, earliest source first.
// ---------------------------------------------------------------------------

{
  const first = 'A'.repeat(100)
  const second = 'B'.repeat(100)
  SOURCES.push(
    { id: 'a', provider: 'a', form: 'notice', enabled: () => true, collect: async () => first },
    { id: 'b', provider: 'b', form: 'notice', enabled: () => true, collect: async () => second },
  )
  try {
    const { hook } = mount({ totalMaxChars: 150, userTips: '', ovEnabled: false }, {})
    const out = await runHook(hook, { agent: { id: 's15' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    const a = out.messages[1].content[0].text
    const b = out.messages[2].content[0].text
    assert.equal(a, first, 'the first source spends its full share')
    assert.ok(b.startsWith('B'.repeat(50)), 'the second source receives the remaining 50 characters')
    assert.ok(!b.startsWith('B'.repeat(51)), 'and not one character more')
    assert.match(b, /truncated by dsh-inject-context/)
    console.log('case 15 ok  totalMaxChars caps the step and serves sources in order')
  } finally {
    SOURCES.pop()
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 16 — dedupe survives a restart: it is derived from the session log.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const first = mount({ userTips: '' }, { services: { openviking: ov } })
  const injectedRun = await runHook(first.hook, { agent: { id: 's16' }, turn: 1, step: 1, signal }, [
    realUser('u1', '同样的提问'),
  ])
  const injected = injectedRun.messages[1]

  // A fresh mount has an empty ledger, exactly like a post-restart process.
  const restarted = mount({ userTips: '' }, { services: { openviking: ov } })
  const session = {
    header: { cwd: root },
    snapshotEvents: () => [{ type: 'user/message', seq: 3, data: injected }],
    surface: { nodes: [3] },
  }
  const out = await runHook(restarted.hook, { agent: { id: 's16', session }, turn: 1, step: 1, signal }, [
    realUser('u1', '同样的提问'),
  ])
  assert.equal(out.messages.length, 1, 'a restarted process must derive dedupe from the log, not from memory')
  console.log('case 16 ok  dedupe survives a restart by reading the durable log')
}

// ---------------------------------------------------------------------------
// Case 17 — the memory index is a separate catalog block, once per session.
// ---------------------------------------------------------------------------

{
  const ov = fakeOpenviking()
  const { hook } = mount({ ovProfile: true, userTips: '' }, { services: { openviking: ov } })
  const first = await runHook(hook, { agent: { id: 's17' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(first.messages.length, 3, 'the index and the recall are one message each')
  const index = first.messages[1]
  const recall = first.messages[2]
  assert.equal(index.source.form, 'catalog', 'the index is a catalog, not a recall')
  assert.match(index.content[0].text, /## 🧠 记忆索引/)
  assert.match(index.content[0].text, /主题A/)
  assertFenced(index.content[0].text, 'index')
  assert.match(recall.content[0].text, /## 📖 相关记忆/)
  assert.ok(!recall.content[0].text.includes('记忆索引'), 'the index is not merged into the recall')
  assert.equal(ov.calls.filter((call) => call.kind === 'profile').length, 1, 'the index is fetched once')

  // The session log already carries the index, so it is not rebuilt and the
  // identical recall is skipped.
  const session = {
    header: { cwd: root },
    snapshotEvents: () => [
      { type: 'user/message', seq: 5, data: first.messages[1] },
      { type: 'user/message', seq: 6, data: first.messages[2] },
    ],
    surface: { nodes: [5, 6] },
  }
  const second = await runHook(hook, { agent: { id: 's17', session }, turn: 2, step: 1, signal }, [realUser('u2', 'hi')])
  assert.equal(second.messages.length, 1, 'neither the index nor the identical recall is re-sent')
  assert.equal(
    ov.calls.filter((call) => call.kind === 'profile').length,
    1,
    'an index already in the log is never rebuilt',
  )

  // Off by default.
  const plain = fakeOpenviking()
  const off = mount({ userTips: '' }, { services: { openviking: plain } })
  await runHook(off.hook, { agent: { id: 's17b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(plain.calls.filter((call) => call.kind === 'profile').length, 0, 'the index is opt-in')

  console.log('case 17 ok  the memory index is a separate catalog block, once per session, opt-in')
}

// ---------------------------------------------------------------------------
// Case 18 — step recall queries on the tool result and is off by default.
// ---------------------------------------------------------------------------

{
  const toolTurn = {
    id: 's18',
    session: {
      header: { cwd: root },
      snapshotEvents: () => [
        { type: 'turn/start', seq: 0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, data: realUser('u1', '查一下构建配置') },
        {
          type: 'tool/result',
          seq: 2,
          data: { turn: 1, step: 1, message: { id: 't1', role: 'tool', content: [{ type: 'text', text: 'BUILD_TARGET=android' }] } },
        },
      ],
      surface: { nodes: [1, 2] },
    },
  }

  const ov = fakeOpenviking()
  const { hook } = mount({ ovStepRecall: true, userTips: '' }, { services: { openviking: ov } })
  const stepTwo = await runHook(
    hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(ov.calls.length, 1, 'a tool-continuation step retrieves when step recall is on')
  assert.match(ov.calls[0].query, /查一下构建配置/, 'the query carries the turn user text')
  assert.match(ov.calls[0].query, /BUILD_TARGET=android/, 'and the tool result')
  assert.equal(stepTwo.messages.length, 2, 'the step receives its own recall block')
  assertFenced(stepTwo.messages[stepTwo.messages.length - 1].content[0].text, 'step recall')

  // The same step is served once, so a repeated pre-step costs no request.
  const repeated = await runHook(
    hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(ov.calls.length, 1, 'the same step is not retrieved twice')
  assert.equal(repeated.messages.length, 1)

  // Off by default: a plain mount must not retrieve on a continuation step.
  const plain = fakeOpenviking()
  const off = mount({ userTips: '' }, { services: { openviking: plain } })
  const skipped = await runHook(
    off.hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(plain.calls.length, 0, 'step recall is opt-in')
  assert.equal(skipped.messages.length, 1)
  console.log('case 18 ok  step recall queries on the tool result and is off by default')
}

// ---------------------------------------------------------------------------
// Case 19 — user tips are inserted once per session, config or env.
// ---------------------------------------------------------------------------

{
  const { hook } = mount({ ovEnabled: false })
  const first = await runHook(hook, { agent: { id: 's19' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const text = first.messages[1].content[0].text
  assert.match(text, /<user_tips>/, 'the block carries its marker')
  assert.match(text, /回答用中文/)
  assertFenced(text, 'tips')

  const session = {
    header: { cwd: root },
    snapshotEvents: () => [{ type: 'user/message', seq: 2, data: first.messages[1] }],
    surface: { nodes: [2] },
  }
  const second = await runHook(hook, { agent: { id: 's19', session }, turn: 2, step: 1, signal }, [realUser('u2', 'hi again')])
  assert.equal(second.messages.length, 1, 'tips are delivered once per session')

  // The environment variable is the fallback an API gateway uses.
  process.env.USER_TIPS = '这条来自 QQ 通道'
  try {
    const envMount = mount({ ovEnabled: false, userTips: '' })
    const fromEnv = await runHook(envMount.hook, { agent: { id: 's19b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.match(fromEnv.messages[1].content[0].text, /这条来自 QQ 通道/)
  } finally {
    delete process.env.USER_TIPS
  }
  console.log('case 19 ok  user tips are once-per-session and fall back to USER_TIPS')
}

// ---------------------------------------------------------------------------
// Case 20 — runtime warnings ride the event into the next step, once.
// ---------------------------------------------------------------------------

{
  const { hook, ctx } = mount({ ovEnabled: false, userTips: '' })
  const intake = ctx.listeners.find((listener) => listener.event === WARNING_EVENT)
  assert.ok(intake, 'the plugin listens for runtime warnings')
  intake.handler({ agent: { id: 's20' }, text: '工具调用已达上限，不要再调用工具' })

  const out = await runHook(hook, { agent: { id: 's20' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const warning = out.messages[1]
  assert.equal(warning.source.form, 'notice', 'a warning is a one-off notice')
  assert.equal(typeof warning.source.summary, 'string', 'a notice must carry its one-line account')
  assert.match(warning.content[0].text, /<user_warning>/)
  assert.match(warning.content[0].text, /不要再调用工具/)
  assertFenced(warning.content[0].text, 'warning')

  const drained = await runHook(hook, { agent: { id: 's20' }, turn: 2, step: 1, signal }, [realUser('u2', 'hi again')])
  assert.equal(drained.messages.length, 1, 'a warning is consumed by the step that received it')

  // `userWarning=false` makes the intake drop the event instead of queueing it.
  const off = mount({ ovEnabled: false, userTips: '', userWarning: false })
  const offIntake = off.ctx.listeners.find((listener) => listener.event === WARNING_EVENT)
  offIntake.handler({ agent: { id: 's20b' }, text: '不该出现' })
  const ignored = await runHook(off.hook, { agent: { id: 's20b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(ignored.messages.length, 1, 'userWarning=false keeps warnings out of the turn')

  console.log('case 20 ok  runtime warnings are event-fed, notice-form, fenced, and consumed once')
}

// ---------------------------------------------------------------------------
// Case 21 — the public source interface validates and can be unregistered.
// ---------------------------------------------------------------------------

{
  assert.throws(() => defineSource({ id: 'x' }), /provider/, 'a source must declare its provider')
  assert.throws(() => defineSource({ id: 'x', provider: 'x', form: 'notice' }), /enabled/, 'and its gate')
  assert.throws(() => defineSource({ id: 'x', provider: 'x', form: 'notice', enabled: () => true }), /collect/, 'and its collector')

  const custom = defineSource({
    id: 'custom',
    provider: 'custom',
    form: 'notice',
    enabled: () => true,
    collect: async () => 'custom source text',
    summary: () => 'custom',
  })
  const unregister = registerSource(custom)
  try {
    const { hook } = mount({ ovEnabled: false, userTips: '' })
    const out = await runHook(hook, { agent: { id: 's21' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(out.messages.length, 2)
    assert.equal(out.messages[1].content[0].text, 'custom source text')
    assert.equal(out.messages[1].source.summary, 'custom')
  } finally {
    unregister()
  }
  assert.equal(SOURCES.includes(custom), false, 'the disposer removes the source')
  console.log('case 21 ok  defineSource validates and registerSource returns a disposer')
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

delete globalThis.window
await rm(root, { recursive: true, force: true })

console.log('\nall checks passed')

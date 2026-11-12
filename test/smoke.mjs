/**
 * Smoke test for dsh-inject-context.
 *
 * Two halves are exercised without a running harness:
 *
 *   - The host half is driven against a mock Cordis context in exactly the
 *     shapes `@deepseek-ai/dsh-agent-loop` produces, and every injected message
 *     is checked against the same invariants `assertMessageEventShape` enforces
 *     when the session persists it.
 *   - The browser half is loaded through a stand-in for the Client module
 *     loader, and its Plugins-page registration is asserted directly — the one
 *     part of the settings wiring that is otherwise only checkable by hand in
 *     the web UI.
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

import { WARNING_EVENT, Config, SOURCES, apply, defineSource, inject, name, registerSource } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Mock Cordis context
// ---------------------------------------------------------------------------

function makeCtx({ credentials, services } = {}) {
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
      if (service === 'credentials') return credentials
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

// ---------------------------------------------------------------------------
// Fetch stand-in
// ---------------------------------------------------------------------------

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

let fetchCalls = []
let fetchImpl = async () => jsonResponse({ result: { memories: [] } })
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  return fetchImpl(url, init)
}

/** Stands in for a real OpenViking abstract, which runs to ~1.6k characters. */
const LONG_ABSTRACT = `长记忆 ${'A'.repeat(1500)} 结尾标记`

const MEMORY_BODY = {
  // Shape captured from a live OpenViking /api/v1/search/find response:
  // { status, result: { memories: [{context_type, uri, level, score, abstract, tags}], resources, skills, total } }
  result: {
    memories: [
      { uri: 'viking://mem/1', score: 0.91, abstract: '用户偏好深色主题', context_type: 'memory', level: 2, tags: [] },
      { uri: 'viking://mem/2', score: 0.72, abstract: '项目使用 pnpm', context_type: 'memory', level: 2, tags: [] },
      { uri: 'viking://mem/1', score: 0.91, abstract: 'duplicate uri', context_type: 'memory', level: 2, tags: [] },
      { uri: 'viking://mem/4', score: 0.55, abstract: LONG_ABSTRACT, context_type: 'memory', level: 2, tags: [] },
      { uri: 'viking://mem/3', score: 0.2, abstract: 'below threshold on the server side', context_type: 'memory', level: 2, tags: [] },
    ],
    resources: [],
    skills: [],
    total: 5,
  },
}

const credentials = {
  async resolve(ref) {
    return ref === 'TEST_KEY' ? { value: 'test-token-123' } : undefined
  },
}

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  'ovHost': 'ov.test',
  'ovUser': 'alice',
  'ovApiKeyEnv': 'TEST_KEY',
}

function mount(overrides = {}, options = {}) {
  const ctx = makeCtx({ credentials, services: options.services })
  const config = Config({ ...BASE_CONFIG, ...overrides })
  const dispose = apply(ctx, config)
  const hook = ctx.listeners.find((l) => l.event === 'agent/pre-step')
  return { ctx, config, dispose, hook }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-inject-context-'))
const agent = { id: 'session-1', session: { header: { cwd: root } } }
const signal = new AbortController().signal

const runHook = (hook, payload, messages) => hook.handler(payload, async () => defaultDecision(messages))

console.log(`fixture: ${root}\n`)

// ---------------------------------------------------------------------------
// Case 1 — the exported Config is the shape the settings service projects.
// ---------------------------------------------------------------------------

assert.equal(name, 'dsh-inject-context')
assert.deepEqual(inject, [], 'the plugin declares no hard service dependency')
assert.equal(Config.type, 'object')

const VOLATILE_FIELDS = ['enabled', 'ovHost', 'ovScoreThreshold', 'ovLimit']
const ORDINARY_FIELDS = [
  'maxChars',
  'totalMaxChars',
  'timeoutMs',
  'dedupeUnchanged',
  'ovUser',
  'ovAccount',
  'ovPeer',
  'ovApiKeyEnv',
  'ovAbstractChars',
  'ovProfile',
  'ovProfileLimit',
  'ovProfileChars',
  'ovStepRecall',
  'ovStepQueryChars',
  'skillList',
  'skillService',
  'skillListLimit',
  'skillListChars',
  'userTips',
]

for (const field of VOLATILE_FIELDS) {
  assert.equal(Config.dict[field]?.meta?.volatile, true, `${field} must be volatile to reach the settings form`)
}
for (const field of ORDINARY_FIELDS) {
  assert.notEqual(Config.dict[field]?.meta?.volatile, true, `${field} is ordinary configuration, not a form field`)
}
assert.equal(
  Config.dict['ovApiKeyEnv']?.meta?.role,
  'credential-ref',
  'the key field names a credential; the literal must never live in configuration',
)
assert.equal(
  Object.values(Config.dict).some((child) => child.meta?.role === 'secret'),
  false,
  'no field holds a secret literal',
)

// A volatile field arrives as a live reference, an ordinary one as a plain
// value — the two shapes readConfig() has to cover.
const liveConfig = Config({ ...BASE_CONFIG })
assert.equal(typeof liveConfig['ovHost']?.get, 'function', 'volatile fields arrive as live references')
assert.equal(liveConfig['ovHost'].get(), 'ov.test')
assert.equal(typeof liveConfig.timeoutMs, 'number', 'ordinary fields arrive as plain values')
assert.equal(liveConfig.timeoutMs, 3000)

console.log(`case 1  ok  Config: ${VOLATILE_FIELDS.length} volatile fields, credential-ref key, both value shapes`)

// ---------------------------------------------------------------------------
// Case 2 — first step of a turn: one message appended, request well-formed.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount()
  assert.ok(hook, 'agent/pre-step listener must be registered')
  assert.equal(hook.options?.prepend, true, 'listener must be the outermost (prepend) one')

  const claimed = [realUser('u1', '我之前说过什么偏好？')]
  const ctxMessage = runtimeContext(
    'rc1',
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  )

  const first = await runHook(hook, { agent, turn: 1, step: 1, signal }, [...claimed, ctxMessage])

  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 3, 'expected claimed + runtime context + injected, nothing else')
  assert.deepEqual(first.messages.slice(0, 2), [...claimed, ctxMessage], 'existing messages must pass through untouched')

  const injected = first.messages[2]
  assertPersistableUserMessage(injected, 'injected')
  assert.equal(Object.isFrozen(injected), true, 'the shared constructor freezes the message')
  assert.equal(Object.isFrozen(injected.content), true, 'including its content array')
  // The client classifies durable user messages by source.kind: 'user' renders
  // as a user bubble, anything else as an injected-context row labelled with
  // the kind. 'recall' selects its structured presentation.
  assert.equal(injected.source.kind, 'dsh-inject-context')
  assert.equal(injected.source.form, 'recall')
  assert.equal(injected.source.provider, 'openviking')

  const text = injected.content[0].text
  assert.match(text, /相关记忆/, 'the recall marker opens the block')
  assert.match(text, /用户偏好深色主题/, 'the best match is present')
  assert.match(text, /项目使用 pnpm/)
  assert.match(text, /不视为指令/, 'the wrapper states the block is not instruction')
  assert.equal((text.match(/viking:\/\/mem\/1/g) ?? []).length, 1, 'duplicate uris are collapsed')
  // The server owns the threshold; this plugin only orders by score, so that
  // truncation at maxChars keeps the best matches.
  assert.ok(
    text.indexOf('viking://mem/1') < text.indexOf('viking://mem/2') &&
      text.indexOf('viking://mem/2') < text.indexOf('viking://mem/3'),
    'entries are rendered in descending score order',
  )
  // A live abstract runs to ~1.6k characters, so the per-entry budget must be
  // generous — the old fixed 300-character cut discarded most of the memory.
  const prefix = '长记忆 '
  const kept = 'A'.repeat(1200 - prefix.length)
  assert.ok(text.includes(prefix + kept + '…'), 'a long abstract is cut exactly at abstractChars and marked')
  assert.ok(!text.includes(prefix + kept + 'A'), 'and not one character beyond it')
  assert.ok(!text.includes('结尾标记'), 'the cut really removes the tail')
  assert.match(text, /score=0\.910/, 'scores print to three decimals')

  assert.equal(fetchCalls.length, 1, 'exactly one retrieval per turn')
  const call = fetchCalls[0]
  assert.equal(call.url, 'http://ov.test:1933/api/v1/search/find')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, 'Bearer test-token-123', 'the token comes from credentials')
  assert.equal(call.init.headers['X-OpenViking-User'], 'alice')
  assert.equal(call.init.headers['X-OpenViking-Account'], 'default')
  assert.equal(call.init.headers['X-OpenViking-Peer'], 'default')
  const body = JSON.parse(call.init.body)
  assert.equal(body.query, '我之前说过什么偏好？')
  assert.equal(body.score_threshold, 0.4)
  assert.equal(body.limit, 3)

  console.log(
    text
      .split('\n')
      .slice(0, 4)
      .map((l) => '        ' + l)
      .join('\n'),
  )
  console.log('case 2  ok  first step injects one message and the request is well-formed')
}

// ---------------------------------------------------------------------------
// Case 3 — a tool-continuation step claims nothing: no second retrieval.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount()
  await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', '第一次提问')])
  const before = fetchCalls.length

  const emptyClaim = await runHook(hook, { agent, turn: 1, step: 2, signal }, [
    runtimeContext('rc1', 'Current runtime context.'),
  ])
  assert.equal(emptyClaim.messages.length, 1, 'a step with no fresh user input must not inject')
  assert.equal(fetchCalls.length, before, 'and must not retrieve again')
  console.log('case 3  ok  tool-continuation step neither retrieves nor injects')
}

// ---------------------------------------------------------------------------
// Case 4 — dedupe across turns depends on the previous copy still being visible.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount()
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

  // Compaction dropped it → inject again, or the model is left without it.
  const afterCompaction = await runHook(hook, { agent: withSurface([]), turn: 3, step: 1, signal }, [
    realUser('u2b', '同样的提问'),
  ])
  assert.equal(afterCompaction.messages.length, 2, 'results dropped by compaction must be re-injected')

  // An unreadable session shape must fail safe by injecting.
  const unknownShape = await runHook(
    hook,
    { agent: { id: 'session-1', session: { header: { cwd: root } } }, turn: 4, step: 1, signal },
    [realUser('u2c', '同样的提问')],
  )
  assert.equal(unknownShape.messages.length, 2, 'an unreadable session must not silently starve the model')

  console.log('case 4  ok  surface-aware dedupe (skip / re-inject / fail-safe)')
}

// ---------------------------------------------------------------------------
// Case 5 — other plugins' injections are never mistaken for user input.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  const { hook } = mount()
  const otherPluginOnly = await runHook(hook, { agent, turn: 1, step: 1, signal }, [
    runtimeContext('rc2', 'someone else injected this'),
  ])
  assert.equal(otherPluginOnly.messages.length, 1)
  assert.equal(fetchCalls.length, 0, 'only source.kind "user" counts as real input')
  console.log('case 5  ok  only genuine user input triggers retrieval')
}

// ---------------------------------------------------------------------------
// Case 6 — the enable switch short-circuits before any request.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  const { hook } = mount({ enabled: false })
  const disabled = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(disabled.messages.length, 1)
  assert.equal(fetchCalls.length, 0, 'a disabled plugin must not touch the network')
  console.log('case 6  ok  enabled=false short-circuits before fetch')
}

// ---------------------------------------------------------------------------
// Case 7 — a blank host disables retrieval without disabling the plugin.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  const { hook } = mount({ 'ovHost': '' })
  const noHost = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(noHost.messages.length, 1)
  assert.equal(fetchCalls.length, 0)
  console.log('case 7  ok  blank host injects nothing and fetches nothing')
}

// ---------------------------------------------------------------------------
// Case 8 — a host that already carries scheme and port is accepted as typed.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: [] })
  const { hook } = mount({ 'ovHost': 'https://ov.example.com:8443/' })
  await runHook(hook, { agent: { id: 's2' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(fetchCalls[0]?.url, 'https://ov.example.com:8443/api/v1/search/find')
  console.log('case 8  ok  scheme and port are honoured when typed into the host field')
}

// ---------------------------------------------------------------------------
// Case 8b — abstractChars 0 keeps each abstract whole; the block cap still applies.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount({ 'ovAbstractChars': 0 })
  const whole = await runHook(hook, { agent: { id: 's5' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const text = whole.messages[1].content[0].text
  assert.ok(text.includes('结尾标记'), 'abstractChars=0 keeps the abstract whole')
  assert.ok(!text.includes('…'), 'and marks no cut')
  console.log('case 8b ok  abstractChars=0 disables the per-entry cut')
}

// ---------------------------------------------------------------------------
// Case 9 — failures degrade to "inject nothing" and never break the turn.
// ---------------------------------------------------------------------------

{
  const failures = [
    ['HTTP 401', async () => jsonResponse({ error: 'unauthorized' }, 401)],
    ['HTTP 500', async () => jsonResponse({}, 500)],
    [
      'unparseable body',
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json')
        },
      }),
    ],
    [
      'network error',
      async () => {
        throw new Error('ECONNREFUSED')
      },
    ],
    ['never settles', () => new Promise(() => {})],
  ]
  for (const [label, impl] of failures) {
    fetchCalls = []
    fetchImpl = impl
    // A short timeout keeps the "never settles" case quick.
    const { hook, ctx } = mount({ timeoutMs: 60 })
    const survived = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(survived.messages.length, 1, `${label}: must degrade to no injection`)
    assert.ok(
      ctx.logs.some(([level]) => level === 'warn'),
      `${label}: the failure must be logged as a warning`,
    )
  }

  // An empty result is an ordinary outcome, not a failure: nothing to inject,
  // nothing to warn about.
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: { memories: [] } })
  const { hook, ctx } = mount()
  const empty = await runHook(hook, { agent, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(empty.messages.length, 1, 'an empty result injects nothing')
  assert.equal(
    ctx.logs.some(([level]) => level === 'warn'),
    false,
    'an empty result is not a failure and must not warn',
  )

  console.log('case 9  ok  failures warn and degrade; an empty result is silent')
}

// ---------------------------------------------------------------------------
// Case 10 — a turn cancelled mid-retrieval is not injected into.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount()
  const aborted = new AbortController()
  aborted.abort()
  const afterAbort = await runHook(hook, { agent, turn: 1, step: 1, signal: aborted.signal }, [
    realUser('u1', 'too late'),
  ])
  assert.equal(afterAbort.messages.length, 1)
  assert.equal(fetchCalls.length, 0)
  console.log('case 10 ok  an already-aborted turn is not injected into')
}

// ---------------------------------------------------------------------------
// Case 11 — a live settings edit is observed without remounting.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: [] })
  const { hook, config } = mount()
  await runHook(hook, { agent: { id: 's3' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(JSON.parse(fetchCalls[0].init.body).limit, 3)

  if (typeof config['ovLimit']?.set === 'function') {
    config['ovLimit'].set(7)
    await runHook(hook, { agent: { id: 's4' }, turn: 1, step: 1, signal }, [realUser('u2', 'hi again')])
    assert.equal(
      JSON.parse(fetchCalls[1].init.body).limit,
      7,
      'configuration is read per turn, so a settings edit applies without a restart',
    )
    console.log('case 11 ok  a live settings edit applies from the next turn')
  } else {
    console.log('case 11 skip live-ref setter unavailable in this schemastery build')
  }
}

// ---------------------------------------------------------------------------
// Case 12 — disposition removes both listeners.
// ---------------------------------------------------------------------------

{
  const { ctx, dispose } = mount()
  assert.equal(ctx.listeners.length, 3, 'agent/pre-step plus agent/disposed plus the warning intake')
  dispose()
  assert.equal(ctx.listeners.length, 0)
  console.log('case 12 ok  the returned disposer unregisters every listener')
}

// ---------------------------------------------------------------------------
// Case 13 — the browser half registers the right page, keyed by the package.
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
    settingsNumberField: (field) => ({
      field,
      format: (v) => (typeof v === 'number' ? String(v) : ''),
      parse: (t) => ({ kind: 'set', value: Number(t) }),
    }),
  }
  class FakeFormModel {
    constructor(scope, fieldSpecs, secretSpecs = []) {
      this.specs = new Map(fieldSpecs.map((s) => [s.field, s]))
      this.secretSpecs = new Map(secretSpecs.map((s) => [s.field, s]))
      this.values = {}
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
    SettingsSecretField: 'SettingsSecretField',
    SettingsFormModel: FakeFormModel,
  }
  const requireStub = (specifier) => {
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require("${specifier}")`)
  }

  const clientExports = definition.factory(requireStub)
  assert.deepEqual(clientExports.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'])

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
    remote: {
      $on: () => () => {},
      credentials: {
        describe: async () => ({ ok: true, value: {} }),
        set: async () => {},
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
  // The hook is read first and unconditionally, exactly as the shipped pages do.
  const summary = registered[0].component({
    view: 'summary',
    t: (key) => key,
    useInjectSettingsCard: (select) => select({}),
  })
  assert.equal(typeof summary, 'string')

  console.log('case 13 ok  browser half registers plugins.bundle.config keyed by the package name')
}

// ---------------------------------------------------------------------------
// Case 14 — a second source rides the same channel: one message each.
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
    fetchCalls = []
    fetchImpl = async () => jsonResponse(MEMORY_BODY)
    const { hook } = mount()
    const both = await runHook(hook, { agent: { id: 's6' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(both.messages.length, 3, 'each enabled source appends exactly one message')
    assert.equal(both.messages[0].source.kind, 'user', 'the real input passes through untouched')
    // Sources run in registry order, each carrying its own provider/form.
    assert.equal(both.messages[1].source.provider, 'openviking')
    assert.equal(both.messages[1].source.form, 'recall')
    assert.equal(both.messages[2].source.provider, 'fake')
    assert.equal(both.messages[2].source.form, 'notice')
    assert.equal(both.messages[2].content[0].text, NOTICE)
    console.log('case 14 ok  a second source injects its own message through the shared channel')
  } finally {
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 15 — sources run concurrently, while output keeps registry order.
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
    fetchCalls = []
    fetchImpl = async () => jsonResponse({ result: { memories: [] } })
    const { hook } = mount()
    const out = await runHook(hook, { agent: { id: 's15' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(out.messages.length, 3, 'both sources inject')
    assert.equal(out.messages[1].content[0].text, 'slow done', 'messages keep registry order')
    assert.equal(out.messages[2].content[0].text, 'fast done')
    console.log('case 15 ok  sources run concurrently and messages keep registry order')
  } finally {
    SOURCES.pop()
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 16 — a timed-out source is aborted, not merely stopped waiting.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  let requestSignal
  fetchImpl = async (_url, init) => {
    requestSignal = init.signal
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted by deadline')))
    })
  }
  const { hook, ctx } = mount({ timeoutMs: 40 })
  const out = await runHook(hook, { agent: { id: 's16' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(out.messages.length, 1, 'a timed-out source injects nothing')
  assert.ok(requestSignal, 'the request carries an abort signal')
  assert.equal(requestSignal.aborted, true, 'the per-source deadline aborts the request itself')
  assert.ok(ctx.logs.some(([level]) => level === 'warn'), 'and the degradation is logged')
  console.log('case 16 ok  a timed-out source is aborted and the step continues')
}

// ---------------------------------------------------------------------------
// Case 17 — totalMaxChars caps a whole step, earliest source first.
// ---------------------------------------------------------------------------

{
  const first = 'A'.repeat(100)
  const second = 'B'.repeat(100)
  SOURCES.push(
    { id: 'a', provider: 'a', form: 'notice', enabled: () => true, collect: async () => first },
    { id: 'b', provider: 'b', form: 'notice', enabled: () => true, collect: async () => second },
  )
  try {
    fetchCalls = []
    fetchImpl = async () => jsonResponse({ result: { memories: [] } })
    const { hook } = mount({ totalMaxChars: 150 })
    const out = await runHook(hook, { agent: { id: 's17' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    const a = out.messages[1].content[0].text
    const b = out.messages[2].content[0].text
    assert.equal(a, first, 'the first source spends its full share')
    assert.ok(b.startsWith('B'.repeat(50)), 'the second source receives the remaining 50 characters')
    assert.ok(!b.startsWith('B'.repeat(51)), 'and not one character more')
    assert.match(b, /truncated by dsh-inject-context/)
    console.log('case 17 ok  totalMaxChars caps the step and serves sources in order')
  } finally {
    SOURCES.pop()
    SOURCES.pop()
  }
}

// ---------------------------------------------------------------------------
// Case 18 — dedupe survives a restart: it is derived from the session log.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const first = mount()
  const injectedRun = await runHook(first.hook, { agent: { id: 's18' }, turn: 1, step: 1, signal }, [realUser('u1', '同样的提问')])
  const injected = injectedRun.messages[1]

  // A fresh mount has an empty ledger, exactly like a post-restart process.
  const restarted = mount()
  const session = {
    header: { cwd: root },
    snapshotEvents: () => [{ type: 'user/message', seq: 3, data: injected }],
    surface: { nodes: [3] },
  }
  const out = await runHook(restarted.hook, { agent: { id: 's18', session }, turn: 1, step: 1, signal }, [realUser('u1', '同样的提问')])
  assert.equal(out.messages.length, 1, 'a restarted process must derive dedupe from the log, not from memory')
  console.log('case 18 ok  dedupe survives a restart by reading the durable log')
}

// ---------------------------------------------------------------------------
// Case 19 — the memory index rides the first recall and is not rebuilt.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/fs/tree')) {
      return jsonResponse({ result: { entries: [{ name: '主题A' }, { title: '主题B' }] } })
    }
    return jsonResponse(MEMORY_BODY)
  }
  const { hook } = mount({ ovProfile: true, ovUser: 'alice' })
  const first = await runHook(hook, { agent: { id: 's19' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(first.messages.length, 3, 'the index and the recall are one message each')
  const indexText = first.messages[1].content[0].text
  const recallText = first.messages[2].content[0].text
  assert.equal(first.messages[1].source.form, 'catalog', 'the index is a catalog, not a recall')
  assert.match(indexText, /记忆索引/)
  assert.match(indexText, /主题A/)
  assert.match(indexText, /主题B/)
  assert.match(recallText, /相关记忆/)
  assert.ok(!recallText.includes('记忆索引'), 'the index is not merged into the recall')
  assert.equal(fetchCalls.filter((call) => String(call.url).includes('/api/v1/fs/tree')).length, 1, 'the tree is fetched once')

  // The session log already carries the index and the surface still shows both
  // messages, so the index is not rebuilt and the identical recall is skipped.
  const session = {
    header: { cwd: root },
    snapshotEvents: () => [
      { type: 'user/message', seq: 5, data: first.messages[1] },
      { type: 'user/message', seq: 6, data: first.messages[2] },
    ],
    surface: { nodes: [5, 6] },
  }
  const second = await runHook(hook, { agent: { id: 's19', session }, turn: 2, step: 1, signal }, [realUser('u2', 'hi')])
  assert.equal(second.messages.length, 1, 'neither the index nor the identical recall is re-sent')
  assert.equal(
    fetchCalls.filter((call) => String(call.url).includes('/api/v1/fs/tree')).length,
    1,
    'an index already in the log is never rebuilt',
  )
  console.log('case 19 ok  the memory index is a separate catalog message and is derived from the log')
}

// ---------------------------------------------------------------------------
// Case 20 — step recall queries on the tool result and is off by default.
// ---------------------------------------------------------------------------

{
  const toolTurn = {
    id: 's20',
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

  fetchCalls = []
  fetchImpl = async () => jsonResponse(MEMORY_BODY)
  const { hook } = mount({ ovStepRecall: true })
  const stepTwo = await runHook(
    hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(fetchCalls.length, 1, 'a tool-continuation step retrieves when step recall is on')
  const query = JSON.parse(fetchCalls[0].init.body).query
  assert.match(query, /查一下构建配置/, 'the query carries the turn user text')
  assert.match(query, /BUILD_TARGET=android/, 'and the tool result')
  assert.equal(stepTwo.messages.length, 2, 'the step receives its own recall block')

  // The same step is served once, so a repeated pre-step costs no request.
  const repeated = await runHook(
    hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(fetchCalls.length, 1, 'the same step is not retrieved twice')
  assert.equal(repeated.messages.length, 1)

  // Off by default: a plain mount must not retrieve on a continuation step.
  fetchCalls = []
  const plain = mount()
  const skipped = await runHook(
    plain.hook,
    { agent: toolTurn, turn: 1, step: 2, signal },
    [runtimeContext('rc1', 'Current runtime context.')],
  )
  assert.equal(fetchCalls.length, 0, 'step recall is opt-in')
  assert.equal(skipped.messages.length, 1)
  console.log('case 20 ok  step recall queries on the tool result and is off by default')
}

// ---------------------------------------------------------------------------
// Case 21 — user tips are injected once per session, config or env.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: { memories: [] } })
  const { hook } = mount({ userTips: '回答用中文，并给出命令示例' })
  const first = await runHook(hook, { agent: { id: 's21' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const text = first.messages[1].content[0].text
  assert.match(text, /<user_tips>/, 'the block carries its marker')
  assert.match(text, /回答用中文/)
  assert.equal(first.messages[1].source.form, 'instructions')

  const session = {
    header: { cwd: root },
    snapshotEvents: () => [{ type: 'user/message', seq: 2, data: first.messages[1] }],
    surface: { nodes: [2] },
  }
  const second = await runHook(hook, { agent: { id: 's21', session }, turn: 2, step: 1, signal }, [realUser('u2', 'hi again')])
  assert.equal(second.messages.length, 1, 'tips are delivered once per session')

  // The environment variable is the fallback an API gateway uses.
  process.env.USER_TIPS = '这条来自 QQ 通道'
  try {
    const envMount = mount()
    const fromEnv = await runHook(envMount.hook, { agent: { id: 's21b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.match(fromEnv.messages[1].content[0].text, /这条来自 QQ 通道/)
  } finally {
    delete process.env.USER_TIPS
  }
  console.log('case 21 ok  user tips are once-per-session and fall back to USER_TIPS')
}

// ---------------------------------------------------------------------------
// Case 22 — the skill catalog is supplied by another plugin's service.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: { memories: [] } })
  const skills = {
    list: async () => [
      { name: 'file-tools', description: '读写文件' },
      { name: 'shell', description: '执行命令' },
    ],
  }
  const { hook } = mount({ skillList: true }, { services: { shellSkills: skills } })
  const first = await runHook(hook, { agent: { id: 's22' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const catalog = first.messages[1]
  assert.equal(catalog.source.form, 'catalog')
  const text = catalog.content[0].text
  assert.match(text, /<available_skills>/)
  assert.match(text, /- `file-tools`: 读写文件/)
  assert.match(text, /- `shell`: 执行命令/)

  // No provider registered → nothing is injected, even when enabled.
  const noProvider = mount({ skillList: true })
  const missing = await runHook(noProvider.hook, { agent: { id: 's22b' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(missing.messages.length, 1)

  // Off by default, so a provider alone changes nothing.
  const off = mount({}, { services: { shellSkills: skills } })
  const disabled = await runHook(off.hook, { agent: { id: 's22c' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  assert.equal(disabled.messages.length, 1)
  console.log('case 22 ok  the skill catalog is read from the provider service and is opt-in')
}

// ---------------------------------------------------------------------------
// Case 23 — runtime warnings ride the event into the next step, once.
// ---------------------------------------------------------------------------

{
  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: { memories: [] } })
  const { hook, ctx } = mount()
  const intake = ctx.listeners.find((listener) => listener.event === WARNING_EVENT)
  assert.ok(intake, 'the plugin listens for runtime warnings')
  intake.handler({ agent: { id: 's23' }, text: '工具调用已达上限，不要再调用工具' })

  const out = await runHook(hook, { agent: { id: 's23' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
  const warning = out.messages[1]
  assert.equal(warning.source.form, 'notice', 'a warning is a one-off notice')
  assert.equal(typeof warning.source.summary, 'string', 'a notice must carry its one-line account')
  assert.match(warning.content[0].text, /<user_warning>/)
  assert.match(warning.content[0].text, /不要再调用工具/)

  const drained = await runHook(hook, { agent: { id: 's23' }, turn: 2, step: 1, signal }, [realUser('u2', 'hi again')])
  assert.equal(drained.messages.length, 1, 'a warning is consumed by the step that received it')

  console.log('case 23 ok  runtime warnings are event-fed, notice-form, and consumed once')
}

// ---------------------------------------------------------------------------
// Case 24 — the public source interface validates and can be unregistered.
// ---------------------------------------------------------------------------

{
  assert.throws(() => defineSource({ id: 'x' }), /provider/, 'a source must declare its provider')
  assert.throws(() => defineSource({ id: 'x', provider: 'x', form: 'notice' }), /enabled/, 'and its gate')
  assert.throws(() => defineSource({ id: 'x', provider: 'x', form: 'notice', enabled: () => true }), /collect/, 'and its collector')

  fetchCalls = []
  fetchImpl = async () => jsonResponse({ result: { memories: [] } })
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
    const { hook } = mount()
    const out = await runHook(hook, { agent: { id: 's24' }, turn: 1, step: 1, signal }, [realUser('u1', 'hi')])
    assert.equal(out.messages.length, 2)
    assert.equal(out.messages[1].content[0].text, 'custom source text')
    assert.equal(out.messages[1].source.summary, 'custom')
  } finally {
    unregister()
  }
  assert.equal(SOURCES.includes(custom), false, 'the disposer removes the source')
  console.log('case 24 ok  defineSource validates and registerSource returns a disposer')
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

globalThis.fetch = realFetch
delete globalThis.window
await rm(root, { recursive: true, force: true })

console.log('\nall checks passed')

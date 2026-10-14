/**
 * Smoke test for dsh-inject-context.
 *
 * Drives the registered `agent/pre-step` listener against a mock Cordis
 * context, in the same shapes `@deepseek-ai/dsh-agent-loop` actually produces,
 * and checks the injected message against the same invariants
 * `assertMessageEventShape` enforces when the session persists it.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'

// ---------------------------------------------------------------------------
// A mock of the parts of Cordis and dsh-agent-loop this plugin touches.
// ---------------------------------------------------------------------------

function makeCtx() {
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
  }
}

/** The decision the harness's default `next()` produces when the step has real input. */
function defaultDecision(messages) {
  return { kind: 'enter', messages }
}

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
 * `user/message` event. If the plugin produced a message that fails this, the
 * real harness would throw at `session.append('user/message', ...)`.
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
// Fixtures
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'dsh-inject-context-'))
await mkdir(join(root, 'src'), { recursive: true })
await mkdir(join(root, 'node_modules'), { recursive: true })
await writeFile(join(root, 'src', 'index.js'), 'export const x = 1\n')
await writeFile(join(root, 'README.md'), '# demo\n')
await writeFile(join(root, '.hidden'), 'secret\n')
await writeFile(join(root, 'a.txt'), 'hello\n')

const ctx = makeCtx()
const dispose = apply(ctx, { maxEntries: 50 })

assert.equal(name, 'dsh-inject-context')
assert.deepEqual(inject, [], 'plugin must declare no service dependencies')
assert.equal(typeof dispose, 'function', 'apply must return a disposer')

const hook = ctx.listeners.find((l) => l.event === 'agent/pre-step')
assert.ok(hook, 'agent/pre-step listener must be registered')
assert.equal(hook.options?.prepend, true, 'listener must be the outermost (prepend) one')

const agent = { id: 'session-1', session: { header: { cwd: root } } }
const signal = new AbortController().signal

console.log(`fixture: ${root}\n`)

// ---------------------------------------------------------------------------
// Case 1 — first step of a turn with real user input: one message is appended.
// ---------------------------------------------------------------------------

const claimed = [realUser('u1', 'list the current directory')]
const harnessRuntimeContext = runtimeContext('rc1', 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')

const first = await hook.handler(
  { agent, turn: 1, step: 1, signal },
  async () => defaultDecision([...claimed, harnessRuntimeContext]),
)

assert.equal(first.kind, 'enter')
assert.equal(first.messages.length, 3, 'expected claimed + runtime context + injected, nothing else')
assert.deepEqual(first.messages.slice(0, 2), [...claimed, harnessRuntimeContext], 'existing messages must pass through untouched')

const injected = first.messages[2]
assertPersistableUserMessage(injected, 'injected')
// The client classifies every durable user message by source.kind: 'user'
// renders as a user bubble, anything else as an injected-context row whose
// producer label is the kind itself.
assert.equal(injected.source.kind, 'dsh-inject-context')
assert.equal(injected.source.form, 'snapshot', 'form selects the client context presentation')
assert.equal(injected.source.cwd, root)
assert.match(injected.content[0].text, /^<directory-listing cwd="/)
assert.match(injected.content[0].text, /Directory of /)
assert.match(injected.content[0].text, /src\\/, 'directories are marked with a trailing backslash')
assert.match(injected.content[0].text, /README\.md/)
assert.match(injected.content[0].text, /a\.txt/)
assert.match(injected.content[0].text, /\(4 entries: 2 directories, 2 files\)/, 'hidden entry excluded by default')
assert.ok(!injected.content[0].text.includes('.hidden'), 'dot-files are excluded by default')

console.log(injected.content[0].text)
console.log('')

// ---------------------------------------------------------------------------
// Case 2 — a later step of the same turn claims nothing: no second injection.
// ---------------------------------------------------------------------------

const emptyClaim = await hook.handler(
  { agent, turn: 1, step: 2, signal },
  async () => defaultDecision([harnessRuntimeContext]),
)
assert.equal(emptyClaim.messages.length, 1, 'a tool-continuation step must not re-inject')

// ---------------------------------------------------------------------------
// Case 3 — a new turn, same input, unchanged listing, and the earlier copy is
// still on the model surface: deduped.
// ---------------------------------------------------------------------------

/** A session stub exposing exactly what stillOnSurface() reads. */
function surfaceSession(cwd, events, nodes) {
  return { header: { cwd }, snapshotEvents: () => events, surface: { nodes } }
}

const SURFACE_SEQ = 7
agent.session = surfaceSession(root, [{ type: 'user/message', seq: SURFACE_SEQ, data: injected }], [SURFACE_SEQ])

const repeat = await hook.handler(
  { agent, turn: 2, step: 1, signal },
  async () => defaultDecision([realUser('u2', 'list the current directory')]),
)
assert.equal(repeat.messages.length, 1, 'an identical listing still on the surface must not be re-sent')

// ---------------------------------------------------------------------------
// Case 3b — same listing, but the earlier copy was compacted off the surface:
// it must be injected again, or the model is left without it.
// ---------------------------------------------------------------------------

agent.session = surfaceSession(root, [{ type: 'user/message', seq: SURFACE_SEQ, data: injected }], [])

const afterCompaction = await hook.handler(
  { agent, turn: 3, step: 1, signal },
  async () => defaultDecision([realUser('u2b', 'list the current directory')]),
)
assert.equal(afterCompaction.messages.length, 2, 'a listing dropped by compaction must be re-injected')

// ---------------------------------------------------------------------------
// Case 3c — the session shape is unreadable: fail safe by injecting.
// ---------------------------------------------------------------------------

agent.session = { header: { cwd: root } }

const unknownShape = await hook.handler(
  { agent, turn: 4, step: 1, signal },
  async () => defaultDecision([realUser('u2c', 'list the current directory')]),
)
assert.equal(unknownShape.messages.length, 2, 'an unreadable session must not silently starve the model')

// ---------------------------------------------------------------------------
// Case 3d — the listing actually changed: injected again.
// ---------------------------------------------------------------------------

await writeFile(join(root, 'new-file.txt'), 'appeared\n')

const changed = await hook.handler(
  { agent, turn: 5, step: 1, signal },
  async () => defaultDecision([realUser('u2d', 'list the current directory')]),
)
assert.equal(changed.messages.length, 2, 'a changed listing must be injected again')
assert.match(changed.messages[1].content[0].text, /new-file\.txt/)

// ---------------------------------------------------------------------------
// Case 4 — another plugin's injection is never mistaken for user input.
// ---------------------------------------------------------------------------

const otherPluginOnly = await hook.handler(
  { agent, turn: 6, step: 1, signal },
  async () => defaultDecision([runtimeContext('rc2', 'someone else injected this')]),
)
assert.equal(otherPluginOnly.messages.length, 1, 'only source.kind === "user" counts as real input')

// ---------------------------------------------------------------------------
// Case 5 — failure isolation: an unreadable directory must not break the turn.
// ---------------------------------------------------------------------------

const brokenAgent = { id: 'session-2', session: { header: { cwd: join(root, 'does-not-exist') } } }
const survived = await hook.handler(
  { agent: brokenAgent, turn: 1, step: 1, signal },
  async () => defaultDecision([realUser('u9', 'whatever')]),
)
assert.equal(survived.messages.length, 1, 'a failed listing must degrade to no injection')
assert.ok(
  ctx.logs.some(([level]) => level === 'warn'),
  'the failure must be logged as a warning',
)

// ---------------------------------------------------------------------------
// Case 6 — an already-aborted signal short-circuits.
// ---------------------------------------------------------------------------

const aborted = new AbortController()
aborted.abort()
const afterAbort = await hook.handler(
  { agent, turn: 7, step: 1, signal: aborted.signal },
  async () => defaultDecision([realUser('u10', 'too late')]),
)
assert.equal(afterAbort.messages.length, 1, 'an aborted turn must not be injected into')

// ---------------------------------------------------------------------------
// Case 7 — disposition removes the listener.
// ---------------------------------------------------------------------------

assert.equal(ctx.listeners.filter((l) => l.event === 'agent/pre-step').length, 1)
dispose()
assert.equal(ctx.listeners.filter((l) => l.event === 'agent/pre-step').length, 0)

await rm(root, { recursive: true, force: true })

console.log('all checks passed')

/**
 * dsh-inject-context — a minimal "context injection" plugin for DeepSeek Harness.
 *
 * It does exactly one thing: on every `agent/pre-step`, it appends the session
 * working directory's `dir` listing as ONE standalone `user` message at the end
 * of the step's message list.
 *
 * The contract is deliberately narrow, because the surrounding machinery is
 * easy to disturb:
 *
 *   1. Exactly one hook — `agent/pre-step` (a waterfall).
 *   2. One appended `role: 'user'` message. Nothing else is touched.
 *   3. No `systemPrompt` contribution of any kind, so the request prefix
 *      (system prompt + tool schemas) is byte-identical to a run without this
 *      plugin: prompt caching is unaffected; only the message tail changes.
 *   4. No existing message is replaced, rewritten, or removed, and no other
 *      decision field changes — the receiver's object is spread, never mutated.
 *   5. Every failure (timeout, EACCES, abort, bad payload) degrades to
 *      "inject nothing". The turn must never break because of this plugin.
 *
 * Why `agent/pre-step` and not `system-prompt/assemble`?
 * In `@deepseek-ai/dsh-agent-loop`, `preStep()` calls
 * `systemPrompt.assemble()` BEFORE dispatching `agent/pre-step`, and the
 * current turn's user message is only committed as a `user/message` event
 * later, inside `step()`. So the assembled prompt cannot see this turn's input
 * at all. `agent/pre-step` is the only point that both (a) carries the raw
 * user input and (b) is awaited before the model request — which is what makes
 * "retrieve on the user's input, visible in the same turn" possible.
 *
 * @module dsh-inject-context
 */

import { createHash, randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable plugin id, matching the loader entry id in cordis.patch.yml. */
export const name = 'dsh-inject-context'

/**
 * Required services. Intentionally empty: this plugin needs no host service —
 * `ctx.on` and `ctx.logger` are always available, and it never touches
 * `systemPrompt`, `tools`, `session`, or the filesystem service.
 */
export const inject = []

/** The `source.kind` stamped on every message this plugin produces. */
const KIND = 'dsh-inject-context'

/** Fallbacks for every knob, since this package ships no Config schema. */
const DEFAULTS = Object.freeze({
  /** Entries listed before the listing is truncated. */
  maxEntries: 100,
  /** Hard cap on the injected text length, in characters. */
  maxChars: 6000,
  /** Abort the directory read after this long; 0 disables the guard. */
  timeoutMs: 3000,
  /** Skip re-injecting a listing identical to the last one for this session. */
  dedupeUnchanged: true,
  /** Include dot-files. */
  includeHidden: false,
  /** Force a directory instead of the session's own cwd (debugging aid). */
  cwdOverride: undefined,
})

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Whether a message is genuine user input rather than somebody's injection.
 *
 * Real user messages carry `source.kind === 'user'`. Injected ones carry a
 * plugin-owned kind — the harness's own dynamic context uses
 * `'runtime-context'` (see RuntimeContextProjection in dsh-agent-loop), and
 * this plugin uses {@link KIND}. Filtering on this is what keeps an injected
 * listing from being fed back into the next retrieval as if the user had
 * typed it.
 *
 * @param message - a candidate message from the step's decision.
 * @returns true only for genuine, user-authored input.
 */
function isRealUserInput(message) {
  if (!message || message.role !== 'user') return false
  const kind = message.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Concatenate every text block of a message.
 * @param message - the message to read.
 * @returns trimmed text, or `''` when the message carries no text block.
 */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Short content fingerprint, used for dedupe decisions only.
 * @param text - the text to fingerprint.
 * @returns a 16-character hex digest.
 */
function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Escape a value for use inside a double-quoted wrapper attribute.
 * @param value - the raw attribute value.
 * @returns the escaped value.
 */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Reject after `ms` unless `promise` settles first.
 *
 * The guard is mandatory rather than optional: `agent/pre-step` is awaited by
 * the loop, so anything this plugin stalls on is added directly to the turn's
 * time-to-first-token.
 *
 * @param promise - the work to bound.
 * @param ms - the budget; non-finite or non-positive disables the guard.
 * @param label - name used in the timeout error.
 * @returns the promise's value, or rejects on timeout.
 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// The injected content: a `dir` listing
// ---------------------------------------------------------------------------

/**
 * Whether a previously injected message is still on the model's surface.
 *
 * Skipping an identical re-injection is only safe while the earlier copy is
 * still visible to the model. Compaction and surface replacement can drop it,
 * and silently skipping then would starve the model of content it no longer
 * has. The harness reaches the same conclusion for its own runtime context:
 * `RuntimeContextProjection` retains a snapshot only while
 * `session.surface.nodes` still contains its seq, and re-emits otherwise.
 *
 * Fails safe by construction — this returns `true` only on a definite
 * positive, so an unknown session shape means "inject again" rather than
 * "skip". Injecting twice costs a few tokens; skipping wrongly costs the model
 * its context.
 *
 * @param session - the agent's session, when one is reachable.
 * @param messageId - the id of the message this plugin injected earlier.
 * @returns true when the message is provably still on the surface.
 */
function stillOnSurface(session, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false
  if (typeof session?.snapshotEvents !== 'function') return false
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return false
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  if (!Array.isArray(events)) return false
  const onSurface = new Set(nodes)
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event?.data?.id !== messageId) continue
    return onSurface.has(event.seq)
  }
  return false
}

/**
 * Resolve which directory to list.
 *
 * The session's own cwd is authoritative; `process.cwd()` is only a last
 * resort for payloads without a session header.
 *
 * @param agent - the agent bound to this step.
 * @param config - resolved plugin config.
 * @returns an absolute directory path.
 */
function resolveCwd(agent, config) {
  if (typeof config.cwdOverride === 'string' && config.cwdOverride.length > 0) return config.cwdOverride
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/**
 * Format a timestamp the way a directory listing prints one.
 * @param ms - epoch milliseconds.
 * @returns `YYYY-MM-DD HH:MM:SS` in local time.
 */
function formatTime(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Render the session directory's listing as the injected text.
 *
 * Directories sort first, then names case-insensitively by locale. Per-entry
 * `stat` failures keep the row with a placeholder rather than dropping it, so
 * the listing still accounts for every entry.
 *
 * @param cwd - directory to list.
 * @param config - resolved plugin config.
 * @returns the wrapper-delimited listing text.
 */
async function renderDirListing(cwd, config) {
  const dirents = await readdir(cwd, { withFileTypes: true })
  const visible = (config.includeHidden ? dirents : dirents.filter((e) => !e.name.startsWith('.'))).sort((a, b) => {
    const byKind = Number(b.isDirectory()) - Number(a.isDirectory())
    return byKind !== 0 ? byKind : a.name.localeCompare(b.name)
  })

  const total = visible.length
  const directories = visible.filter((e) => e.isDirectory()).length
  const files = total - directories
  const shown = visible.slice(0, config.maxEntries)

  const rows = []
  for (const entry of shown) {
    let timeCell = ' '.repeat(19)
    let sizeCell = '            ?'
    try {
      const info = await stat(join(cwd, entry.name))
      timeCell = formatTime(info.mtimeMs)
      sizeCell = entry.isDirectory() ? '       <DIR>' : String(info.size).padStart(12)
    } catch {
      // Raced away, or unreadable. Keep the row; the name still matters.
    }
    rows.push(`${timeCell} ${sizeCell}  ${entry.name}${entry.isDirectory() ? '\\' : ''}`)
  }

  const footer =
    total > shown.length
      ? `... (${total - shown.length} more not shown)\n`
      : ''

  const body = [
    ` Directory of ${cwd}`,
    '',
    ...rows,
    ...(footer ? ['', footer.trimEnd()] : []),
    '',
    `(${total} entries: ${directories} directories, ${files} files${
      total > shown.length ? `; showing first ${shown.length}` : ''
    })`,
  ].join('\n')

  // The wrapper is fixed prose so that repeated injections differ only in the
  // listing body — the cached request prefix stays intact.
  const text = [
    `<directory-listing cwd="${escapeAttribute(cwd)}" entries="${total}">`,
    body,
    '</directory-listing>',
  ].join('\n')

  return text.length > config.maxChars ? `${text.slice(0, config.maxChars)}\n... [truncated by dsh-inject-context]` : text
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the injection hook.
 *
 * @param ctx - the Cordis context owning this plugin.
 * @param rawConfig - optional raw config object (no schema is enforced).
 * @returns an effect disposer that unregisters both listeners.
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }

  /**
   * Per-session dedupe ledger.
   *
   * `agent/pre-step` runs once per step of every turn, so without this every
   * tool-call round trip would re-inject the same listing. Bounded by the
   * number of live agents: entries are dropped when their agent is disposed.
   *
   * @type {Map<string, { turn: number; queryHash: string; textHash?: string; messageId?: string }>}
   */
  const ledger = new Map()

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) ledger.delete(agent.id)
  })

  // Registered with `prepend: true`, which makes this listener the OUTERMOST
  // one in the waterfall: it awaits `next()` — every other plugin's listener,
  // plus the harness default — and only then appends. Other plugins therefore
  // never observe this message as part of their own input, and their decisions
  // are taken verbatim.
  const dispose = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()

      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        if (payload?.signal?.aborted) return decision

        // Gate 1 — only genuine user input triggers a listing. A step that
        // only continues after tool calls claims nothing and is skipped.
        const fresh = decision.messages.filter(isRealUserInput)
        if (fresh.length === 0) return decision

        const query = fresh
          .map(textOf)
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 2000)
        if (query.length === 0) return decision

        // Gate 2 — one injection per (session, turn, input).
        const sessionId = payload.agent?.id ?? '(unknown)'
        const queryHash = fingerprint(query)
        const previous = ledger.get(sessionId)
        if (previous && previous.turn === payload.turn && previous.queryHash === queryHash) return decision

        // Gate 3 — the work itself, bounded in time.
        const cwd = resolveCwd(payload.agent, config)
        const text = await withTimeout(renderDirListing(cwd, config), config.timeoutMs, 'directory listing')
        if (typeof text !== 'string' || text.length === 0) return decision

        // Gate 4 — an identical listing is already in this session's history AND
        // still visible to the model, so re-sending it would spend tokens to say
        // nothing new. If it has fallen off the surface, fall through and inject.
        const textHash = fingerprint(text)
        if (
          config.dedupeUnchanged &&
          previous?.textHash === textHash &&
          stillOnSurface(payload.agent?.session, previous.messageId)
        ) {
          ledger.set(sessionId, { turn: payload.turn, queryHash, textHash, messageId: previous.messageId })
          return decision
        }

        /**
         * The injected message.
         *
         * `id` is REQUIRED: the session's `assertMessageEventShape` rejects a
         * persisted event whose message lacks a non-empty string id.
         *
         * `source.kind` is free-form for user messages — only system, assistant
         * and tool messages have pinned kinds — and it is what makes this
         * message render as injected context rather than as something the user
         * typed. `dsh-client-ui-chat` classifies every durable `user/message`
         * by exactly this field: `source.kind === 'user'` becomes a user (or
         * steering) row, and ANY other value is routed through
         * `contextMessage()` — "Context presentation shared by user-role
         * injections and developer messages" — producing a `context` row whose
         * producer label is the kind itself (`contextProducer()` falls through
         * to `{ role: 'inject', label: kind }`). The harness's own
         * `runtime-context` snapshot takes the same path.
         *
         * `source.form = 'snapshot'` selects one of the structurally presented
         * forms the client knows (`instructions`, `catalog`, `snapshot`,
         * `notice`, `relay`, `recall`); any other or absent value stays opaque.
         * A directory listing is a snapshot.
         *
         * Content holds text blocks only: `tool-addition` / `tool-removal`
         * blocks are rejected outside developer-role messages.
         */
        const message = {
          id: randomUUID(),
          role: 'user',
          source: { kind: KIND, form: 'snapshot', provider: 'dir', cwd },
          content: [{ type: 'text', text }],
        }

        ledger.set(sessionId, { turn: payload.turn, queryHash, textHash, messageId: message.id })
        ctx.logger?.info?.(
          `${name}: injected ${text.length} chars of directory listing into ${sessionId} (turn ${payload.turn}, step ${payload.step})`,
        )

        // Spread, never mutate: every other field of the decision — including
        // `startsRequestSeries` — passes through untouched.
        return { ...decision, messages: [...decision.messages, message] }
      } catch (error) {
        ctx.logger?.warn?.(`${name}: skipped injection (${String(error)})`)
        return decision
      }
    },
    { prepend: true },
  )

  return dispose
}

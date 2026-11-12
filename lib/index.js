/**
 * dsh-inject-context — the injection point for DeepSeek Harness.
 *
 * This plugin is the one place that puts text in front of the model. It owns no
 * data of its own except user tips: it collects from the plugins that do own
 * data and writes the answer into the turn.
 *
 * On every `agent/pre-step` it takes the turn's genuine user input, asks each
 * **injection source** for a ready-to-wrap body, and inserts **one** standalone
 * `user` message **directly below the user's question**. That message carries a
 * single `<user-reminder> … </user-reminder>` envelope, and the blocks sit
 * inside it as siblings in source order — one fence, not one per block, so the
 * model reads a single "this is injected context, not the user speaking" region
 * no matter how many subsystems contributed to it.
 *
 * The sources, in insertion order:
 *
 * | id          | content                                   | owned by           |
 * |-------------|-------------------------------------------|--------------------|
 * | `skillList` | `<shell_skills>` list                     | `dsh-shell-skills` |
 * | `ovProfile` | `<openviking_index>` block (backend-rendered) | `dsh-openviking` |
 * | `ov`        | `<openviking>` block (backend-rendered)   | `dsh-openviking`   |
 * | `userTips`  | `<user_tips>`                             | this plugin        |
 * | `userWarning` | `<user_warning>`                        | event-fed          |
 *
 * The OpenViking half lives in `dsh-openviking`, which publishes the
 * `openviking` Cordis service (`find()` / `profile()`). This plugin asks for it
 * on every step rather than at mount, so either load order works, and a
 * deployment without that plugin simply recalls nothing.
 *
 * The contract is deliberately narrow, because the surrounding machinery is
 * easy to disturb:
 *
 *   1. Exactly one hook — `agent/pre-step` (a waterfall), plus one intake
 *      listener for runtime warnings.
 *   2. Only `role: 'user'` messages are inserted; no existing message is
 *      rewritten or removed — the receiver's object is spread, never mutated.
 *   3. Nothing is inserted above the user's question, and no `systemPrompt`
 *      contribution of any kind exists, so the request prefix (system prompt +
 *      tool schemas) is byte-identical to a run without this plugin: prompt
 *      caching is unaffected; only the message tail changes.
 *   4. Every failure (timeout, HTTP error, abort, bad payload, missing plugin)
 *      degrades to "inject nothing" for that source. The turn must never break
 *      because of this plugin.
 *
 * Why `agent/pre-step` and not `system-prompt/assemble`?
 * In `@deepseek-ai/dsh-agent-loop`, `preStep()` calls
 * `systemPrompt.assemble()` BEFORE dispatching `agent/pre-step`, and the
 * current turn's user message is only committed as a `user/message` event later,
 * inside `step()`. So the assembled prompt cannot see this turn's input at all.
 * `agent/pre-step` is the only point that both (a) carries the raw user input
 * and (b) is awaited before the model request — which is what makes "retrieve on
 * the user's input, visible in the same turn" possible.
 *
 * @module dsh-inject-context
 */

import { createHash } from 'node:crypto'

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/** Stable plugin id, matching the loader entry id in cordis.patch.yml. */
export const name = 'dsh-inject-context'

/**
 * Required services. Intentionally empty: `ctx.on`, `ctx.logger` and `ctx.get`
 * are always available, and every other service (`shellSkills`, `openviking`)
 * is looked up opportunistically per step so a missing plugin degrades to
 * "inject nothing" instead of keeping this one pending.
 */
export const inject = []

/**
 * The plugin's configuration.
 *
 * The volatile block is the settings card: the master switch plus one switch
 * per injected block (`ovEnabled` / `skillList` / `userTipsEnabled`), so each
 * block can be turned off from the Plugins page without editing a profile
 * patch.
 *
 * `.volatile()` marks a field as a live, user-scoped setting: only volatile
 * fields reach the settings page — `@deepseek-ai/dsh-settings` states plainly
 * that "forms expose only volatile fields from active, uniquely addressed
 * profile entries" — and they arrive at `apply` as live references rather than
 * plain values, so this half reads them through {@link readConfig}. A volatile
 * field can also be replaced while the plugin is mounted, which is what lets
 * the card edit them without a restart.
 *
 * Everything else is ordinary configuration: invisible to any form, edited only
 * in the profile's Cordis patch. Operational tuning lives there because nobody
 * needs a form to change a timeout. Keys carry no dots — `SettingsFormModel`
 * can only address top-level fields, and a dotted literal is re-read as a
 * nested path when the profile patch is written back.
 */
export const Config = z.object({
  /** Master switch for the whole plugin. */
  enabled: z.boolean().default(true).volatile(),

  // --- One switch per injected block (the card's sub-toggles) ---
  /** Inject recalled OpenViking memories (`ov` + `ovProfile` sources). */
  ovEnabled: z.boolean().default(true).volatile(),
  /**
   * Inject the skill catalog read from the skill runtime.
   *
   * On by default because this plugin is the deployment's insertion point. The
   * catalog rides its own `<shell_skills>` envelope, so it complements the
   * harness `tool-skill` catalog rather than competing with it — both can be
   * loaded without either side shadowing the other.
   */
  skillList: z.boolean().default(true).volatile(),
  /** Inject the per-session `<user_tips>` block. */
  userTipsEnabled: z.boolean().default(true).volatile(),
  /**
   * Text injected once per session as `<user_tips>`.
   *
   * The `user_tips` / `USER_TIPS` environment variable is the fallback, which
   * lets an API gateway pass channel-specific guidance (for example "this
   * message came from QQ, answer with the QQ tool") without a config edit.
   */
  userTips: z.string().default('').volatile(),
  /** Inject the session memory index before the first recall (`ovProfile`). */
  ovProfile: z.boolean().default(false).volatile(),

  // --- OpenViking — read through `dsh-openviking` (profile patch only) ---
  /** Cordis service name of the memory backend. */
  ovService: z.string().default('openviking'),
  /**
   * Recall again on tool-continuation steps.
   *
   * A step that only continues after tool calls carries no fresh user input, but
   * it does carry new evidence: the tool result. Enabling this rebuilds the
   * query from the turn's user text plus that result, matching the "step" recall
   * mode of the sibling shell-tool implementation.
   */
  ovStepRecall: z.boolean().default(false),
  /** Character budget for a step query built from user text and tool output. */
  ovStepQueryChars: z.number().step(1).min(0).default(2000),

  // --- External skill catalog (`skill*`) — read from another plugin ---
  /** Cordis service name holding the skill provider (`{ list() }`). */
  skillService: z.string().default('shellSkills'),
  /** How many skills the catalog may list. */
  skillListLimit: z.number().step(1).min(1).default(50),
  /** Character budget for the catalog block; 0 keeps it whole. */
  skillListChars: z.number().step(1).min(0).default(4000),

  // --- Runtime warnings (`userWarning`) ---
  /**
   * Accept warnings emitted through {@link WARNING_EVENT}.
   *
   * The intake is live; the *producer* is not. The intended producer is a skill
   * script's own warning path (a tool round that ran out of budget, a retry that
   * was needed), and the trigger conditions for it are deferred: nothing in the
   * tree emits the event yet. The queue, the drain-once rule and the message
   * shape are kept so the producer only has to `ctx.emit` when it lands.
   */
  userWarning: z.boolean().default(true),

  // Ordinary configuration — edited in the Cordis patch, never in a form.
  /** Hard cap on each injected message's length, in characters. */
  maxChars: z.number().step(1).min(1).default(6000),
  /**
   * Hard cap on everything this plugin injects into one step, in characters.
   * 0 disables the cap. Sources are served in registry order, so the earliest
   * source wins the budget when it runs short.
   */
  totalMaxChars: z.number().step(1).min(0).default(0),
  /** Abort a source's collection after this long; 0 disables the guard. */
  timeoutMs: z.number().step(1).min(0).default(3000),
  /** Skip re-injecting results identical to the last ones for this session. */
  dedupeUnchanged: z.boolean().default(true),
})

/** The `source.kind` stamped on every message this plugin produces. */
const KIND = 'dsh-inject-context'

/** Wrapper every injected block carries; the model-facing "not the user" fence. */
const REMINDER_OPEN = '<user-reminder>'
const REMINDER_CLOSE = '</user-reminder>'

/** Marker that opens the session memory index. */
const PROFILE_MARKER = '## 🧠 记忆索引'

/**
 * Marker that opens the skill catalog block; also its "already delivered" flag.
 *
 * Deliberately not `<available_skills>`: the harness `tool-skill` plugin owns
 * that envelope. A distinct envelope keeps both catalogs parallel — the model
 * receives this runtime's skills alongside the built-in ones, and neither
 * source can shadow or rewrite the other's block.
 */
const SKILL_BLOCK_OPEN = '<shell_skills>'
const SKILL_BLOCK_CLOSE = '</shell_skills>'

/** Marker that opens the per-session user-tips block; also its delivery flag. */
const USER_TIPS_OPEN = '<user_tips>'
const USER_TIPS_CLOSE = '</user_tips>'

/** Marker that opens a runtime warning block. */
const USER_WARNING_OPEN = '<user_warning>'
const USER_WARNING_CLOSE = '</user_warning>'

/**
 * Cordis event another plugin emits to queue a warning for the next step.
 *
 * Payload: `{ agent, text }` (`agentId` is accepted as a fallback). The queue
 * is drained by the next `agent/pre-step`, so a warning is injected exactly once
 * and never replayed from memory.
 */
export const WARNING_EVENT = 'dsh-inject-context/warning'

/** Service name assumed when `skillService` names none. */
const DEFAULT_SKILL_SERVICE = 'shellSkills'

/** Service name assumed when `ovService` names none. */
const DEFAULT_OV_SERVICE = 'openviking'

/** Copy that introduces the catalog, matching the harness skill catalog. */
const SKILL_HINT = 'A skill is a reusable set of task-specific instructions. The shell-skills runtime publishes the following extra skills, in parallel with the built-in skill catalog:'

// ---------------------------------------------------------------------------
// Configuration access
// ---------------------------------------------------------------------------

/**
 * Read one configuration value.
 *
 * A `.volatile()` field arrives as a live reference — the settings service can
 * replace its value without remounting the plugin — so the value sits behind
 * `.get()`. An ordinary field arrives as a plain value. Reading every field
 * through this helper keeps both shapes working and always observes the current
 * value, so a settings edit applies from the next turn.
 *
 * @param config - the resolved plugin configuration.
 * @param key - field name.
 * @param fallback - value used when the field is absent, null, or undefined.
 * @returns the current value, or `fallback`.
 */
function readConfig(config, key, fallback) {
  const field = config?.[key]
  let value = field
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try {
      value = field.get()
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/**
 * Look up an optional Cordis service without throwing.
 * @param ctx - the plugin's Cordis context.
 * @param serviceName - the name to resolve.
 * @returns the service, or undefined when it is not mounted.
 */
function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * The OpenViking service, when one is mounted and configured.
 *
 * Shape-checked rather than trusted: a deployment may publish a different
 * object under the same name, and a missing `find` must read as "no memories"
 * instead of throwing every step.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - the resolved plugin configuration.
 * @returns the service, or undefined when it cannot serve this turn.
 */
function openvikingService(ctx, config) {
  const serviceName = String(readConfig(config, 'ovService', DEFAULT_OV_SERVICE)).trim() || DEFAULT_OV_SERVICE
  const service = optionalService(ctx, serviceName)
  if (service === undefined || service === null || typeof service.find !== 'function') return undefined
  if (typeof service.status === 'function') {
    try {
      if (service.status()?.configured === false) return undefined
    } catch {
      return undefined
    }
  }
  return service
}

// ---------------------------------------------------------------------------
// Source adapters
// ---------------------------------------------------------------------------

/**
 * A context source. Registering one in {@link SOURCES} is all it takes to add
 * an injection source to the channel; everything else (gating, dedupe,
 * fail-isolation, message construction) is shared.
 *
 * @typedef {object} InjectionSource
 * @property {string} id - stable id; also the config key prefix of its settings.
 * @property {string} provider - the subsystem this block's data comes from. Kept
 *   as block metadata: the merged message reports the block list in its summary
 *   rather than naming one provider.
 * @property {string} form - the form this block would carry on its own (one of
 *   the client's known forms: `instructions` / `catalog` / `snapshot` /
 *   `notice` / `relay` / `recall`). The merged message itself is a `notice`,
 *   so this is descriptive: it records what kind of content the block is.
 * @property {(config) => boolean} enabled - whether this source runs this turn.
 * @property {(ctx, args) => Promise<string>} collect - return the block body
 *   WITHOUT an envelope (the channel wraps the assembled body once), or `''`
 *   when there is nothing to inject. May throw; the channel catches and
 *   degrades.
 */

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Wrap the assembled reminder body in `<user-reminder>`.
 *
 * This runs exactly once per step, over every block at once: sources return
 * bare bodies, and this is the single fence the model sees around all of them.
 * An empty body yields an empty string rather than an empty fence.
 *
 * @param body - the assembled body (one or more blocks, joined).
 * @returns the wrapped, injectable text.
 */
function wrapReminder(body) {
  const trimmed = typeof body === 'string' ? body.trim() : ''
  return trimmed.length === 0 ? '' : `${REMINDER_OPEN}\n${trimmed}\n${REMINDER_CLOSE}`
}

/**
 * Whether a message is genuine user input rather than somebody's injection.
 *
 * Real user messages carry `source.kind === 'user'`. Injected ones carry a
 * plugin-owned kind — the harness's own dynamic context uses
 * `'runtime-context'` (see RuntimeContextProjection in dsh-agent-loop), and
 * this plugin uses {@link KIND}. Filtering on this is what keeps an injected
 * block from being fed back into the next retrieval as if the user had typed it.
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
 * Coerce a value to a finite number, defaulting to 0.
 * @param value - the candidate.
 * @returns the number, or 0.
 */
function asNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Reject after `ms` unless `promise` settles first.
 *
 * The guard is mandatory rather than optional: `agent/pre-step` is awaited by
 * the loop, so anything a source stalls on is added directly to the turn's
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

/**
 * Cut a string to `max` characters, marking the cut.
 * @param text - the text to cut.
 * @param max - the budget; non-finite or non-positive keeps the text whole.
 * @returns the text, or a marked prefix of it.
 */
function capText(text, max) {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max)}\n... [truncated by dsh-inject-context]`
}

/**
 * Cut a string to `max` characters, marking the cut with an ellipsis.
 * @param text - the text to cut.
 * @param max - the budget; non-finite or non-positive keeps the text whole.
 * @returns the text, or a marked prefix of it.
 */
function clip(text, max) {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Pair the turn's cancellation with a per-source deadline.
 *
 * `withTimeout` only stops waiting; this signal also aborts the request itself,
 * so a source that timed out does not keep a socket busy after the step moved
 * on. `AbortSignal.any` is available on every supported Node version; when it
 * is missing, the turn signal alone is used and `withTimeout` still bounds the
 * wait.
 *
 * @param signal - the turn's cancellation signal.
 * @param ms - the source budget; non-finite or non-positive disables the deadline.
 * @returns the signal to hand the source.
 */
function sourceSignal(signal, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return signal
  const deadline = AbortSignal.timeout(ms)
  if (signal === undefined || signal === null) return deadline
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : signal
}

/**
 * Read the session's durable event log, or `undefined` when the shape is not
 * readable.
 *
 * Every reader below fails safe by injecting again: a session this plugin
 * cannot inspect must never make the model silently lose context.
 *
 * @param session - the agent's session, when one is reachable.
 * @returns the event list, or undefined.
 */
function sessionEvents(session) {
  if (typeof session?.snapshotEvents !== 'function') return undefined
  try {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : undefined
  } catch {
    return undefined
  }
}

/**
 * The event sequences still visible to the model.
 * @param session - the agent's session.
 * @returns the surface sequence set, or undefined when unreadable.
 */
function surfaceSeqs(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? new Set(nodes) : undefined
}

/**
 * Whether an identical injected block is already on the model's surface.
 *
 * The per-process ledger skips work within one process; this log-derived answer
 * is what makes dedupe survive a restart. Several blocks now share one message,
 * so the test is containment rather than equality: an injected message whose
 * text includes `blockText`, and whose event is still on the surface, is proof
 * that this exact block is visible. Compaction may have dropped it, in which
 * case the block must be sent again — re-injecting costs a few tokens, while
 * skipping wrongly costs the model its context.
 *
 * @param session - the agent's session.
 * @param blockText - the block body about to be injected.
 * @returns true only when the same text is provably still visible.
 */
function injectedContains(session, blockText) {
  if (typeof blockText !== 'string' || blockText.length === 0) return false
  const events = sessionEvents(session)
  if (events === undefined) return false
  const onSurface = surfaceSeqs(session)
  if (onSurface === undefined) return false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== KIND) continue
    if (!onSurface.has(event.seq)) continue
    if (textOf(event.data).includes(blockText)) return true
  }
  return false
}

/**
 * Whether this session already carries a block with `marker` from this plugin.
 *
 * Session-level blocks (the memory index, the skill catalog, user tips) use
 * their opening marker as the delivery flag. The answer comes from the durable
 * log rather than process memory, so a resumed session does not receive the same
 * block twice. An unreadable session answers `false`, which injects again: a
 * duplicate costs tokens, while a missing session-level block can leave the
 * model without guidance it was supposed to have.
 *
 * Only this plugin's own messages count (`source.kind === KIND`), so a block
 * another plugin happens to write with the same marker is not mistaken for ours.
 *
 * @param session - the agent's session.
 * @param marker - opening marker of the block.
 * @returns true when an injected block already carries the marker.
 */
function sessionHasMarker(session, marker) {
  if (typeof marker !== 'string' || marker.length === 0) return false
  const events = sessionEvents(session)
  if (events === undefined) return false
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== KIND) continue
    if (textOf(event.data).includes(marker)) return true
  }
  return false
}

/**
 * Read this turn's user text and tool results.
 *
 * A tool-continuation step claims no new user message, but the tool result is
 * the only new evidence in the turn — so that is what a step recall queries on.
 *
 * @param session - the agent's session.
 * @returns the turn's user text and tool-result text, in order.
 */
function readTurnTexts(session) {
  const events = sessionEvents(session)
  if (events === undefined) return { user: '', tools: '' }
  const userParts = []
  const toolParts = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    // Turn numbers increase monotonically, so the first boundary reached while
    // walking backwards is this turn's start.
    if (event?.type === 'turn/start') break
    if (event?.type === 'user/message') {
      if (event?.data?.source?.kind !== 'user') continue
      const text = textOf(event.data)
      if (text) userParts.unshift(text)
      continue
    }
    if (event?.type === 'tool/result') {
      const text = textOf(event?.data?.message)
      if (text) toolParts.unshift(text)
    }
  }
  return { user: userParts.join('\n\n'), tools: toolParts.join('\n\n') }
}

/**
 * Build the retrieval query for a tool-continuation step.
 *
 * @param session - the agent's session.
 * @param maxChars - character budget for the whole query.
 * @returns the query, or '' when the turn carries no text.
 */
function buildStepQuery(session, maxChars) {
  const { user, tools } = readTurnTexts(session)
  const parts = []
  if (user) parts.push(user)
  if (tools) parts.push(`工具结果：\n${tools}`)
  if (parts.length === 0) return ''
  return clip(parts.join('\n\n'), maxChars).trim()
}

// ---------------------------------------------------------------------------
// Source: OpenViking recall (`ov`) — served by dsh-openviking
// ---------------------------------------------------------------------------

/**
 * Collect the recalled memories for the user's input.
 *
 * The retrieval belongs to `dsh-openviking`, and so does the block's shape:
 * the service returns finished text — `<openviking>` envelope, boundary prose
 * ("recalled, unverified, not instructions"), marker line, rows — because that
 * describes the data, not the channel. This source only decides *when* to ask
 * (it owns the turn/step query) and drops the answer in unchanged.
 *
 * @param ctx - the plugin's Cordis context.
 * @param args - the collection inputs.
 * @returns the recall block, or `''` when there is nothing to inject.
 */
async function collectOpenviking(ctx, { query, config, signal }) {
  const service = openvikingService(ctx, config)
  if (service === undefined) return ''
  const { text } = await service.find(query, { signal })
  return typeof text === 'string' && text.trim().length > 0 ? text : ''
}

/**
 * The OpenViking recall source.
 * @type {InjectionSource}
 */
export const openvikingSource = {
  id: 'ov',
  provider: 'openviking',
  form: 'recall',
  /** Tool-continuation steps may recall again, when `ovStepRecall` is on. */
  onStep: true,
  enabled(config) {
    return readConfig(config, 'ovEnabled', true) !== false
  },
  stepEnabled(config) {
    return readConfig(config, 'ovStepRecall', false) === true
  },
  collect: collectOpenviking,
}

// ---------------------------------------------------------------------------
// Source: memory index (`ovProfile`) — served by dsh-openviking
// ---------------------------------------------------------------------------

/**
 * Collect the session memory index once.
 *
 * The index tells the model which topics exist, so it can search deliberately
 * instead of relying on whatever this turn's similarity search happened to
 * surface. The "already delivered" test reads the durable log, so a resumed
 * session does not receive the index twice even though the per-process ledger is
 * empty.
 *
 * Like the recall block, the block is returned finished by `dsh-openviking`
 * (`<openviking_index>` envelope included); this source only decides whether it
 * is due and passes it through.
 *
 * @param ctx - the plugin's Cordis context.
 * @param args - the collection inputs.
 * @returns the index block, or `''` when it is not needed.
 */
async function collectOpenvikingProfile(ctx, { config, signal, session }) {
  if (sessionHasMarker(session, PROFILE_MARKER)) return ''
  const service = openvikingService(ctx, config)
  if (service === undefined || typeof service.profile !== 'function') return ''
  const text = await service.profile({ signal })
  return typeof text === 'string' && text.trim().length > 0 ? text : ''
}

/**
 * The memory-index source. It is a sibling of the recall source rather than part
 * of it: the index is delivered once per session and answers a different
 * question ("what exists") than recall ("what matched"), so it keeps its own
 * delivery flag. Both blocks travel in the same reminder and are separated by
 * their own markers.
 *
 * @type {InjectionSource}
 */
export const openvikingProfileSource = {
  id: 'ovProfile',
  provider: 'openviking',
  form: 'catalog',
  enabled(config) {
    return readConfig(config, 'ovEnabled', true) !== false && readConfig(config, 'ovProfile', false) === true
  },
  collect: collectOpenvikingProfile,
}

// ---------------------------------------------------------------------------
// Source: skill catalog (`skillList`) — reads another plugin's provider
// ---------------------------------------------------------------------------

/** Cap on a catalog line's description: the list is a pointer, not a manual. */
const DESCRIPTION_MAX_CHARS = 200

/**
 * Reduce a provider's description to the single line the catalog promises.
 *
 * The rule is "one sentence": the first non-empty line, whitespace collapsed,
 * capped. `dsh-shell-skills` ships a one-line `# description:` header, so this
 * is a no-op for the normal provider — it exists because the catalog is a
 * *pointer*, not a manual. A provider that appended its `# usage:` block (or
 * arguments, or examples) after the description would otherwise spill all of
 * that into every session's prompt; showing usage is the `shell_skill` tool's
 * job, on demand. Anything past the first line is therefore dropped here, not
 * rendered.
 *
 * @param value - the provider's description, of any shape.
 * @returns one trimmed line, capped.
 */
function oneLine(value) {
  if (typeof value !== 'string') return ''
  const first = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (first === undefined) return ''
  const flat = first.replace(/\s+/g, ' ')
  return flat.length > DESCRIPTION_MAX_CHARS ? `${flat.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : flat
}

/**
 * Normalize a skill provider's answer into catalog entries.
 *
 * Accepted shapes: an array, `{ entries }`, or `{ skills }`; an item may be a
 * bare name or `{ name, description }`. The provider decides which skills are
 * installed and enabled — this plugin only renders what it is handed, so the
 * skill runtime stays the single owner of install/enable state.
 *
 * Only the name and a one-line description are read. A provider's `usage` (or
 * any other field) is deliberately dropped: the two halves split here — this
 * plugin says *which* skills exist, the `shell_skill` tool says *how* to call
 * them.
 *
 * @param value - the provider's answer.
 * @returns normalized entries in provider order.
 */
function skillEntriesOf(value) {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(value?.entries)
      ? value.entries
      : Array.isArray(value?.skills)
        ? value.skills
        : []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const entryName = item.trim()
      if (entryName.length > 0) out.push({ name: entryName, description: '' })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const entryName = typeof item.name === 'string' ? item.name.trim() : ''
    if (entryName.length === 0) continue
    out.push({ name: entryName, description: oneLine(item.description) })
  }
  return out
}

/**
 * Render the `<shell_skills>` catalog body.
 *
 * One line per skill: the name and its one-sentence description. Nothing
 * about arguments, usage or execution appears here — a reader that wants that
 * calls the `shell_skill` tool, which is where the skill runtime keeps it.
 *
 * @param entries - normalized entries.
 * @param maxChars - character budget; 0 keeps the block whole.
 * @returns the catalog text.
 */
function renderSkillCatalog(entries, maxChars) {
  const lines = [SKILL_HINT, SKILL_BLOCK_OPEN]
  for (const entry of entries) {
    lines.push(entry.description ? `- \`${entry.name}\`: ${entry.description}` : `- \`${entry.name}\``)
  }
  lines.push(SKILL_BLOCK_CLOSE)
  return clip(lines.join('\n'), maxChars)
}

/**
 * Collect the skill catalog from the provider service.
 *
 * The interaction with `dsh-shell-skills` is exactly one call: `list()`, whose
 * contract is the install/enable-filtered set of `{ name, description }`. It
 * never calls `get()`, whose answer carries the usage body — how to call a
 * skill is the `shell_skill` tool's business, shown on demand, not something
 * every session should carry up front.
 *
 * Published once per session: the provider is read on the first eligible step,
 * so a skill installed later is picked up by the next session. The catalog is a
 * session block, not a per-step refresh — rewriting it mid-session would churn
 * the already-sent history.
 *
 * @param ctx - the plugin's Cordis context (also holds the provider service).
 * @param args - the collection inputs.
 * @returns the catalog text, or '' when there is no provider.
 */
async function collectSkillCatalog(ctx, { config, signal, session, agent }) {
  if (sessionHasMarker(session, SKILL_BLOCK_OPEN)) return ''
  const serviceName = String(readConfig(config, 'skillService', DEFAULT_SKILL_SERVICE)).trim() || DEFAULT_SKILL_SERVICE
  const provider = optionalService(ctx, serviceName)
  if (provider === undefined || provider === null || typeof provider.list !== 'function') return ''
  const limit = Math.max(1, Math.floor(asNumber(readConfig(config, 'skillListLimit', 50))))
  const entries = skillEntriesOf(await provider.list({ agent, signal })).slice(0, limit)
  if (entries.length === 0) return ''
  return renderSkillCatalog(entries, asNumber(readConfig(config, 'skillListChars', 4000)))
}

/**
 * The skill-catalog source.
 *
 * On by default: this plugin is the deployment's insertion point, so the catalog
 * belongs here. It uses its own `<shell_skills>` envelope, so the harness
 * `tool-skill` catalog can coexist — the two blocks are delivered side by side
 * and stay distinguishable.
 *
 * @type {InjectionSource}
 */
export const skillListSource = {
  id: 'skillList',
  provider: 'skills',
  form: 'catalog',
  enabled(config) {
    return readConfig(config, 'skillList', true) !== false
  },
  collect: collectSkillCatalog,
}

// ---------------------------------------------------------------------------
// Source: user tips (`userTips`) — once per session
// ---------------------------------------------------------------------------

/**
 * The user-tips text: configuration first, then the `user_tips` environment
 * variable (the convention an API gateway uses to pass channel guidance, e.g.
 * "this message came from QQ, answer with the QQ tool").
 *
 * @param config - the resolved plugin configuration.
 * @returns the trimmed tips, or ''.
 */
function userTipsText(config) {
  const configured = String(readConfig(config, 'userTips', '') ?? '').trim()
  if (configured.length > 0) return configured
  return String(process.env.user_tips ?? process.env.USER_TIPS ?? '').trim()
}

/**
 * Collect the per-session user-tips block.
 * @param ctx - the plugin's Cordis context.
 * @param args - the collection inputs.
 * @returns the tips body (no envelope), or '' when there are no tips or they were delivered.
 */
async function collectUserTips(ctx, { config, session }) {
  if (sessionHasMarker(session, USER_TIPS_OPEN)) return ''
  const text = userTipsText(config)
  return text.length > 0 ? `${USER_TIPS_OPEN}\n${text}\n${USER_TIPS_CLOSE}` : ''
}

/**
 * The per-session user-tips source.
 * @type {InjectionSource}
 */
export const userTipsSource = {
  id: 'userTips',
  provider: 'session',
  form: 'instructions',
  enabled(config) {
    return readConfig(config, 'userTipsEnabled', true) !== false && userTipsText(config).length > 0
  },
  collect: collectUserTips,
}

// ---------------------------------------------------------------------------
// Runtime warnings — an event-fed source
// ---------------------------------------------------------------------------

/**
 * Create the runtime-warning source and its queue.
 *
 * Warnings are not configuration: another plugin emits {@link WARNING_EVENT}
 * with `{ agent, text }` when something worth telling the model happens (a skill
 * script hit a budget, a retry was needed). The queue is drained by the next
 * pre-step, so a warning is injected once, only into that agent, and is never
 * replayed after a restart.
 *
 * The auto-trigger half — inspecting tool results after a step and raising a
 * warning from them — is deliberately NOT implemented. The intake, the queue
 * and the message shape are in place so the producer (a skill script's warning
 * path) only has to emit the event once its trigger conditions are settled.
 *
 * @param queue - agent id → pending warnings; defaults to a fresh map.
 * @returns the source plus the queue's mutators.
 */
export function createUserWarningSource(queue = new Map()) {
  const source = {
    id: 'userWarning',
    provider: 'runtime',
    form: 'notice',
    /** A warning usually follows a tool round, so it may join step mode too. */
    onStep: true,
    stepEnabled: () => true,
    enabled: () => true,
    /** The one-line account a `notice` carries; the builder bounds it. */
    summary: (text) => String(text ?? ''),
    collect: async (ctx, { agent }) => {
      const agentId = agent?.id
      if (agentId === undefined) return ''
      const pending = queue.get(agentId)
      if (!Array.isArray(pending) || pending.length === 0) return ''
      queue.delete(agentId)
      return `${USER_WARNING_OPEN}\n${pending.join('\n')}\n${USER_WARNING_CLOSE}`
    },
  }
  return {
    source,
    queue,
    /**
     * Queue one warning for an agent's next step.
     * @param agentId - the target agent id.
     * @param text - the warning text.
     */
    push(agentId, text) {
      const id = String(agentId ?? '').trim()
      const value = String(text ?? '').trim()
      if (id.length === 0 || value.length === 0) return
      const pending = queue.get(id)
      if (Array.isArray(pending)) pending.push(value)
      else queue.set(id, [value])
    },
    /**
     * Drop an agent's pending warnings.
     * @param agentId - the target agent id.
     */
    clear(agentId) {
      queue.delete(String(agentId ?? ''))
    },
  }
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

/**
 * Validate a source adapter.
 *
 * Publishes the shape a companion plugin must implement: `id` / `provider` /
 * `form` strings, plus `enabled(config)` and `collect(ctx, args)`. `collect`
 * returns a bare block body — the channel owns the single `<user-reminder>`
 * envelope around the assembled body. An optional `onStep` +
 * `stepEnabled(config)` pair lets the source join tool-continuation steps.
 *
 * @param source - the candidate adapter.
 * @returns the same adapter, validated.
 * @throws when a required field is missing or the wrong type.
 */
export function defineSource(source) {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('defineSource: expected an object')
  }
  for (const field of ['id', 'provider', 'form']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      throw new TypeError(`defineSource: ${field} must be a non-empty string`)
    }
  }
  if (typeof source.enabled !== 'function') throw new TypeError('defineSource: enabled must be a function')
  if (typeof source.collect !== 'function') throw new TypeError('defineSource: collect must be a function')
  return source
}

/**
 * Register an injection source for every mount of this plugin.
 *
 * The registry is module state, so a companion plugin can register at load time
 * and the source keeps working across a plugin remount. The returned disposer
 * removes it.
 *
 * @param source - the adapter to register.
 * @returns a disposer that unregisters it.
 */
export function registerSource(source) {
  const defined = defineSource(source)
  if (SOURCES.includes(defined)) return () => {}
  SOURCES.push(defined)
  let released = false
  return () => {
    if (released) return
    released = true
    const index = SOURCES.indexOf(defined)
    if (index >= 0) SOURCES.splice(index, 1)
  }
}

/**
 * The registered injection sources, in insertion order.
 *
 * The skill catalog comes first, then the two OpenViking blocks (index before
 * recall, so the model reads "what exists" before "what matched"), and user tips
 * last. A runtime warning is instance-owned and appended by the channel.
 *
 * @type {InjectionSource[]}
 */
export const SOURCES = [skillListSource, openvikingProfileSource, openvikingSource, userTipsSource]

/**
 * The sources that should run this step.
 * @param config - the resolved plugin configuration.
 * @param extra - instance-owned sources (the runtime-warning queue).
 * @returns the enabled sources, in run order.
 */
function enabledSources(config, extra) {
  const all = extra.length === 0 ? SOURCES : [...SOURCES, ...extra]
  return all.filter((source) => source.enabled(config))
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Register the injection hook.
 *
 * @param ctx - the Cordis context owning this plugin.
 * @param rawConfig - the resolved Config.
 * @returns an effect disposer that unregisters every listener.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig

  /**
   * Per-session, per-source ledger.
   *
   * This is an in-process optimization only: it skips the work of a repeated
   * step before anything is collected. Correctness across restarts comes from
   * {@link injectedOnSurface}, which reads the durable log, so an empty ledger
   * after a restart costs one collection, not a duplicate message.
   *
   * @type {Map<string, Map<string, { turn: number; step: number; mode: 'turn' | 'step'; queryHash: string; textHash?: string }>>}
   */
  const ledger = new Map()

  /**
   * Runtime warnings queued through {@link WARNING_EVENT}.
   *
   * Instance-owned on purpose: a warning is a live notification, not session
   * state, so it must not survive the plugin (or the process) that raised it.
   */
  const warnings = createUserWarningSource()

  const offWarning = ctx.on(WARNING_EVENT, (payload) => {
    if (readConfig(config, 'userWarning', true) === false) return
    const agentId = payload?.agent?.id ?? payload?.agentId
    if (agentId === undefined || agentId === null) return
    warnings.push(agentId, payload?.text)
  })

  /** The per-source ledger for one session, created on first use. */
  function sourceLedger(sessionId) {
    let entries = ledger.get(sessionId)
    if (!entries) {
      entries = new Map()
      ledger.set(sessionId, entries)
    }
    return entries
  }

  /**
   * Whether this turn/step was already served for this source.
   *
   * Turn mode keys on the query text: a step that continues after tool calls
   * carries no fresh input, so the only same-turn repeat is the identical query.
   * Step mode keys on the step number: each continuation step has its own query
   * and must be allowed to retrieve once.
   */
  function alreadyServed(previous, turn, step, mode, queryHash) {
    if (!previous || previous.turn !== turn || previous.mode !== mode) return false
    return mode === 'turn' ? previous.queryHash === queryHash : previous.step === step
  }

  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id === undefined) return
    ledger.delete(agent.id)
    warnings.clear(agent.id)
  })

  // Registered with `prepend: true`, which makes this listener the OUTERMOST one
  // in the waterfall: it awaits `next()` — every other plugin's listener, plus
  // the harness default — and only then inserts. Other plugins therefore never
  // observe these messages as part of their own input, and their decisions are
  // taken verbatim.
  const offPreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()

      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
        if (payload?.signal?.aborted) return decision
        if (readConfig(config, 'enabled', true) === false) return decision

        const sources = enabledSources(config, readConfig(config, 'userWarning', true) === false ? [] : [warnings.source])
        if (sources.length === 0) return decision

        const turn = payload.turn
        const step = payload.step
        const session = payload.agent?.session

        // Gate 1 — a turn's genuine user input drives a turn-mode recall. A step
        // that only continues after tool calls claims nothing, so it falls
        // through to step mode, which is opt-in per source.
        const fresh = decision.messages.filter(isRealUserInput)
        let mode = 'turn'
        let eligible = sources
        let query = ''
        if (fresh.length > 0) {
          query = fresh.map(textOf).filter(Boolean).join('\n\n').slice(0, 2000)
        } else {
          eligible = sources.filter((source) => source.onStep === true && source.stepEnabled?.(config) !== false)
          if (eligible.length === 0 || !(step > 1)) return decision
          mode = 'step'
          query = buildStepQuery(session, asNumber(readConfig(config, 'ovStepQueryChars', 2000)))
        }
        if (query.length === 0) return decision

        const sessionId = payload.agent?.id ?? '(unknown)'
        const queryHash = fingerprint(query)
        const perSource = sourceLedger(sessionId)
        const timeoutMs = asNumber(readConfig(config, 'timeoutMs', 3000))
        const maxChars = asNumber(readConfig(config, 'maxChars', 6000))
        const totalMaxChars = asNumber(readConfig(config, 'totalMaxChars', 0))
        const dedupe = readConfig(config, 'dedupeUnchanged', true) !== false

        // Gate 2 — skip sources this turn/step already served. Checked before
        // collection so a repeated step does no work at all.
        const pending = []
        for (const source of eligible) {
          const previous = perSource.get(source.id)
          if (alreadyServed(previous, turn, step, mode, queryHash)) continue
          pending.push(source)
        }
        if (pending.length === 0) return decision

        // Gate 3 — the work itself. Every source runs concurrently, each with its
        // own deadline, so N sources cost max(timeout) rather than the sum; one
        // failing must never affect another.
        const settled = await Promise.allSettled(
          pending.map(async (source) => {
            const signal = sourceSignal(payload?.signal, timeoutMs)
            const text = await withTimeout(
              source.collect(ctx, { query, config, signal, session, agent: payload.agent, turn, step, mode }),
              timeoutMs,
              source.id,
            )
            return text
          }),
        )

        let remaining = totalMaxChars > 0 ? totalMaxChars : Number.POSITIVE_INFINITY
        const blocks = []
        for (let index = 0; index < settled.length; index += 1) {
          const source = pending[index]
          const outcome = settled[index]
          if (outcome.status === 'rejected') {
            ctx.logger?.warn?.(`${name}: skipped ${source.id} (${String(outcome.reason)})`)
            continue
          }
          const text = outcome.value
          if (typeof text !== 'string' || text.length === 0) continue
          const budget = Math.min(maxChars, remaining)
          if (!(budget > 0)) continue
          const finalText = capText(text, budget)
          remaining = Math.max(0, remaining - finalText.length)
          blocks.push({ source, text: finalText })
        }

        if (blocks.length === 0) return decision

        // Gate 4 — a block whose exact text is provably still on the model's
        // surface would say nothing new. The check is per block, not per
        // message: several blocks now share one message, so a newly appeared
        // block must not force the unchanged siblings to be re-sent. The
        // evidence comes from the durable log, so it also holds after a
        // restart; if the old copy was compacted away this falls through and
        // injects again.
        const kept = []
        for (const block of blocks) {
          if (dedupe && injectedContains(session, block.text)) {
            perSource.set(block.source.id, { turn, step, mode, queryHash })
            continue
          }
          kept.push(block)
        }
        if (kept.length === 0) return decision
        for (const block of kept) perSource.set(block.source.id, { turn, step, mode, queryHash })

        // One envelope, one message. The blocks are siblings INSIDE the
        // reminder rather than one reminder each: the model reads a single
        // "this is not the user speaking" fence whose parts follow registry
        // order — also the order the character budget was spent in.
        const body = kept.map((block) => block.text).join('\n\n')
        const appended = [buildMessage(mergedSource(kept), wrapReminder(body))]
        ctx.logger?.info?.(
          `${name}: injected ${body.length} chars from ${kept.map((block) => block.source.id).join('+')} into ${sessionId} (turn ${turn}, step ${step}, ${mode})`,
        )

        // Insert directly below the user's question rather than at the very end
        // of the step's list: everything here is a comment on what the user just
        // said, so it reads in order after it — before any runtime-context
        // snapshot, which the loop re-projects in place anyway. A step with no
        // fresh user input (tool continuation) has nothing to sit below, so it
        // appends.
        const anchor = findLastIndex(decision.messages, isRealUserInput)
        // Spread, never mutate: every other field of the decision — including
        // `startsRequestSeries` — passes through untouched.
        const messages = anchor < 0
          ? [...decision.messages, ...appended]
          : [...decision.messages.slice(0, anchor + 1), ...appended, ...decision.messages.slice(anchor + 1)]
        return { ...decision, messages }
      } catch (error) {
        ctx.logger?.warn?.(`${name}: skipped injection (${String(error)})`)
        return decision
      }
    },
    { prepend: true },
  )

  // The pre-step listener, the disposal listener, and the warning intake all
  // belong to this plugin's lifetime. Cordis would unwind them with the plugin's
  // own fiber, but returning an explicit composite disposer keeps the lifecycle
  // self-contained — and correct under a plain context that has no fiber, which
  // is how the tests drive it.
  let released = false
  return () => {
    if (released) return
    released = true
    offPreStep()
    offDisposed()
    offWarning()
  }
}

/**
 * Index of the last element satisfying `predicate`, or -1.
 *
 * `Array.prototype.findLastIndex` needs Node 18+, which every supported runtime
 * has; the loop keeps this module free of any other assumption about it.
 *
 * @param list - the array to scan.
 * @param predicate - the test to apply.
 * @returns the index, or -1.
 */
function findLastIndex(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index
  }
  return -1
}

/**
 * Short labels for the one-line summary describing what a reminder carries.
 * @type {Record<string, string>}
 */
const BLOCK_LABELS = {
  skillList: 'skill list',
  ovProfile: 'memory index',
  ov: 'memory recall',
  userTips: 'user tips',
  userWarning: 'warning',
}

/**
 * Describe the assembled reminder as one `notice`.
 *
 * Every block travels in a single message, so the message needs a single
 * presentation. `notice` is the only form that fits "several unrelated blocks
 * at once": the per-source forms (catalog / recall / instructions) would each
 * have to claim the whole message and would misdescribe the other blocks. Its
 * `summary` is the one-line account of what is inside.
 *
 * @param blocks - the blocks that made it into the message, in order.
 * @returns the source descriptor for {@link buildMessage}.
 */
function mergedSource(blocks) {
  const labels = blocks.map((block) => BLOCK_LABELS[block.source.id] ?? block.source.id)
  return { form: 'notice', summary: labels.join(' · ') }
}

/**
 * Build the injected message for the assembled reminder body.
 *
 * The message is built by `createUserMessage` from `@deepseek-ai/dsh-llm`, the
 * same constructor every harness producer uses: it stamps a fresh stable `id`
 * and deep-freezes the result. `id` is REQUIRED — the session's
 * `assertMessageEventShape` rejects a persisted event whose message lacks a
 * non-empty string id.
 *
 * `source.kind` is free-form for user messages — only system, assistant and tool
 * messages have pinned kinds — and it is what makes this message render as
 * injected context rather than as something the user typed.
 * `dsh-client-ui-chat` classifies every durable `user/message` by exactly this
 * field: `source.kind === 'user'` becomes a user (or steering) row, and ANY
 * other value is routed through `contextMessage()` — "Context presentation
 * shared by user-role injections and developer messages" — producing a `context`
 * row whose producer label is the kind itself.
 *
 * `source.form` selects the client's structured presentation (one of
 * `instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`).
 * A `notice` source must also supply `summary` — a string or a `(text) => string`
 * function — which is bounded to the client's one-line account here.
 *
 * Content holds text blocks only: `tool-addition` / `tool-removal` blocks are
 * rejected outside developer-role messages.
 *
 * @param source - the message's source descriptor (see {@link mergedSource}).
 * @param text - the fully wrapped, injectable text.
 * @returns the message to insert.
 */
function buildMessage(source, text) {
  const fields = { kind: KIND, form: source.form, provider: source.provider }
  if (source.form === 'notice') {
    const raw = typeof source.summary === 'function' ? source.summary(text) : source.summary
    const summary = String(raw ?? text).replace(/\s+/g, ' ').trim()
    fields.summary = boundContextSummary(summary.length > 0 ? summary : 'Runtime notice')
  }
  return createUserMessage({
    source: fields,
    content: [{ type: 'text', text }],
  })
}

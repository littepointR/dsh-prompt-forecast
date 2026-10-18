/**
 * Prompt Forecast — Host half.
 *
 * At the end of every completed Agent turn, ask the model that just served the
 * turn for the single most likely next human prompt, then publish it through a
 * client-visible session projection so the Web composer can render it as ghost
 * text when its draft is empty.
 *
 * Why a projection instead of a session event: a plugin may not append new
 * event types (a log carrying an unknown type cannot be reopened, and
 * `appendPluginRecord()` is reserved for first-party experimental packages).
 * The projection is the supported carrier for session-derived client state.
 *
 * Why the prediction is produced during `agent/turn-stopping`: projection
 * state folds synchronously from committed events, and the Client view is only
 * republished when a committed event changes that state. Producing the text
 * while the turn boundary is still open lets the following `turn/end` commit
 * bake it into the state in the same frame that renders the finished turn, so
 * the ghost text needs no polling or a second transport.
 */

/** Projection key shared with the Client half. */
const FORECAST_PROJECTION_KEY = 'promptForecast'

/** Predictions this process already produced, per session. */
const producedPredictions = new Map()

/** Copy of one session's last published prediction, safe to seed a fresh fold with. */
function knownPrediction(sessionId) {
  return producedPredictions.get(String(sessionId))
}

/** Defaults for every tunable value; a `config` block in cordis.patch.yml overrides them. */
const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'fork',
  maxTokens: 1024,
  temperature: 0.4,
  timeoutMs: 12_000,
  maxPromptChars: 80,
  maxInputChars: 6_000,
  maxForkChars: 12_000,
  fallback: true,
  skipSubagents: true,
  provider: undefined,
  model: undefined,
}

const SYSTEM_PROMPT = [
  'You predict the next actionable message the human user will send to an agentic coding assistant.',
  'Read the supplied conversation excerpt and write the single most likely message in which the user tells the assistant what to do next.',
  'The message may include a brief report of what the user observed, but only when followed by a concrete instruction, choice, correction, or request to explain or diagnose.',
  'Do not write a message that only reports a result, test outcome, log state, or what the user did; do not guess what might happen or what the result will be; do not summarize the conversation.',
  'If the literal next message would only be a status report, write the follow-up instruction instead.',
  'Output only the message text itself, in the same language the user writes in.',
  'One line, at most about 60 characters, no quotes, no labels, no prefix such as "Prompt:", no Markdown, no code fences.',
  'Make it a concrete next step: ask to run, fix, check, change, commit, compare, or explain something, answer a question the assistant asked, approve or choose an option, or continue the current task.',
  'Never explain your reasoning and never mention this instruction.',
].join(' ')

/** Action-over-outcome rules appended to the forked coding-agent prompt. */
const ACTION_RULES = [
  'Prediction task: the user will see your answer as ghost text in their input box.',
  'Write the next ACTION the user would ask the assistant to take, not a report of what happened or a guess about what will happen.',
  'Allowed: an instruction or request (run, fix, check, change, explain, diagnose, continue, commit, open, compare), a choice or approval, a correction, or a brief report followed by such an instruction.',
  'Not allowed: a message that only reports a result, test outcome, log state, or what the user did; a guess about whether something will work or what the result will be; a summary of the conversation.',
  'If the literal next message would only be a status report, write the follow-up instruction instead.',
  'Keep the user\'s language, voice, and length. Output only the message.',
].join('\n')

/** The synthetic user turn a Codex-style prediction fork appends. */
const SUGGESTION_PROMPT = 'Suggest my next message.'

/**
 * Read one configuration value with a fallback, rejecting the wrong type so a
 * typo in cordis.patch.yml degrades to the default instead of a broken plugin.
 */
function pick(config, name, fallback, test) {
  const value = config?.[name]
  return test(value) ? value : fallback
}

/** Normalize the Loader row's `config` into the exact values this plugin uses. */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: pick(config, 'enabled', DEFAULT_CONFIG.enabled, (v) => typeof v === 'boolean'),
    mode: pick(config, 'mode', DEFAULT_CONFIG.mode, (v) => v === 'fork' || v === 'digest'),
    maxTokens: pick(config, 'maxTokens', DEFAULT_CONFIG.maxTokens, (v) => Number.isInteger(v) && v > 0),
    temperature: pick(config, 'temperature', DEFAULT_CONFIG.temperature, (v) => typeof v === 'number' && v >= 0 && v <= 2),
    timeoutMs: pick(config, 'timeoutMs', DEFAULT_CONFIG.timeoutMs, (v) => Number.isInteger(v) && v > 0),
    maxPromptChars: pick(config, 'maxPromptChars', DEFAULT_CONFIG.maxPromptChars, (v) => Number.isInteger(v) && v > 0),
    maxInputChars: pick(config, 'maxInputChars', DEFAULT_CONFIG.maxInputChars, (v) => Number.isInteger(v) && v > 0),
    maxForkChars: pick(config, 'maxForkChars', DEFAULT_CONFIG.maxForkChars, (v) => Number.isInteger(v) && v > 0),
    fallback: pick(config, 'fallback', DEFAULT_CONFIG.fallback, (v) => typeof v === 'boolean'),
    skipSubagents: pick(config, 'skipSubagents', DEFAULT_CONFIG.skipSubagents, (v) => typeof v === 'boolean'),
    provider: pick(config, 'provider', undefined, (v) => typeof v === 'string' && v.length > 0),
    model: pick(config, 'model', undefined, (v) => typeof v === 'string' && v.length > 0),
  }
}

/**
 * Minimal schema object for the projection service.
 *
 * `ProjectionDefinition` requires Zod-shaped `stateSchema` / `viewSchema`, and
 * the service only ever calls `.parse()` / `.safeParse()` on them. A plugin
 * package cannot import the Host's Zod instance: its own imports resolve from
 * the profile, not from the dsh installation. Both values this plugin produces
 * are plain JSON built here, so a validating pass-through is the honest
 * implementation rather than a dependency that would not resolve.
 */
const JSON_SCHEMA = {
  parse(value) {
    return value
  },
  safeParse(value) {
    return { success: true, data: value }
  },
}

/** Plain text of one message's text blocks. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Collapse whitespace and clip to `limit` characters on a code-point boundary. */
function clip(text, limit) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  const cut = normalized.slice(0, limit)
  return `${cut.slice(0, Math.max(0, cut.length - 1))}…`
}

/**
 * The most recent human inputs and assistant replies of one session.
 *
 * Walking the log backwards avoids deriving system, developer, and tool
 * messages, and keeps the cost proportional to what is actually read.
 */
export function recentDialogue(session, maxUsers, maxAssistants) {
  const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : []
  const users = []
  const replies = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (users.length >= maxUsers && replies.length >= maxAssistants) break
    const event = events[index]
    if (event?.type === 'user/message' && users.length < maxUsers) {
      const text = messageText(event.data)
      if (text !== '') users.push(text)
      continue
    }
    if (event?.type === 'assistant/message' && replies.length < maxAssistants) {
      const text = messageText(event.data?.message)
      if (text !== '') replies.push(text)
    }
  }
  users.reverse()
  replies.reverse()
  return { users, replies }
}

/** Tool names the given turn used, in first-use order. */
export function toolsForTurn(session, turn) {
  const events = typeof session?.ownEvents === 'function' ? session.ownEvents() : []
  let start = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) {
      start = index
      break
    }
  }
  if (start < 0) return []
  const names = new Set()
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name === 'string' && name !== '') names.add(name)
    }
    if (names.size >= 8) break
  }
  return [...names]
}

/**
 * Build the compact JSON excerpt the model reads.
 *
 * The newest assistant reply is kept whole (it is what the next prompt reacts
 * to), while earlier human inputs supply the language and the working thread.
 *
 * @returns the prompt input, or `undefined` when the session has no human input.
 */
export function buildPredictionInput(session, turn, config) {
  const { users, replies } = recentDialogue(session, 3, 2)
  if (users.length === 0) return undefined
  const payload = {
    recent_user_messages: users.map((text) => clip(text, 400)),
    latest_assistant_reply: replies.length === 0 ? '' : clip(replies[replies.length - 1], 1_600),
    tools_used: toolsForTurn(session, turn),
  }
  const json = JSON.stringify(payload)
  return json.length <= config.maxInputChars ? json : json.slice(0, config.maxInputChars)
}

/** Distinct strings, in first-seen order. */
function uniqueParts(parts) {
  const seen = new Set()
  const unique = []
  for (const part of parts) {
    if (seen.has(part)) continue
    seen.add(part)
    unique.push(part)
  }
  return unique
}

/**
 * Build a Codex-style prediction context: the parent's current text transcript
 * plus the synthetic user turn `Suggest my next message.`.
 *
 * The derived session history is the same list the next model turn would see.
 * Tool calls, tool results, reasoning, and attachment blocks are dropped so the
 * auxiliary call needs no tool schemas and stays a pure conversation fork; the
 * merged system/developer text carries the instructions and environment. The
 * newest conversation messages that fit `maxForkChars` are kept, and the window
 * always starts at a user turn so the request remains valid.
 *
 * @returns `{ system, messages }`, or `undefined` when the session has no
 * conversational text to fork.
 */
export function buildForkContext(session, config) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  const systemParts = []
  const conversation = []
  for (const message of messages) {
    const text = messageText(message)
    if (text === '') continue
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(text)
      continue
    }
    if (message.role === 'user' || message.role === 'assistant') {
      conversation.push({ role: message.role, content: [{ type: 'text', text }] })
    }
  }
  if (conversation.length === 0) return undefined
  const budget = config.maxForkChars ?? DEFAULT_CONFIG.maxForkChars
  let used = 0
  const selected = []
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index]
    const length = message.content[0].text.length
    if (selected.length > 0 && used + length > budget) break
    selected.unshift(message)
    used += length
  }
  while (selected.length > 0 && selected[0].role !== 'user') selected.shift()
  if (selected.length === 0) return undefined
  const system = uniqueParts(systemParts).join('\n\n')
  return {
    ...(system === '' ? {} : { system }),
    messages: [
      ...selected,
      { role: 'user', content: [{ type: 'text', text: SUGGESTION_PROMPT }] },
    ],
  }
}

/**
 * Reduce raw model output to one clean prompt line.
 *
 * Models occasionally wrap the answer in quotes, a fence, a label, or a bullet;
 * those are presentation noise a composer insertion must not carry.
 *
 * @returns the normalized prompt, or `undefined` when nothing usable remains.
 */
export function normalizePrediction(raw, maxChars = DEFAULT_CONFIG.maxPromptChars) {
  let text = String(raw ?? '').replace(/\r/g, '').trim()
  if (text === '') return undefined
  text = text.replace(/^```[^\n]*\n?/u, '').replace(/\n?```$/u, '').trim()
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? ''
  let line = firstLine
    .replace(/^(?:[-*•>]\s+)/u, '')
    .replace(/^(?:next prompt|next message|prompt|predicted prompt|suggestion)\s*[:：]\s*/iu, '')
    .replace(/^(?:下一句|下一条|预测|建议|提示词)\s*[:：]\s*/u, '')
    .replace(/^(?:sure[,!.]?\s*)?(?:here(?:'s| is)[^:：\n]{0,60}[:：]\s*)/iu, '')
    .replace(/^(?:i(?:'d)? suggest|you (?:could|might) (?:say|write|ask))\s*[:：]?\s*/iu, '')
    .replace(/^["'“”‘’`「『]+/u, '')
    .replace(/["'“”‘’`」』]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (line === '') return undefined
  // `NONE` is the predictor's explicit "no useful suggestion" answer. Assistant
  // voice means the model answered as the agent instead of writing as the user.
  if (/^none[.!]?$/iu.test(line)) return undefined
  if (/^(?:sure|certainly|of course|i(?:'ve| have) (?:updated|fixed|added|changed|implemented))\b/iu.test(line)) {
    return undefined
  }
  if (line.length > maxChars) {
    const cut = line.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(' ')
    const head = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut
    line = `${head.trimEnd()}…`
  }
  return line
}

/** A clause that only reports something the user already did. */
const PURE_RESULT = [
  /^(?:我)?(?:已经)?(?:重启|重开|刷新|重新启动|改|修改|修|试|跑|测试|看|查)(?:了|过了|完了|完成)(?:[^，,。.!！]{0,20})?$/u,
  /^(?:i )?(?:already )?(?:restarted|reopened|refreshed|changed|fixed|tried|ran|tested|checked|looked)(?: it| them)?[.!]?$/iu,
]

/** A clause that only reports an observed status. */
const PURE_STATUS = [
  /^(?:还是|仍然)?(?:没|不)(?:有)?(?:看到|出现|生效|成功|通过|显示|正常|好用)(?:[^，,。.!！]{0,20})?$/u,
  /^(?:still )?(?:no|not) (?:seeing|working|showing|passing|visible|there)[^.!]{0,30}[.!]?$/iu,
]

/** A clause that only speculates about an outcome. */
const PURE_SPECULATION = [
  /^(?:测试|结果|这个|它)?(?:应该|可能|大概|也许|估计)[^，,。.!！]{0,40}$/u,
  /^(?:it |this |the test |the result )?(?:should|might|may|probably|maybe)\b[^.!]{0,60}[.!]?$/iu,
]

/**
 * Whether a prediction is an action (or a report followed by one) rather than a
 * pure result report or outcome guess.
 *
 * This is a conservative safety net, not the primary mechanism: the predictor
 * prompts state the rule. A clause that matches a pure result/status/speculation
 * pattern is discarded unless another clause carries an instruction; if every
 * clause is pure, the whole prediction is rejected and fork mode can fall back
 * to the digest.
 */
export function isActionablePrediction(text) {
  const clauses = String(text ?? '')
    .split(/[，,。.!！;；\n]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
  if (clauses.length === 0) return false
  return clauses.some((clause) =>
    !PURE_RESULT.some((pattern) => pattern.test(clause))
    && !PURE_STATUS.some((pattern) => pattern.test(clause))
    && !PURE_SPECULATION.some((pattern) => pattern.test(clause)))
}

/** Resolve the provider/model route, preferring the turn's own request header. */
function resolveRoute(ctx, session, config) {
  if (typeof config.provider === 'string' && typeof config.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const logged = header?.config
  if (typeof logged?.provider === 'string' && typeof logged?.model === 'string') {
    return { provider: logged.provider, model: logged.model }
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const selectionModel = selection?.model
  const provider = selection?.provider ?? selectionModel?.provider
  const model = typeof selectionModel === 'string' ? selectionModel : selectionModel?.model ?? selection?.modelId
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  return undefined
}

/**
 * One bounded auxiliary model call shared by both prediction modes.
 * @returns `{ text }` on success, or `{ failure, detail? }` naming why not.
 */
async function generateText(ctx, session, request, route, config, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, config.timeoutMs)
  if (signal !== undefined) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  try {
    const call = await ctx.llm.prepareCall(
      {
        provider: route.provider,
        model: route.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      },
      controller.signal,
      // A prediction is a tiny auxiliary request: take the route's least
      // reasoning effort so the output budget is not spent on deliberation.
      (controls, model) => {
        const effort = model?.reasoning?.efforts?.[0]?.id
        return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
      },
    )
    const stream = call.stream({
      ...call.config,
      messages: request.messages,
      ...(request.system === undefined ? {} : { system: request.system }),
      sessionId: session.id,
      signal: controller.signal,
    })
    let text = ''
    let finishKind = 'stop'
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') finishKind = chunk.reason?.kind ?? 'stop'
    }
    if (finishKind === 'error') return { failure: 'provider' }
    if (finishKind === 'aborted') return { failure: timedOut ? 'timeout' : 'aborted' }
    const suggestion = normalizePrediction(text, config.maxPromptChars)
    if (suggestion === undefined) {
      if (/^none[.!]?$/iu.test(text.trim())) return { failure: 'none' }
      if (text.trim() === '') {
        return { failure: finishKind === 'max-tokens' ? 'max-tokens' : finishKind === 'tool-calls' ? 'tool-calls' : 'empty' }
      }
      return { failure: 'unusable' }
    }
    if (!isActionablePrediction(suggestion)) return { failure: 'filtered', detail: suggestion.slice(0, 160) }
    return { text: suggestion }
  } catch (error) {
    return {
      failure: timedOut ? 'timeout' : 'error',
      detail: String(error?.message ?? error).slice(0, 200),
    }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', abort)
  }
}

/** The legacy lightweight mode: one JSON digest, one synthetic system prompt. */
async function generateDigestPrediction(ctx, session, input, route, config, signal) {
  return generateText(ctx, session, {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
  }, route, config, signal)
}

/** The Codex-style mode: the parent transcript plus one synthetic user turn. */
async function generateForkPrediction(ctx, session, route, config, signal) {
  const context = buildForkContext(session, config)
  if (context === undefined) return { failure: 'no-context' }
  const system = context.system === undefined ? ACTION_RULES : `${context.system}\n\n${ACTION_RULES}`
  return generateText(ctx, session, { system, messages: context.messages }, route, config, signal)
}

/**
 * Produce one prediction for an already closing turn.
 * @returns `{ text, model, mode }` on success, or `{ failure, detail? }` naming
 * why the predictor produced nothing.
 */
async function predictionForTurn(scoped, session, turn, config, signal) {
  const route = resolveRoute(scoped, session, config)
  if (route === undefined) return { failure: 'no-route' }

  const finish = (produced, mode) => {
    const { users } = recentDialogue(session, 1, 0)
    if (users.length > 0 && normalizePrediction(users[users.length - 1], Number.MAX_SAFE_INTEGER) === produced.text) {
      return { failure: 'echo' }
    }
    return { text: produced.text, model: route.model, mode }
  }
  const combine = (fork, digest) => ({
    failure: `fork:${fork.failure};digest:${digest.failure}`,
    detail: [fork.detail, digest.detail].filter(Boolean).join(' | ').slice(0, 240),
  })

  if (config.mode === 'fork') {
    const fork = await generateForkPrediction(scoped, session, route, config, signal)
    if (fork.text !== undefined) return finish(fork, 'fork')
    if (config.fallback) {
      // The full-transcript fork is the quality path; the compact digest is the
      // cheap safety net when the fork times out, returns no text, or the route
      // rejects the larger request.
      const input = buildPredictionInput(session, turn, config)
      if (input === undefined) {
        return { failure: `fork:${fork.failure};digest:no-context`, detail: fork.detail }
      }
      const digest = await generateDigestPrediction(
        scoped,
        session,
        input,
        route,
        { ...config, timeoutMs: Math.min(config.timeoutMs, 8_000) },
        signal,
      )
      if (digest.text !== undefined) return finish(digest, 'digest')
      return combine(fork, digest)
    }
    return { failure: `fork:${fork.failure}`, detail: fork.detail }
  }

  const input = buildPredictionInput(session, turn, config)
  if (input === undefined) return { failure: 'digest:no-context' }
  const digest = await generateDigestPrediction(scoped, session, input, route, config, signal)
  if (digest.text !== undefined) return finish(digest, 'digest')
  return { failure: `digest:${digest.failure}`, detail: digest.detail }
}

/**
 * Host half: own the `promptForecast` projection and produce one prediction at
 * each completed turn boundary.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the Loader row's `config` block, if any.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  /** sessionId -> (turn -> prediction entry) awaiting the turn's `turn/end` commit. */
  const pending = new Map()

  ctx.inject(['sessionProjections', 'llm'], (scoped) => {
    scoped.sessionProjections.register({
      key: FORECAST_PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: JSON_SCHEMA,
      init: (header) => {
        const known = knownPrediction(header.id)
        return known === undefined
          ? { session: String(header.id), turn: 0, text: '', model: '', at: 0, mode: '', reason: '', detail: '' }
          : { session: String(header.id), ...known }
      },
      apply: (state, event) => {
        if (event.type !== 'turn/end') return state
        const byTurn = pending.get(state.session)
        const turn = event.data.turn
        const entry = byTurn?.get(turn)
        if (entry !== undefined) {
          byTurn.delete(turn)
          if (byTurn.size === 0) pending.delete(state.session)
          return {
            ...state,
            turn,
            text: entry.text,
            model: entry.model,
            at: entry.at,
            mode: entry.mode,
            reason: entry.reason ?? '',
            detail: entry.detail ?? '',
          }
        }
        // A completed turn with no prediction clears the previous hint; an
        // aborted turn keeps it, because that turn produced no new outcome to
        // predict from.
        if (event.data?.reason?.kind !== 'completed') return state
        if (state.text === '' && state.reason === '' && state.turn === turn) return state
        return { ...state, turn, text: '', model: '', at: 0, mode: '', reason: '', detail: '' }
      },
      wire: {
        viewSchema: JSON_SCHEMA,
        view: (state) => {
          producedPredictions.set(state.session, {
            turn: state.turn,
            text: state.text,
            model: state.model,
            at: state.at,
            mode: state.mode,
            reason: state.reason,
            detail: state.detail,
          })
          return {
            turn: state.turn,
            text: state.text,
            model: state.model,
            at: state.at,
            mode: state.mode,
            reason: state.reason,
            detail: state.detail,
          }
        },
      },
    })
  })

  // One attempt per session turn. Both the root observer and the per-agent
  // listener may be installed; this keeps them from calling the model twice.
  const handledTurns = new Set()
  const attachedAgents = new Map()

  async function onTurnStopping(payload) {
    try {
      const session = payload?.agent?.session
      if (session === undefined) return
      if (config.skipSubagents && (session.header?.origin === 'subagent' || session.header?.parentSession !== undefined)) {
        return
      }
      const turn = payload.turn
      if (typeof turn !== 'number') return
      const activeKey = `${session.id}:${turn}`
      if (handledTurns.has(activeKey)) return
      handledTurns.add(activeKey)
      const key = String(session.id)
      let byTurn = pending.get(key)
      if (byTurn === undefined) {
        byTurn = new Map()
        pending.set(key, byTurn)
      }
      if (ctx.get('llm') === undefined) {
        byTurn.set(turn, { text: '', model: '', mode: '', reason: 'no-llm', at: Date.now() })
        return
      }
      const result = await predictionForTurn(ctx, session, turn, config, payload.signal)
      if (result.text === undefined) {
        // Record the attempt so the projection checkpoint shows that the hook
        // fired and why the predictor produced nothing.
        byTurn.set(turn, {
          text: '',
          model: '',
          mode: '',
          reason: result.failure ?? 'no-prediction',
          detail: result.detail ?? '',
          at: Date.now(),
        })
        return
      }
      // The session is live by construction here: `turn-stopping` is emitted
      // by its running Agent. `session/disposed` cleans any late entry.
      byTurn.set(turn, { text: result.text, model: result.model, mode: result.mode, reason: '', detail: '', at: Date.now() })
    } catch (error) {
      // A failing prediction must never fail the turn it follows.
      ctx.logger?.warn?.('prompt-forecast: prediction failed: %o', error)
    }
  }

  /** Attach the turn hook to one exact Agent through its own context. */
  function attachAgent(agent) {
    if (agent?.ctx === undefined || typeof agent.ctx.on !== 'function') return
    const key = String(agent.id)
    if (attachedAgents.has(key)) return
    attachedAgents.set(key, agent.ctx.on('agent/turn-stopping', onTurnStopping))
  }

  // Root observer: receives already-live agents' turns in the common case.
  ctx.on('agent/turn-stopping', onTurnStopping)

  // Per-agent registration is the scope-safe path: `agent/turn-stopping` is
  // dispatched with the agent's scope, and agents created before this plugin
  // loaded are covered by `agents.list()`.
  ctx.inject(['agents'], (scoped) => {
    const agents = scoped.agents ?? scoped.get?.('agents')
    if (agents === undefined || typeof agents.list !== 'function') return
    for (const agent of agents.list()) attachAgent(agent)
  })
  ctx.on('agent/created', ({ agent }) => attachAgent(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    const dispose = attachedAgents.get(key)
    if (dispose !== undefined) {
      dispose()
      attachedAgents.delete(key)
    }
  })

  ctx.on('session/disposed', (session) => {
    const prefix = `${session.id}:`
    for (const key of handledTurns) {
      if (key.startsWith(prefix)) handledTurns.delete(key)
    }
    pending.delete(String(session.id))
    // A reopened session restores its projection from the checkpoint row,
    // which repopulates the module store on the next view.
    producedPredictions.delete(String(session.id))
  })
}

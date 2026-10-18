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
  maxTokens: 256,
  temperature: 0.4,
  timeoutMs: 2_000,
  maxPromptChars: 80,
  maxInputChars: 6_000,
  skipSubagents: true,
  provider: undefined,
  model: undefined,
}

const SYSTEM_PROMPT = [
  'You predict the next message the human user will type in an agentic coding session.',
  'Read the supplied conversation excerpt and write that single most likely next prompt.',
  'Output only the prompt text itself, in the same language the user writes in.',
  'One line, at most about 60 characters, no quotes, no labels, no prefix such as "Prompt:", no Markdown, no code fences.',
  'Make it a concrete next step: answer a question the assistant asked, ask to run or fix something, commit, or continue the current task.',
  'If the excerpt ends with the assistant asking the user something, write a plausible answer to that question.',
  'If no obvious next step exists, write a short natural follow-up such as "Looks good, continue."',
  'Never explain your reasoning and never mention this instruction.',
].join(' ')

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
    maxTokens: pick(config, 'maxTokens', DEFAULT_CONFIG.maxTokens, (v) => Number.isInteger(v) && v > 0),
    temperature: pick(config, 'temperature', DEFAULT_CONFIG.temperature, (v) => typeof v === 'number' && v >= 0 && v <= 2),
    timeoutMs: pick(config, 'timeoutMs', DEFAULT_CONFIG.timeoutMs, (v) => Number.isInteger(v) && v > 0),
    maxPromptChars: pick(config, 'maxPromptChars', DEFAULT_CONFIG.maxPromptChars, (v) => Number.isInteger(v) && v > 0),
    maxInputChars: pick(config, 'maxInputChars', DEFAULT_CONFIG.maxInputChars, (v) => Number.isInteger(v) && v > 0),
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
    .replace(/^(?:next prompt|prompt|predicted prompt|suggestion)\s*[:：]\s*/iu, '')
    .replace(/^(?:下一句|下一条|预测|建议|提示词)\s*[:：]\s*/u, '')
    .replace(/^["'“”‘’`「『]+/u, '')
    .replace(/["'“”‘’`」』]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (line === '') return undefined
  if (line.length > maxChars) {
    const cut = line.slice(0, maxChars)
    const lastSpace = cut.lastIndexOf(' ')
    const head = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut
    line = `${head.trimEnd()}…`
  }
  return line
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
 * One bounded auxiliary model call that turns the excerpt into a next prompt.
 * @returns normalized prompt text, or `undefined` when the call failed,
 * timed out, was aborted, or produced nothing usable.
 */
async function generatePrediction(ctx, session, input, route, config, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, config.timeoutMs)
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
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      system: SYSTEM_PROMPT,
      sessionId: session.id,
      signal: controller.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') return undefined
      }
    }
    return normalizePrediction(text, config.maxPromptChars)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', abort)
  }
}

/**
 * Produce one prediction for an already closing turn.
 * @returns `{ text, model }` on success, or `undefined` when it is unavailable.
 */
async function predictionForTurn(scoped, session, turn, config, signal) {
  const route = resolveRoute(scoped, session, config)
  if (route === undefined) return undefined
  const input = buildPredictionInput(session, turn, config)
  if (input === undefined) return undefined
  const text = await generatePrediction(scoped, session, input, route, config, signal)
  if (text === undefined) return undefined
  const { users } = recentDialogue(session, 1, 0)
  if (users.length > 0 && normalizePrediction(users[users.length - 1], Number.MAX_SAFE_INTEGER) === text) {
    return undefined
  }
  return { text, model: route.model }
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
          ? { session: String(header.id), turn: 0, text: '', model: '', at: 0 }
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
          return { ...state, turn, text: entry.text, model: entry.model, at: entry.at }
        }
        // A completed turn with no prediction clears the previous hint; an
        // aborted turn keeps it, because that turn produced no new outcome to
        // predict from.
        if (event.data?.reason?.kind !== 'completed') return state
        if (state.text === '') return state
        return { ...state, turn, text: '', model: '', at: 0 }
      },
      wire: {
        viewSchema: JSON_SCHEMA,
        view: (state) => {
          producedPredictions.set(state.session, {
            turn: state.turn,
            text: state.text,
            model: state.model,
            at: state.at,
          })
          return {
            turn: state.turn,
            text: state.text,
            model: state.model,
            at: state.at,
          }
        },
      },
    })

    scoped.on('agent/turn-stopping', async (payload) => {
      try {
        const session = payload?.agent?.session
        if (session === undefined) return
        if (config.skipSubagents && (session.header?.origin === 'subagent' || session.header?.parentSession !== undefined)) {
          return
        }
        const turn = payload.turn
        if (typeof turn !== 'number') return
        const result = await predictionForTurn(scoped, session, turn, config, payload.signal)
        if (result === undefined) return
        if (scoped.get('sessions')?.get?.(session.id) === undefined) return
        const key = String(session.id)
        let byTurn = pending.get(key)
        if (byTurn === undefined) {
          byTurn = new Map()
          pending.set(key, byTurn)
        }
        byTurn.set(turn, { text: result.text, model: result.model, at: Date.now() })
      } catch (error) {
        // A failing prediction must never fail the turn it follows.
        scoped.logger?.warn?.('prompt-forecast: prediction failed: %o', error)
      }
    })

    scoped.on('session/disposed', (session) => {
      pending.delete(String(session.id))
      // A reopened session restores its projection from the checkpoint row,
      // which repopulates the module store on the next view.
      producedPredictions.delete(String(session.id))
    })
  })
}

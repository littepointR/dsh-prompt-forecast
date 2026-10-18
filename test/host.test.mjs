import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  apply,
  buildForkContext,
  buildPredictionInput,
  isActionablePrediction,
  normalizePrediction,
  recentDialogue,
  resolveConfig,
  toolsForTurn,
} from '../index.js'

/** One text-block user message event. */
function userEvent(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

/** One text-block assistant message event. */
function assistantEvent(text) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

/** Session double reading the given log. */
function fakeSession(events) {
  return {
    id: 'session-2',
    ownEvents: () => events,
    requestHeader: () => undefined,
  }
}

test('resolveConfig supplies every default', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'fork')
  assert.equal(config.maxTokens, 512)
  assert.equal(config.temperature, 0.4)
  assert.equal(config.timeoutMs, 8000)
  assert.equal(config.maxPromptChars, 80)
  assert.equal(config.maxInputChars, 6000)
  assert.equal(config.maxForkChars, 12000)
  assert.equal(config.fallback, true)
  assert.equal(config.skipSubagents, true)
  assert.equal(config.provider, undefined)
  assert.equal(config.model, undefined)
})

test('resolveConfig rejects wrong types instead of propagating them', () => {
  const config = resolveConfig({
    enabled: 'no',
    mode: 'unknown',
    maxTokens: 3.5,
    temperature: 9,
    timeoutMs: -1,
    maxForkChars: 0,
    fallback: 'yes',
    provider: '',
    model: 42,
  })
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'fork')
  assert.equal(config.maxTokens, 512)
  assert.equal(config.temperature, 0.4)
  assert.equal(config.timeoutMs, 8000)
  assert.equal(config.maxForkChars, 12000)
  assert.equal(config.fallback, true)
  assert.equal(config.provider, undefined)
  assert.equal(config.model, undefined)
})

test('resolveConfig keeps valid overrides', () => {
  const config = resolveConfig({
    enabled: false,
    mode: 'digest',
    maxTokens: 32,
    timeoutMs: 900,
    maxForkChars: 9000,
    fallback: false,
    provider: 'p',
    model: 'm',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.mode, 'digest')
  assert.equal(config.maxTokens, 32)
  assert.equal(config.timeoutMs, 900)
  assert.equal(config.maxForkChars, 9000)
  assert.equal(config.fallback, false)
  assert.equal(config.provider, 'p')
  assert.equal(config.model, 'm')
})

test('normalizePrediction strips quotes, labels, bullets, and fences', () => {
  assert.equal(normalizePrediction('"继续修复失败的测试。"'), '继续修复失败的测试。')
  assert.equal(normalizePrediction('Prompt: run the tests'), 'run the tests')
  assert.equal(normalizePrediction('下一句：提交这些改动'), '提交这些改动')
  assert.equal(normalizePrediction('- commit the changes'), 'commit the changes')
  assert.equal(normalizePrediction('```text\nfix the failing test\n```'), 'fix the failing test')
  assert.equal(normalizePrediction('Here is a suggestion: run the tests'), 'run the tests')
  assert.equal(normalizePrediction('I suggest: continue'), 'continue')
  assert.equal(normalizePrediction('NONE'), undefined)
  assert.equal(normalizePrediction("Sure, I've updated the file."), undefined)
})

test('normalizePrediction keeps only the first non-empty line', () => {
  assert.equal(normalizePrediction('\n\n继续\n解释一下'), '继续')
})

test('normalizePrediction clips long output on a word boundary', () => {
  const text = normalizePrediction('please run the full test suite and then fix every remaining failure', 24)
  assert.ok(text.length <= 25)
  assert.ok(text.endsWith('…'))
})

test('normalizePrediction returns undefined for empty output', () => {
  assert.equal(normalizePrediction('   \n  '), undefined)
  assert.equal(normalizePrediction('""'), undefined)
})

test('isActionablePrediction separates actions from pure reports and guesses', () => {
  assert.equal(isActionablePrediction('重启了，还是没看到预测'), false)
  assert.equal(isActionablePrediction('测试应该会过'), false)
  assert.equal(isActionablePrediction('可能会报错'), false)
  assert.equal(isActionablePrediction('我已经重启了应用'), false)
  assert.equal(isActionablePrediction('查一下 projection 缓存'), true)
  assert.equal(isActionablePrediction('重启了，还是没看到，查一下日志'), true)
  assert.equal(isActionablePrediction('用方案 A'), true)
  assert.equal(isActionablePrediction('为什么会 fork 超时？'), true)
  assert.equal(isActionablePrediction('好的'), true)
  assert.equal(isActionablePrediction('Run the tests.'), true)
})

test('recentDialogue returns the newest human inputs and replies in order', () => {
  const session = fakeSession([
    userEvent('first'),
    assistantEvent('first reply'),
    userEvent('second'),
    assistantEvent('second reply'),
    userEvent('third'),
    assistantEvent('third reply'),
  ])
  const { users, replies } = recentDialogue(session, 2, 2)
  assert.deepEqual(users, ['second', 'third'])
  assert.deepEqual(replies, ['second reply', 'third reply'])
})

test('recentDialogue ignores messages without text', () => {
  const session = fakeSession([
    { type: 'user/message', data: { content: [{ type: 'image', attachment: {} }] } },
    userEvent('real input'),
  ])
  assert.deepEqual(recentDialogue(session, 3, 1).users, ['real input'])
})

test('toolsForTurn keeps only tool calls after the matching turn start', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { name: 'bash' } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'tool/call', data: { name: 'edit' } },
    { type: 'tool/call', data: { name: 'edit' } },
    { type: 'tool/call', data: { name: 'read' } },
  ]
  assert.deepEqual(toolsForTurn(fakeSession(events), 2), ['edit', 'read'])
  assert.deepEqual(toolsForTurn(fakeSession(events), 9), [])
})

test('buildPredictionInput frames the latest reply and the turn tools', () => {
  const events = [
    userEvent('Fix the failing test in forecast.test.ts'),
    assistantEvent('The test now passes.'),
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { name: 'edit' } },
  ]
  const input = buildPredictionInput(fakeSession(events), 1, resolveConfig({}))
  assert.ok(input !== undefined)
  const payload = JSON.parse(input)
  assert.deepEqual(payload.recent_user_messages, ['Fix the failing test in forecast.test.ts'])
  assert.equal(payload.latest_assistant_reply, 'The test now passes.')
  assert.deepEqual(payload.tools_used, ['edit'])
})

test('buildPredictionInput refuses a session with no human input', () => {
  const session = fakeSession([assistantEvent('hello')])
  assert.equal(buildPredictionInput(session, 1, resolveConfig({})), undefined)
})

test('one completed turn publishes the prediction and the next turn without one clears it', async () => {
  const events = [
    userEvent('Fix the failing test'),
    assistantEvent('The test now passes.'),
    { type: 'turn/start', data: { turn: 1 } },
  ]
  const session = {
    id: 'session-2',
    header: {},
    ownEvents: () => events,
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
  }
  const listeners = {}
  let definition
  let captured
  const scoped = {
    sessionProjections: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    get(name) {
      if (name === 'sessions') return { get: id => (id === 'session-2' ? session : undefined) }
      return undefined
    },
    llm: {
      async prepareCall(config, _signal, configure) {
        const controls = configure === undefined
          ? config
          : configure({ ...config }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
        assert.equal(controls.reasoningEffort, 'low')
        assert.equal(controls.maxTokens, 512)
        return {
          config: controls,
          stream: async function* (options) {
            captured = options
            yield { type: 'text-delta', index: 0, text: '"Run the tests."' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }
  apply({ inject: (_names, callback) => callback(scoped) }, { mode: 'digest', timeoutMs: 1000 })

  assert.ok(definition !== undefined)
  let state = definition.init({ id: 'session-2' })
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })

  assert.ok(captured.system.includes('next actionable message'))
  state = definition.apply(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.turn, 1)
  assert.equal(state.text, 'Run the tests.')
  assert.equal(state.model, 'test-model')
  assert.equal(state.mode, 'digest')
  assert.equal(definition.wire.view(state).text, 'Run the tests.')

  state = definition.apply(state, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(state.turn, 2)
  assert.equal(state.text, '')
  assert.equal(state.mode, '')
})

test('an aborted turn keeps the previous prediction', async () => {
  const events = [userEvent('hello'), assistantEvent('hi'), { type: 'turn/start', data: { turn: 1 } }]
  const session = {
    id: 'session-3',
    header: {},
    ownEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  let definition
  const scoped = {
    sessionProjections: { register(value) { definition = value; return () => {} } },
    on() { return () => {} },
    get(name) {
      if (name === 'sessions') return { get: id => (id === 'session-3' ? session : undefined) }
      return undefined
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: '继续' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }
  apply({ inject: (_names, callback) => callback(scoped) }, {})
  const state = definition.apply(definition.init({ id: 'session-3' }), {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  const aborted = definition.apply(
    { ...state, text: 'old hint' },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  )
  assert.equal(aborted.text, 'old hint')
})

test('buildForkContext merges system text and appends the synthetic user turn', () => {
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'developer', content: [{ type: 'text', text: 'DEVELOPER' }] },
    { role: 'user', content: [{ type: 'text', text: 'first request' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
      ],
    },
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }], toolCallId: 'call-1' },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ]
  const context = buildForkContext({ deriveMessages: () => conversation }, resolveConfig({}))
  assert.ok(context !== undefined)
  assert.equal(context.system, 'SYSTEM\n\nDEVELOPER')
  assert.deepEqual(context.messages.map(message => message.role), ['user', 'assistant', 'assistant', 'user'])
  assert.equal(context.messages[0].content[0].text, 'first request')
  assert.equal(context.messages[1].content[0].text, 'working')
  assert.equal(context.messages[3].content[0].text, 'Suggest my next message.')
})

test('buildForkContext keeps the newest window and starts at a user turn', () => {
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'S' }] },
    { role: 'user', content: [{ type: 'text', text: 'old request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'new request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'new reply' }] },
  ]
  const context = buildForkContext(
    { deriveMessages: () => conversation },
    resolveConfig({ maxForkChars: 20 }),
  )
  assert.ok(context !== undefined)
  assert.deepEqual(context.messages.map(message => message.role), ['user', 'assistant', 'user'])
  assert.equal(context.messages[0].content[0].text, 'new request')
})

test('buildForkContext returns undefined without conversational text', () => {
  const context = buildForkContext(
    { deriveMessages: () => [{ role: 'system', content: [{ type: 'text', text: 'S' }] }] },
    resolveConfig({}),
  )
  assert.equal(context, undefined)
})

test('fork mode sends the parent transcript and the synthetic turn', async () => {
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'developer', content: [{ type: 'text', text: 'DEVELOPER' }] },
    { role: 'user', content: [{ type: 'text', text: 'Fix the test' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The test passes.' }] },
  ]
  const session = {
    id: 'session-4',
    header: {},
    deriveMessages: () => conversation,
    ownEvents: () => [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const listeners = {}
  let captured
  let definition
  const scoped = {
    sessionProjections: { register(value) { definition = value; return () => {} } },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    get(name) {
      if (name === 'sessions') return { get: id => (id === 'session-4' ? session : undefined) }
      return undefined
    },
    llm: {
      async prepareCall(config, _signal, configure) {
        const controls = configure === undefined
          ? config
          : configure({ ...config }, { reasoning: { efforts: [{ id: 'low' }] } })
        return {
          config: controls,
          stream: async function* (options) {
            captured = options
            yield { type: 'text-delta', index: 0, text: '继续修复测试' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }
  apply({ inject: (_names, callback) => callback(scoped) }, { mode: 'fork', timeoutMs: 1000 })
  let state = definition.init({ id: 'session-4' })
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })

  assert.ok(captured !== undefined)
  assert.ok(captured.system.startsWith('SYSTEM\n\nDEVELOPER'))
  assert.ok(captured.system.includes('next ACTION'))
  assert.equal(captured.messages.at(-1).content[0].text, 'Suggest my next message.')
  assert.equal(captured.messages.some(message => message.role === 'tool'), false)

  state = definition.apply(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.text, '继续修复测试')
  assert.equal(state.mode, 'fork')
})

test('fork mode falls back to the digest when the fork yields no text', async () => {
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'user', content: [{ type: 'text', text: 'Fix the test' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The test passes.' }] },
  ]
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Fix the test' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The test passes.' }] } } },
    { type: 'turn/start', data: { turn: 1 } },
  ]
  const session = {
    id: 'session-5',
    header: {},
    deriveMessages: () => conversation,
    ownEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const listeners = {}
  let calls = 0
  let definition
  const scoped = {
    sessionProjections: { register(value) { definition = value; return () => {} } },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    get() {
      return undefined
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            calls += 1
            if (calls === 1) {
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            yield { type: 'text-delta', index: 0, text: '继续修复测试' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }
  apply({ inject: (_names, callback) => callback(scoped) }, { mode: 'fork', timeoutMs: 1000, fallback: true })
  let state = definition.init({ id: 'session-5' })
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })
  assert.equal(calls, 2)

  state = definition.apply(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.text, '继续修复测试')
  assert.equal(state.mode, 'digest')
})

test('package.json declares the minimum supported dsh runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.engines?.dsh, '^0.2.1-rc.2')
})

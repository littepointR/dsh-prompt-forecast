import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  apply,
  buildPredictionInput,
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
  assert.equal(config.maxTokens, 256)
  assert.equal(config.temperature, 0.4)
  assert.equal(config.timeoutMs, 2000)
  assert.equal(config.maxPromptChars, 80)
  assert.equal(config.maxInputChars, 6000)
  assert.equal(config.skipSubagents, true)
  assert.equal(config.provider, undefined)
  assert.equal(config.model, undefined)
})

test('resolveConfig rejects wrong types instead of propagating them', () => {
  const config = resolveConfig({
    enabled: 'no',
    maxTokens: 3.5,
    temperature: 9,
    timeoutMs: -1,
    provider: '',
    model: 42,
  })
  assert.equal(config.enabled, true)
  assert.equal(config.maxTokens, 256)
  assert.equal(config.temperature, 0.4)
  assert.equal(config.timeoutMs, 2000)
  assert.equal(config.provider, undefined)
  assert.equal(config.model, undefined)
})

test('resolveConfig keeps valid overrides', () => {
  const config = resolveConfig({ enabled: false, maxTokens: 32, timeoutMs: 900, provider: 'p', model: 'm' })
  assert.equal(config.enabled, false)
  assert.equal(config.maxTokens, 32)
  assert.equal(config.timeoutMs, 900)
  assert.equal(config.provider, 'p')
  assert.equal(config.model, 'm')
})

test('normalizePrediction strips quotes, labels, bullets, and fences', () => {
  assert.equal(normalizePrediction('"继续修复失败的测试。"'), '继续修复失败的测试。')
  assert.equal(normalizePrediction('Prompt: run the tests'), 'run the tests')
  assert.equal(normalizePrediction('下一句：提交这些改动'), '提交这些改动')
  assert.equal(normalizePrediction('- commit the changes'), 'commit the changes')
  assert.equal(normalizePrediction('```text\nfix the failing test\n```'), 'fix the failing test')
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
        assert.equal(controls.maxTokens, 256)
        return {
          config: controls,
          stream: async function* () {
            yield { type: 'text-delta', index: 0, text: '"Run the tests."' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }
  apply({ inject: (_names, callback) => callback(scoped) }, { timeoutMs: 1000 })

  assert.ok(definition !== undefined)
  let state = definition.init({ id: 'session-2' })
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })

  state = definition.apply(state, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(state.turn, 1)
  assert.equal(state.text, 'Run the tests.')
  assert.equal(state.model, 'test-model')
  assert.equal(definition.wire.view(state).text, 'Run the tests.')

  state = definition.apply(state, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(state.turn, 2)
  assert.equal(state.text, '')
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

test('package.json declares the minimum supported dsh runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.engines?.dsh, '^0.2.1-rc.2')
})

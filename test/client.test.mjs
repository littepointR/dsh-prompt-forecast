import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * Structural smoke test for the Client half.
 *
 * It executes the real factory and the real component function once so a
 * render-time mistake (bad hook use, missing guard, wrong element shape) fails
 * here. It is not a visual test and does not emulate the DOM.
 */

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
}

const requireStub = name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import('../client.js')

/** Run the component once with the given hook values. */
function render(props) {
  let registered
  const module = captured.factory(requireStub)
  module.apply({
    effect(callback) {
      return callback()
    },
    locale: { register: () => () => {} },
    slots: {
      inject(_key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registered = { options, component }
        return () => {}
      },
    },
  })
  assert.ok(registered !== undefined)
  assert.equal(registered.options.name, 'conversation.input.overlay')
  assert.equal(registered.options.id, 'prompt-forecast')
  return registered.component(props)
}

const actions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
  insertText: () => true,
}

/** Props for an empty, idle composer with the given projection text. */
function propsFor({ draft, running, subagent, text }) {
  return {
    t: key => key,
    inputActions: actions,
    useInput: selector => selector({ draft, attachmentIds: [], phase: 'plain' }),
    useSession: selector => selector({ running, subagent }),
    useProjection: (_key, selector) => selector({ text }),
  }
}

test('the Client module registers into conversation.input.overlay', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("id: '@local/dsh-prompt-forecast'"))
  assert.equal(captured.id, '@local/dsh-prompt-forecast')
})

test('an idle empty composer renders the suggested prompt', () => {
  const element = render(propsFor({ draft: '', running: false, subagent: null, text: 'Run the tests.' }))
  assert.equal(element.type, 'div')
  assert.ok(JSON.stringify(element).includes('Run the tests.'))
})

test('a non-empty draft hides the suggestion', () => {
  const element = render(propsFor({ draft: 'please', running: false, subagent: null, text: 'Run the tests.' }))
  assert.equal(element, null)
})

test('a running turn hides the suggestion', () => {
  const element = render(propsFor({ draft: '', running: true, subagent: null, text: 'Run the tests.' }))
  assert.equal(element, null)
})

test('a subagent session hides the suggestion', () => {
  const element = render(propsFor({ draft: '', running: false, subagent: { address: {} }, text: 'Run the tests.' }))
  assert.equal(element, null)
})

test('an empty projection hides the suggestion', () => {
  const element = render(propsFor({ draft: '', running: false, subagent: null, text: '' }))
  assert.equal(element, null)
})

window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-forecast',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'prompt-forecast'
    /** Host projection key owned by this bundle's Host half. */
    const PROJECTION = 'promptForecast'
    /** Slot that renders floating entries inside the resident composer card. */
    const SLOT = 'conversation.input.overlay'

    /** Component-local styles; rendered as an element so unmounting removes them. */
    const CSS = [
      '.dsh-prompt-forecast{position:absolute;top:12px;left:14px;right:10px;display:flex;',
      'height:calc(24px + var(--dsh-content-font-delta, 0px));',
      'align-items:center;gap:8px;box-sizing:border-box;border-radius:6px;pointer-events:none;z-index:2;',
      'background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-caption);',
      'font-size:inherit;line-height:inherit;animation:dsh-prompt-forecast-in 160ms ease-out;}',
      '.dsh-prompt-forecast__spark{flex:0 0 auto;color:var(--dsw-alias-brand-primary);opacity:.85;font-size:12px;}',
      '.dsh-prompt-forecast__text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;letter-spacing:.01em;}',
      '.dsh-prompt-forecast__key{flex:0 0 auto;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-1);}',
      '@keyframes dsh-prompt-forecast-in{from{opacity:0;transform:translateY(1px);}to{opacity:1;transform:none;}}',
      '@media (prefers-reduced-motion: reduce){.dsh-prompt-forecast{animation:none;}}',
    ].join('')

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      accept: 'Tab',
      hint: '按 Tab 采用这条预测',
      label: '提示词预测',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      accept: 'Tab',
      hint: 'Press Tab to use this prediction',
      label: 'Prompt prediction',
    }

    /** No-op hook used only when a framework seat is unexpectedly absent. */
    function useMissing() {
      return undefined
    }

    /** Projection selector: keep the primitive text so unchanged frames do not re-render. */
    function pickSuggestion(value) {
      return value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : ''
    }

    /** Whether the composer (or a control inside it) currently owns the keyboard. */
    function composerHasFocus() {
      const active = document.activeElement
      if (active === null || active === undefined) return false
      if (active.isContentEditable === true) return true
      return typeof active.closest === 'function' && active.closest('[data-composer-card]') !== null
    }

    /** Insert the accepted prediction at the live caret of the composer draft. */
    function accept(actions, text) {
      if (actions === undefined || actions === null) return false
      if (typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') return false
      let span
      try {
        span = actions.captureInsertion()
      } catch {
        return false
      }
      if (span === null || span === undefined) return false
      try {
        return actions.insertText(text, span) !== false
      } catch {
        return false
      }
    }

    /**
     * Ghost suggestion over the empty composer draft.
     *
     * The layer sits at the first text line and paints the input surface color
     * so the native placeholder does not read through it. It never takes
     * pointer events: a click falls through to the composer, which focuses the
     * editor; Tab is the accept gesture, Escape dismisses this suggestion.
     *
     * @param props - input state/actions, the `promptForecast` projection, the
     * session snapshot, and localized copy.
     * @returns the ghost layer, or null when no suggestion should show.
     */
    function PromptForecast(props) {
      const t = props.t
      const inputActions = props.inputActions
      const useInput = typeof props.useInput === 'function' ? props.useInput : useMissing
      const useSession = typeof props.useSession === 'function' ? props.useSession : useMissing
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : useMissing
      const input = useInput(state => state)
      const running = useSession(state => state?.running === true)
      const inSubagent = useSession(state => state?.subagent != null)
      const suggestion = useProjection(PROJECTION, pickSuggestion)
      const [dismissed, setDismissed] = React.useState('')

      const draft = input !== undefined && input !== null && typeof input.draft === 'string' ? input.draft : ''
      const attachments = input !== undefined && input !== null && Array.isArray(input.attachmentIds)
        ? input.attachmentIds.length
        : 0
      const phase = input !== undefined && input !== null ? input.phase : 'inert'
      const visible = suggestion !== ''
        && suggestion !== dismissed
        && draft === ''
        && attachments === 0
        && phase === 'plain'
        && running === false
        && inSubagent === false

      // Event handlers read the latest values through a ref so the single
      // document listener survives re-renders without re-arming per keystroke.
      const latest = React.useRef({ visible: false, suggestion: '', actions: inputActions })
      React.useEffect(() => {
        latest.current = { visible, suggestion, actions: inputActions }
      })

      React.useEffect(() => {
        const onKeyDown = event => {
          const state = latest.current
          if (!state.visible || event.defaultPrevented) return
          if (event.altKey || event.ctrlKey || event.metaKey) return
          if (!composerHasFocus()) return
          if (event.key === 'Tab' && event.shiftKey === false) {
            event.preventDefault()
            if (accept(state.actions, state.suggestion)) setDismissed(state.suggestion)
            return
          }
          if (event.key === 'Escape') setDismissed(state.suggestion)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [])

      if (!visible) return null
      const acceptLabel = typeof t === 'function' ? t('accept') : 'Tab'
      const hint = typeof t === 'function' ? t('hint') : 'Press Tab to use this prediction'
      return h(
        'div',
        {
          className: 'dsh-prompt-forecast',
          'data-dsh-prompt-forecast': '',
          role: 'status',
          'aria-live': 'polite',
          'aria-label': hint,
        },
        h('style', null, CSS),
        h('span', { className: 'dsh-prompt-forecast__spark', 'aria-hidden': true }, '✦'),
        h('span', { className: 'dsh-prompt-forecast__text' }, suggestion),
        h('span', { className: 'dsh-prompt-forecast__key', 'aria-hidden': true }, acceptLabel),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionary and the composer overlay entry.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prompt-forecast: dictionaries')
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'prompt-forecast',
              order: 30,
              locale: NS,
            },
            PromptForecast,
          ),
        )
      },
    }
  },
})

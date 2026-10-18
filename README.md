# Prompt Forecast

English | [中文](README.zh.md)

Ghost-text prediction of your next action in the DeepSeek Harness Web composer,
in the style of Codex and Claude Code prompt suggestions.

After a completed turn the Host half asks the session's own model for the single
most likely next actionable message, publishes it through a client-visible
session projection, and the Client half renders it as gray text on the first line
of an empty composer. Press **Tab** or **→** to accept it into the draft, or
**Esc** to ignore that suggestion. Typing anything hides it; the text you typed is
never replaced.

The default mode is a Codex-style context fork: the parent's current text
transcript plus one synthetic user turn, `Suggest my next message.`, with
explicit rules that restrict the answer to an action.

## Requirements

- **DSH `0.2.1-rc.2` or newer within `0.2.x`**, declared as `engines.dsh: ^0.2.1-rc.2`.
- This plugin is built on the 0.2.1-rc.2 client and Host surfaces: the
  `conversation.input.overlay` composer slot, `InputActions.captureInsertion()` /
  `insertText()`, and the session-projection carrier fed by `agent/turn-stopping`.
- `dsh plugin add` validates the range during installation and restores the
  previous profile state when it does not match; profile startup checks it
  again. An unmet range refuses to load the plugin; upgrade DSH or install a
  plugin release whose `engines.dsh` matches your runtime. A DSH `0.3` release
  will need a matching plugin release rather than an exemption.

## What it does

- Fork mode (default) predicts from the full text transcript; digest mode uses a
  compact JSON excerpt.
- Predicts the next action, not a status report or an outcome guess.
- Writes in the language the user writes in, one short line.
- Uses the route that served the turn (falling back to the profile default
  model), so no extra provider setup is required.
- Skips subagent sessions and turns with no human input.
- Fails silently: a slow, aborted, or failed prediction never surfaces an error
  in the conversation.

## What gets predicted

The target is the next **actionable** message, not a literal continuation of the
conversation. A useful suggestion is one the user would send to tell the
assistant what to do next:

- an instruction: run the tests, fix this error, check the projection cache,
  explain the failure
- a choice or approval: use option A, go ahead, keep it
- a correction: no, change the client side
- a request to explain or diagnose: why does the fork call time out?
- a short report followed by an instruction: restarted, still empty — check the
  logs

Pure status reports, test results, log observations, narration, and guesses about
what might happen are rejected; `NONE` is a valid answer. A conservative
post-filter drops obvious pure-report clauses, and fork mode falls back to the
digest when the result is unusable.

## Prediction modes

`mode: 'fork'` (default) mirrors the Codex composer-prediction shape. It takes
the session's current text transcript — system and developer instructions plus
user/assistant text — drops tool calls, tool results, reasoning, and attachment
blocks, then appends one synthetic user turn:

```text
Suggest my next message.
```

The model's reply becomes the ghost line. No child session or session event is
created; the fork is an in-memory message list for one auxiliary call. A short
action-rules block is appended to the inherited system prompt so the model writes
the user's next instruction rather than a status report. Because the whole
transcript is sent, this mode costs more tokens and needs a larger `timeoutMs`
than the digest mode.

`mode: 'digest'` keeps the earlier lightweight path: a compact JSON excerpt
(`recent_user_messages`, `latest_assistant_reply`, `tools_used`) with a short,
action-oriented system prompt. Use it for cheap predictions or long sessions
where sending the transcript is too expensive.

## Configuration

The row's `config` block in `cordis.patch.yml` overrides every default:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` leaves the Host half unregistered |
| `mode` | `fork` | `fork` = full transcript + `Suggest my next message.`; `digest` = compact JSON excerpt |
| `maxTokens` | `512` | Output budget of the prediction request |
| `temperature` | `0.4` | Sampling temperature |
| `timeoutMs` | `8000` | Hard bound on the request; a slower answer is dropped |
| `maxPromptChars` | `80` | Clip length of the predicted prompt |
| `maxForkChars` | `12000` | Character budget of the forked conversation window (system/developer text is always kept) |
| `fallback` | `true` | When the fork yields no text, retry with the compact digest |
| `maxInputChars` | `6000` | Digest-mode excerpt size bound |
| `skipSubagents` | `true` | Subagent sessions get no prediction |
| `provider` | turn route | Explicit provider override |
| `model` | turn route | Explicit model override |

The prediction is produced while the turn boundary is still open
(`agent/turn-stopping`), so its text arrives with the finished turn instead of
requiring a poll. `timeoutMs` is the price: a prediction that does not settle
within that budget is dropped and the turn finishes without one.

## Install

### From GitHub (no build step)

```bash
dsh plugin --profile web add github:littepointR/dsh-prompt-forecast
dsh web
```

`dsh plugin add` forwards to pnpm in the chosen profile, installs the package,
and automatically adds the bundle to `dsh.profile.bundles` because the package
declares `dsh.bundle.patch`. Restart the profile for the plugin to load. The
package is plain JavaScript with no `prepare` build script, so a git install
needs no extra pnpm build approval.

To pin the tagged release:

```bash
dsh plugin --profile web add github:littepointR/dsh-prompt-forecast#v0.2.2
```

The Desktop application's `desktop` profile is reserved for the Electron app, so
the CLI rejects `--profile desktop`. Use Settings → Plugins there, or install
into a CLI profile.

### From a local checkout

Use Plugin Manager with this package directory as the bundle target. The bundle
patch inserts the `prompt-forecast` row; it survives restarts because it is a
normal profile bundle.

## Limits

- Only an empty composer shows a suggestion. Completing a partially typed draft
  needs caret geometry the slot does not expose yet and is not part of this
  version.
- The suggestion is a hint, not an action: accepting inserts plain text into the
  draft and nothing is sent.
- Prediction quality depends on the session model; a very small model may return
  a generic follow-up.

## Development

```bash
node --test test/host.test.mjs test/client.test.mjs
node --check index.js && node --check client.js
```

- `index.js` — Host half: generate at `agent/turn-stopping`, publish through the
  `promptForecast` projection.
- `client.js` — Client half: register in `conversation.input.overlay`, render the
  ghost line, handle Tab/→/Esc.
- `test/host.test.mjs` — text normalization, digest building, projection fold.
- `test/client.test.mjs` — structural smoke test of the Client render branches
  (no DOM emulation).

## License

MIT

# Prompt Forecast

English | [中文](README.zh.md)

Ghost-text prediction of your next prompt in the DeepSeek Harness Web composer,
in the style of Codex and Claude Code prompt suggestions.

After a completed turn the Host half asks the session's own model for the single
most likely next human message, publishes it through a client-visible session
projection, and the Client half renders it as gray text on the first line of an
empty composer. Press **Tab** to accept it into the draft, or **Esc** to ignore
that suggestion. Typing anything hides it; the text you typed is never replaced.

## What it does

- Predicts from the real conversation: recent human messages, the latest
  assistant reply, and the tool names the turn used.
- Writes in the language the user writes in, one short line.
- Uses the route that served the turn (falling back to the profile default
  model), so no extra provider setup is required.
- Skips subagent sessions and turns with no human input.
- Fails silently: a slow, aborted, or failed prediction never surfaces an error
  in the conversation.

## Configuration

The row's `config` block in `cordis.patch.yml` overrides every default:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` leaves the Host half unregistered |
| `maxTokens` | `256` | Output budget of the prediction request |
| `temperature` | `0.4` | Sampling temperature |
| `timeoutMs` | `2000` | Hard bound on the request; a slower answer is dropped |
| `maxPromptChars` | `80` | Clip length of the predicted prompt |
| `maxInputChars` | `6000` | Size bound of the conversation excerpt |
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
dsh plugin --profile web add github:littepointR/dsh-prompt-forecast#v0.1.0
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
  ghost line, handle Tab/Esc.
- `test/host.test.mjs` — text normalization, digest building, projection fold.
- `test/client.test.mjs` — structural smoke test of the Client render branches
  (no DOM emulation).

## License

MIT

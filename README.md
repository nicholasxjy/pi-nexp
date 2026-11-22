# pi-nexp

Next-prompt prediction extension for [Pi coding agent](https://pi.dev), rendered as inline dim ghost text inside the editor.

## Features

- **Isolated side-channel prediction**: derives a compact read-only transcript (last 6 turns, truncated tool outputs, default 8,000-char budget) with `cacheRetention: "none"` and a fresh `sessionId` so it never pollutes the main session history or prompt cache.
- **Configurable model & thinking level**: independently choose any configured `provider/modelId` (or follow the active session model) and `thinkingLevel` (`off | minimal | low | medium | high | xhigh`), automatically degraded when a model does not support reasoning.
- **Composable inline ghost text**: wraps the active editor via `getEditorComponent()` so it coexists with custom editor extensions (`pi-powerline-footer`, `pi-cc-tools`, `pi-emote`, etc.) and `showHardwareCursor: true`.
  - Press `Tab` or `Right` on an empty editor to insert the full prediction for editing (does not auto-submit).
  - Press `Esc` or start typing to dismiss immediately.
  - Press `Alt+N` or run `/nexp run` to trigger prediction manually.

## Install

Local test:

```bash
pi -e ./src/index.ts
```

Install as a Pi package:

```bash
pi install /path/to/pi-nexp
```

## Configuration

Global config: `~/.pi/agent/pi-nexp.json`
Project override: `.pi/pi-nexp.json`

```json
{
  "enabled": true,
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "off",
  "maxContextChars": 8000
}
```

Omit `model` (or set it to `null`) to follow the main session's current model.

## Commands & Shortcuts

- `/nexp` — open interactive configuration menu (add `--project` to write `.pi/pi-nexp.json`)
- `/nexp on | off` — enable or disable automatic prediction after `agent_settled`
- `/nexp model <provider/modelId | follow>` — set prediction model or follow active session model
- `/nexp thinking <off|minimal|low|medium|high|xhigh>` — set prediction thinking level
- `/nexp run` / `Alt+N` — trigger a prediction immediately
- `/nexp status` — display active merged configuration

## Test

```bash
npm test
```

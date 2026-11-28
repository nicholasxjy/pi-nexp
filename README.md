# pi-nexp

Next-prompt prediction extension for [Pi coding agent](https://pi.dev), rendered as inline dim ghost text inside the editor.

## Features

- **Dual-mode prediction (`auto` / `compact` / `reuse`)**:
  - **`auto` (default)**: uses `reuse` when following the active session model with a fresh main-request snapshot (`context_with_system`), and automatically uses `compact` when an explicit prediction model is configured or the snapshot is missing/expired/invalidated (e.g. after compaction, branching, `!cmd`, model switch, or 4-minute TTL).
  - **`reuse`**: reuses the captured main-request messages/system/tools prefix with `toolChoice: "none"` and `disableContinuation: true`, keeping provider prefix cache eligibility without mutating the main session.
  - **`compact`**: derives a bounded read-only transcript from Pi's effective session projection (`buildSessionProjection`), keeping the last 6 user turns, `!cmd` bash executions, summaries, head/tail-truncated tool outputs, and a configurable char budget (`maxContextChars`, default 8,000) with `cacheRetention: "none"`.
- **Short, clean suggestions**: strict filtering rejects abstention placeholders (`None`, `N/A`, `无`), multi-line lists, and suggestions over 100 Unicode code points.
- **Configurable model, thinking level, budget & timeout**: choose any configured `provider/modelId` (or follow the active session model), set `thinkingLevel` (`follow | off | minimal | low | medium | high | xhigh`), and bound prediction latency with `timeoutMs` (default 15,000ms).
- **Composable inline ghost text**: wraps the active editor via `getEditorComponent()`, locating the active cursor line dynamically and preserving left prefixes, right borders, ANSI resets, and `showHardwareCursor: true`.
  - Press `Tab` or `Right` on an empty editor to insert the full prediction for editing (does not auto-submit).
  - Typing hides a completed suggestion; deleting the input restores it. Typing cancels any prediction still being generated.
  - Press `Esc` to discard the suggestion (including a hidden one) and cancel any pending prediction. Autocomplete keeps priority over these shortcuts.
  - Press `Alt+N` or run `/nexp run` to trigger prediction manually.
- **In-memory session diagnostics**: `/nexp status` shows effective config, `.pi/pi-nexp.json` overrides, config warnings, last run mode/fallback reason/latency/token usage, and session accept/dismiss counts (never persisted to disk).

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
  "contextMode": "auto",
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "follow",
  "maxContextChars": 8000,
  "timeoutMs": 15000
}
```

Omit `model` (or set it to `null`) to follow the main session's current model.

## Commands & Shortcuts

- `/nexp` — open interactive configuration menu (add `--project` to write `.pi/pi-nexp.json`)
- `/nexp on | off` — enable or disable automatic prediction after `agent_settled`
- `/nexp mode <auto|compact|reuse>` — set context mode
- `/nexp model <provider/modelId | follow>` — set prediction model or follow active session model
- `/nexp thinking <follow|off|minimal|low|medium|high|xhigh>` — set prediction thinking level
- `/nexp budget <1000-64000>` — set `compact` mode character budget
- `/nexp timeout <ms|Ns>` — set prediction request timeout (2,000–120,000ms)
- `/nexp run` / `Alt+N` — trigger a prediction immediately
- `/nexp status` — display active configuration, overrides, warnings, and session prediction stats

## Test

Install the declared Pi peer and dev dependencies before running typecheck and tests:

```bash
npm install --no-package-lock
npm run typecheck
npm test
```

The tests cover config diagnostics, session projection, dual-mode `reuse`/`compact` selection and fallbacks, timeout cancellation, real `pi-tui` Unicode width rendering, and `/nexp` command/editor lifecycle behavior with controlled model responses; they do not call a live model API.

With Pi 1.6+ and Python 3 on macOS or Linux, run `python3 test/startup-focus.py` to check that the editor receives input after a startup overlay closes.

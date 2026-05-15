# Tool Awareness Gate for Pi

> Intercepts every tool result, infers quality signals, injects limitation reminders into agent context, and logs structured envelopes for evaluation. **Zero code changes required in other gates.**

## Install

```bash
pi install npm:@bytesbrains/pi-tool-awareness-gate
```

Or add to `.pi/settings.json`:

```json
{
  "packages": ["npm:@bytesbrains/pi-tool-awareness-gate"]
}
```

## What It Does

Every tool your agent calls — bash, read, write, edit, browser, CI, doctor — returns a result. But how reliable is that result? The awareness gate intercepts every `tool_result` event and adds:

| Signal | What It Tells the Agent |
|---|---|
| **Status** | `success`, `partial`, `failure`, `timeout`, `unauthorized` |
| **Confidence** | 0-1 score — how reliable is this result? |
| **Completeness** | `full`, `partial`, `minimal` — did we get everything? |
| **Truncation** | Was output cut off? |
| **Freshness** | How stale is the data? |
| **Warnings** | Human + agent readable caveats |
| **Suggestions** | Actionable next steps ("retry with narrower scope") |

## How It Works

```
Tool executes → tool_result event fires
     │
     ▼
┌─────────────────────────────┐
│ 1. Infer quality signals    │  ← heuristic analysis of raw output
│ 2. Detect limitation flags  │  ← truncated? stale? scoped?
│ 3. Generate warnings        │  ← "Output was truncated"
│ 4. Format short reminder    │  ← 1-2 line summary
│ 5. Inject into agent context│  ← prepended to result text
│ 6. Log rich payload         │  ← .awareness/envelopes.log
└─────────────────────────────┘
```

### Short Reminder Example

When a tool result has issues, the agent sees:

```
⚠️ [bash] conf:0% partial truncated
   • Non-zero exit code: 1 • Output was truncated
   → Check stderr output for error details before retrying

$ ls /nonexistent
ls: /nonexistent: No such file or directory
```

### Rich Payload Example

Logged to `.awareness/envelopes.log`:

```json
{
  "timestamp": "2026-05-15T10:30:00.000Z",
  "tool": "bash",
  "invocation_id": "bash-42",
  "status": "partial",
  "latency_ms": 45,
  "quality": {
    "confidence": 0.8,
    "completeness": "full",
    "freshness": 0.5,
    "accuracy": 0.8
  },
  "limitations": { "truncated": false },
  "warnings": [],
  "suggestions": []
}
```

## Tool-Specific Inference

The gate has tool-specific heuristics for richer signals:

| Tool | Extra Signals Detected |
|---|---|
| `bash` | Exit code, stderr presence, timeout |
| `read` | Truncation at limit, offset/limit awareness |
| `write`/`edit` | Bytes written vs expected |
| `browser_*` | HTTP errors, OCR failures, timeouts |
| `ci_*` | API errors, Gitea connectivity issues |
| `doctor_*` | Informational — no warnings |

## Configuration

Create `.awarenessrc.yml` in your project root (optional — sensible defaults):

```yaml
# Enable/disable the awareness layer
enabled: true

# Inject short reminders into agent context
injectReminders: true

# Log rich payloads for evaluation
logEnvelopes: true

# Where to write envelope logs
envelopeLogPath: .awareness/envelopes.log

# Max warnings to include per short reminder (before truncation)
maxWarningsInReminder: 3

# Quality thresholds
thresholds.lowConfidence: 0.5
thresholds.staleFreshness: 0.3
thresholds.maxWarningsBeforeCritical: 5

# Tools to skip awareness tracking (comma-separated)
excludedTools:
```

## Architecture

```
tool-awareness-gate/
├── package.json
├── src/
│   ├── index.ts      ← Hooks pi.on("tool_result"), main orchestration
│   ├── types.ts      ← ToolResultEnvelope<T>, QualitySignals, LimitationFlags
│   ├── infer.ts      ← Heuristic inference from raw tool outputs
│   ├── format.ts     ← Short reminder + rich payload formatters
│   ├── config.ts     ← .awarenessrc.yml loader
│   └── helpers.ts    ← Invocation IDs, text extraction, log appending
└── README.md
```

## Integration with Other Gates

**No code changes needed.** The awareness gate works at the framework level, intercepting events from all gates automatically.

When a gate wants to provide domain-specific quality signals (richer than what inference can detect), it imports the envelope types:

```typescript
import type { ToolResultEnvelope } from "@bytesbrains/pi-tool-awareness-gate/src/types";

// Gate enriches its own result with domain-specific quality signals
return {
  content: [...],
  details: {
    ...details,
    _awareness: {
      quality: { freshness: 0.95 },  // CI just fetched live data
      limitations: { truncated: false },
    },
  },
};
```

The awareness gate will **merge** gate-provided signals with its own inference, preferring the gate's signals when available.

## Benefits

- **More trustworthy agents** — agents know when to doubt results
- **Better debugging** — structured logs show tool quality over time
- **Reduced overconfidence** — agents see explicit confidence scores
- **Progressive adoption** — works automatically, gates enrich when ready
- **Zero breaking changes** — no modifications to existing tool code

## License

MIT © [nandal](https://github.com/nandal)

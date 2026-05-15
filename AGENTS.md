# Tool Awareness Gate — Agent Instructions

This gate operates transparently. No special agent instructions needed — it injects limitation signals directly into tool result context.

## How Agents Should Use Awareness Signals

When you see a tool result prefixed with a limitation reminder:

⚠️ [bash] conf:0% partial truncated
   • Non-zero exit code: 1 • Output was truncated
   → Check stderr output for error details before retrying

**Do:**
- Read the status icon (✅ success, ⚠️ partial, ❌ failure, ⏱️ timeout, 🔒 unauthorized)
- Check `conf:N%` — confidence below 50% means the result may be unreliable
- Read warnings — they explain what went wrong
- Follow suggestions — they provide corrective actions
- For `partial` results: consider retrying or narrowing scope
- For `failure` results: do not treat the output as valid

**Don't:**
- Ignore the reminder and treat the result as authoritative
- Proceed with downstream actions based on partial/failed results without verification
- Ignore truncation warnings — you may be missing critical data

## Rich Payload Access

The full envelope is available in `details._awareness` for programmatic inspection. Agents that need to make meta-decisions (retry? escalate? ask user?) should inspect:

```typescript
details._awareness.status        // "success" | "partial" | "failure" | "timeout" | "unauthorized"
details._awareness.quality       // { confidence, completeness, freshness, accuracy }
details._awareness.limitations   // { truncated, stale, limited_scope, requires_human_review, ... }
details._awareness.warnings      // string[]
details._awareness.suggestions   // string[] (optional)
```

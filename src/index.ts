/**
 * pi-tool-awareness-gate — Main Extension
 *
 * Intercepts every tool_result event, infers quality signals and limitation
 * flags, injects short reminders into agent context, and logs structured
 * envelopes for evaluation.
 *
 * Works automatically with ALL existing gates — no code changes required.
 *
 * Events hooked:
 *   - tool_result    → infer quality, inject reminders, log envelopes
 *   - tool_error     → flag as failure
 *   - session_start  → initialize config + session state
 *   - session_shutdown → flush logs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { inferQuality, inferLimitations, inferWarnings, inferSuggestions } from "./infer";
import {
  formatShortReminder,
  formatEnvelopeLog,
  injectReminder,
} from "./format";
import {
  generateInvocationId,
  appendEnvelopeLog,
} from "./helpers";
import type {
  ToolResultEnvelope,
  RawToolResult,
  AwarenessConfig,
} from "./types";

// ── Module-level state ───────────────────────────────────────────────────────

let config: AwarenessConfig | null = null;
/** Track invocation start times to calculate latency */
const invocationStarts = new Map<string, number>();
let invocationCounter = 0;

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    invocationCounter = 0;
    invocationStarts.clear();
  });

  pi.on("session_shutdown", () => {
    invocationStarts.clear();
    config = null;
  });

  // ── Track tool execution start for latency calculation ───────────────────

  pi.on("tool_execution_start", (event) => {
    if (!config?.enabled) return;
    if (config.excludedTools.includes(event.toolName)) return;

    invocationCounter++;
    const invId = `${event.toolName}-${invocationCounter}`;
    invocationStarts.set(event.toolCallId, Date.now());
  });

  // ── Main interception: tool_result ───────────────────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    if (!config?.enabled) return;
    if (config.excludedTools.includes(event.toolName)) return;

    const startTime = invocationStarts.get(event.toolCallId);
    const latencyMs = startTime ? Date.now() - startTime : 0;
    invocationStarts.delete(event.toolCallId);

    // Prune stale entries (>5 min old) to prevent memory leak from orphaned starts
    const now = Date.now();
    for (const [key, ts] of invocationStarts) {
      if (now - ts > 300000) invocationStarts.delete(key);
    }

    // Build raw input for inference
    const raw: RawToolResult = {
      toolName: event.toolName,
      result: {
        content: event.content,
        details: event.details,
        isError: event.isError,
      },
      error: event.isError ? "tool error" : undefined,
      isError: event.isError,
      content: event.content,
      details: event.details,
    };

    // Infer quality signals
    const quality = inferQuality(raw, config);
    const limitations = inferLimitations(raw);
    const warnings = inferWarnings(raw, quality, limitations, config);
    const suggestions = inferSuggestions(raw, warnings, quality);

    // Determine status
    let status: ToolResultEnvelope["status"] = "success";
    if (event.isError) {
      status = "failure";
    } else if (limitations.truncated || limitations.limited_scope ||
               limitations.requires_human_review) {
      status = "partial";
    } else if (warnings.length > 0) {
      status = "partial";
    }

    // Build envelope
    const envelope: ToolResultEnvelope = {
      status,
      result: { content: event.content, details: event.details },
      meta: {
        tool_name: event.toolName,
        invocation_id: `${event.toolName}-${invocationCounter}`,
        latency_ms: latencyMs,
        retries: 0,
        timestamp: new Date().toISOString(),
      },
      quality,
      limitations,
      warnings,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };

    // Log rich payload
    appendEnvelopeLog(ctx.cwd, config, formatEnvelopeLog(envelope));

    // Inject short reminder into result content
    if (config.injectReminders && (warnings.length > 0 || status !== "success")) {
      const reminder = formatShortReminder(envelope, config);
      const enriched = injectReminder(
        { content: event.content, details: event.details, isError: event.isError },
        reminder,
      ) as { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean };

      return {
        content: enriched?.content ?? event.content,
        details: { ...event.details, _awareness: envelope },
        isError: event.isError,
      };
    }

    // Even without reminder injection, attach envelope to details
    return {
      details: { ...event.details, _awareness: envelope },
    };
  });

  // ── Error tracking ───────────────────────────────────────────────────────

  pi.on("tool_error", (event, ctx) => {
    if (!config?.enabled) return;
    if (config.excludedTools.includes(event.toolName)) return;

    const startTime = invocationStarts.get(event.toolCallId);
    const latencyMs = startTime ? Date.now() - startTime : 0;
    invocationStarts.delete(event.toolCallId);

    const envelope: ToolResultEnvelope = {
      status: "failure",
      result: { error: String(event.error) },
      meta: {
        tool_name: event.toolName,
        invocation_id: `${event.toolName}-${++invocationCounter}`,
        latency_ms: latencyMs,
        retries: 0,
        timestamp: new Date().toISOString(),
      },
      quality: {
        confidence: 0,
        completeness: "minimal",
        freshness: 0,
        accuracy: 0,
      },
      limitations: {
        requires_human_review: true,
      },
      warnings: [`Tool execution failed: ${String(event.error).substring(0, 200)}`],
      suggestions: ["Check tool parameters and retry", "Consider fallback approach"],
    };

    appendEnvelopeLog(ctx.cwd, config, formatEnvelopeLog(envelope));
  });
}

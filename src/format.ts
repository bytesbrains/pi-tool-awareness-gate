/**
 * pi-tool-awareness-gate — Formatters
 *
 * Formats ToolResultEnvelope into:
 * 1. Short reminders — 1-2 line summaries injected into agent context
 * 2. Rich payloads — structured JSON for logging and evaluation
 */
import type {
  ToolResultEnvelope,
  ShortReminder,
  AwarenessConfig,
} from "./types";

// ── Icons ─────────────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  success: "✅",
  partial: "⚠️",
  failure: "❌",
  timeout: "⏱️",
  unauthorized: "🔒",
};

const WARNING_PREFIX: Record<string, string> = {
  info: "ℹ️",
  warn: "⚠️",
  critical: "🚨",
};

// ── Short Reminder ────────────────────────────────────────────────────────────

/**
 * Format a short reminder (1-2 lines) for injection into agent context.
 */
export function formatShortReminder(
  envelope: ToolResultEnvelope,
  config: AwarenessConfig,
): ShortReminder {
  const parts: string[] = [];
  const icon = STATUS_ICONS[envelope.status] || "❓";
  const truncatedWarnings = envelope.warnings.slice(0, config.maxWarningsInReminder);

  // Build a compact one-liner starting with tool name
  let summary = `[${envelope.meta.tool_name}] ${icon}`;

  // Add key quality signals as compact badges
  if (envelope.quality.confidence !== undefined) {
    const pct = Math.round(envelope.quality.confidence * 100);
    summary += ` conf:${pct}%`;
  }
  if (envelope.quality.completeness && envelope.quality.completeness !== "full") {
    summary += ` ${envelope.quality.completeness}`;
  }
  if (envelope.limitations.truncated) {
    summary += " truncated";
  }
  if (envelope.limitations.stale) {
    summary += " stale";
  }

  parts.push(summary);

  // Add warnings as a second line if any
  if (truncatedWarnings.length > 0) {
    const warnText = truncatedWarnings
      .map(w => `• ${w}`)
      .join(" | ");
    parts.push(`   ${warnText}`);
  }

  if (envelope.warnings.length > config.maxWarningsInReminder) {
    const remaining = envelope.warnings.length - config.maxWarningsInReminder;
    parts.push(`   ... +${remaining} more warnings`);
  }

  // Add top suggestion if available
  if (envelope.suggestions && envelope.suggestions.length > 0) {
    parts.push(`   → ${envelope.suggestions[0]}`);
  }

  // Determine severity level
  let level: ShortReminder["level"] = "info";
  if (envelope.status === "failure" || envelope.status === "timeout") {
    level = "critical";
  } else if (
    envelope.warnings.length >= config.thresholds.maxWarningsBeforeCritical
  ) {
    level = "critical";
  } else if (
    envelope.warnings.length > 0 ||
    envelope.status === "partial"
  ) {
    level = "warn";
  }

  return {
    tool: envelope.meta.tool_name,
    summary: `${WARNING_PREFIX[level]} ${parts.join("\n")}`,
    level,
  };
}

/**
 * Inject a short reminder into a tool result's content.
 * Prepends the reminder to the first text block.
 */
export function injectReminder(
  result: unknown,
  reminder: ShortReminder,
): unknown {
  if (!result || typeof result !== "object") return result;

  const r = result as Record<string, unknown>;

  // Only inject if result has a content array (standard pi tool result)
  if (!Array.isArray(r.content) || r.content.length === 0) return result;

  const blocks = r.content as Array<Record<string, unknown>>;
  const firstTextIdx = blocks.findIndex(
    b => b.type === "text" && typeof b.text === "string",
  );

  if (firstTextIdx === -1) return result;

  const original = blocks[firstTextIdx].text as string;
  blocks[firstTextIdx] = {
    type: "text",
    text: `${reminder.summary}\n\n${original}`,
  };

  return { ...r, content: blocks };
}

// ── Rich Payload ──────────────────────────────────────────────────────────────

/**
 * Format the full ToolResultEnvelope as a loggable JSON object.
 */
export function formatEnvelopeLog(
  envelope: ToolResultEnvelope,
): Record<string, unknown> {
  return {
    timestamp: envelope.meta.timestamp,
    tool: envelope.meta.tool_name,
    invocation_id: envelope.meta.invocation_id,
    status: envelope.status,
    latency_ms: envelope.meta.latency_ms,
    quality: envelope.quality,
    limitations: envelope.limitations,
    warnings: envelope.warnings,
    suggestions: envelope.suggestions || [],
  };
}

// ── Display Formatters ────────────────────────────────────────────────────────

/**
 * Format envelope as a human-readable text block (for supervisor_status-like tools).
 */
export function formatEnvelopeDisplay(envelope: ToolResultEnvelope): string {
  const icon = STATUS_ICONS[envelope.status] || "❓";
  const lines = [
    `${icon} Tool: ${envelope.meta.tool_name}`,
    `   Status: ${envelope.status}  |  Latency: ${envelope.meta.latency_ms}ms  |  Retries: ${envelope.meta.retries}`,
    `   Invocation: ${envelope.meta.invocation_id}`,
  ];

  if (Object.keys(envelope.quality).length > 0) {
    const q = envelope.quality;
    const qParts: string[] = [];
    if (q.confidence !== undefined) qParts.push(`confidence: ${(q.confidence * 100).toFixed(0)}%`);
    if (q.completeness) qParts.push(`completeness: ${q.completeness}`);
    if (q.freshness !== undefined) qParts.push(`freshness: ${(q.freshness * 100).toFixed(0)}%`);
    lines.push(`   Quality: ${qParts.join(" | ")}`);
  }

  if (Object.keys(envelope.limitations).length > 0) {
    const activeFlags = Object.entries(envelope.limitations)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (activeFlags.length > 0) {
      lines.push(`   Limitations: ${activeFlags.join(", ")}`);
    }
  }

  if (envelope.warnings.length > 0) {
    lines.push(`   Warnings (${envelope.warnings.length}):`);
    for (const w of envelope.warnings) {
      lines.push(`     • ${w}`);
    }
  }

  if (envelope.suggestions && envelope.suggestions.length > 0) {
    lines.push(`   Suggestions:`);
    for (const s of envelope.suggestions) {
      lines.push(`     → ${s}`);
    }
  }

  return lines.join("\n");
}

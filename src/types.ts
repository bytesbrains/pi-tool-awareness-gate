/**
 * pi-tool-awareness-gate — Types
 *
 * Universal ToolResult envelope for all tool invocations.
 * Gates can import these types for domain-specific enrichment.
 */

// ── Tool Result Envelope ──────────────────────────────────────────────────────

export interface ToolResultMeta {
  /** Name of the tool that produced this result */
  tool_name: string;
  /** Unique invocation identifier */
  invocation_id: string;
  /** Wall-clock latency in milliseconds */
  latency_ms: number;
  /** Number of retries before this result */
  retries: number;
  /** ISO 8601 timestamp of invocation start */
  timestamp: string;
}

export interface QualitySignals {
  /** 0-1 confidence in the result correctness */
  confidence?: number;
  /** How complete the result is relative to what was requested */
  completeness?: "full" | "partial" | "minimal" | "unknown";
  /** 0-1 freshness — 1 = real-time, 0 = stale/unknown */
  freshness?: number;
  /** 0-1 estimated accuracy */
  accuracy?: number;
  /** Additional tool-specific quality fields */
  [key: string]: unknown;
}

export interface LimitationFlags {
  /** Result was truncated (output, pagination, context window) */
  truncated?: boolean;
  /** Data may be stale/outdated */
  stale?: boolean;
  /** Result covers only a subset of what was requested */
  limited_scope?: boolean;
  /** Human review recommended before acting on this result */
  requires_human_review?: boolean;
  /** Result may contain sensitive data */
  sensitive_content?: boolean;
  /** Additional tool-specific limitation flags */
  [key: string]: boolean | undefined;
}

export type ToolResultStatus =
  | "success"   // Complete, no known issues
  | "partial"   // Incomplete or degraded
  | "failure"   // Tool execution failed
  | "timeout"   // Tool timed out
  | "unauthorized"; // Auth/permission error

export interface ToolResultEnvelope<T = unknown> {
  /** Deterministic status for control flow decisions */
  status: ToolResultStatus;
  /** The raw tool output payload */
  result: T;
  /** Execution metadata */
  meta: ToolResultMeta;
  /** Quality signals — how reliable is this result? */
  quality: QualitySignals;
  /** Binary limitation flags — what should the agent be cautious about? */
  limitations: LimitationFlags;
  /** Human + agent readable warnings */
  warnings: string[];
  /** Actionable next steps for the agent */
  suggestions?: string[];
}

// ── Short Reminder ───────────────────────────────────────────────────────────

export interface ShortReminder {
  /** Tool name */
  tool: string;
  /** 1-2 sentence summary of limitations */
  summary: string;
  /** Severity level */
  level: "info" | "warn" | "critical";
}

// ── Awareness Config ─────────────────────────────────────────────────────────

export interface AwarenessConfig {
  /** Enable/disable the awareness layer */
  enabled: boolean;
  /** Inject short reminders into agent context (default: true) */
  injectReminders: boolean;
  /** Log rich payloads for evaluation (default: true) */
  logEnvelopes: boolean;
  /** Path for envelope log (relative to cwd) */
  envelopeLogPath: string;
  /** Max warnings to include per short reminder */
  maxWarningsInReminder: number;
  /** Severity thresholds for quality signals */
  thresholds: {
    /** Confidence below this triggers a warning */
    lowConfidence: number;
    /** Freshness below this triggers a staleness warning */
    staleFreshness: number;
    /** Max warnings before escalating to critical */
    maxWarningsBeforeCritical: number;
  };
  /** Tools to skip awareness tracking */
  excludedTools: string[];
}

export const DEFAULT_AWARENESS_CONFIG: AwarenessConfig = {
  enabled: true,
  injectReminders: true,
  logEnvelopes: true,
  envelopeLogPath: ".awareness/envelopes.log",
  maxWarningsInReminder: 3,
  thresholds: {
    lowConfidence: 0.5,
    staleFreshness: 0.3,
    maxWarningsBeforeCritical: 5,
  },
  excludedTools: [],
};

// ── Inference Input (what we have to work with from the tool_result event) ──

export interface RawToolResult {
  toolName: string;
  result: unknown;
  error?: unknown;
  /** If the tool has isError flag */
  isError?: boolean;
  /** Content array if present */
  content?: Array<{ type: string; text?: string }>;
  /** Details object if present */
  details?: Record<string, unknown>;
}

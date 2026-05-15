/**
 * pi-tool-awareness-gate — Inference Engine
 *
 * Inspects raw tool results from the `tool_result` event and
 * infers quality signals, limitation flags, and warnings.
 *
 * Inference is heuristic-based — domain-specific signals require
 * gates to enrich their results using the ToolResultEnvelope types.
 */
import type {
  RawToolResult,
  QualitySignals,
  LimitationFlags,
  AwarenessConfig,
} from "./types";
import { extractTextContent, isTextTruncated, inferStatus } from "./helpers";

/**
 * Detect common bash error patterns in command output.
 * pi's standard bash tool doesn't expose exitCode in details,
 * so we detect errors from content text heuristics.
 */
function looksLikeBashError(content: string): boolean {
  if (!content || content.length < 3) return false;

  const errorPatterns = [
    /No such file or directory/i,
    /command not found/i,
    /Permission denied/i,
    /cannot access/i,
    /not a directory/i,
    /Is a directory/i,
    /Operation not permitted/i,
    /No space left on device/i,
    /Connection refused/i,
    /Could not resolve host/i,
    /fatal:/i,
    /error:/i,
    /Error:/,
    /ERROR:/,
    /syntax error/i,
    /unexpected token/i,
    /npm error/i,
    /npm ERR!/,
    /exit code [1-9]/i,
  ];

  // Check first few lines — errors typically appear early
  const firstLines = content.split("\n").slice(0, 10).join("\n");
  for (const pattern of errorPatterns) {
    if (pattern.test(firstLines)) return true;
  }

  return false;
}

/**
 * Infer quality signals from a raw tool result.
 */
export function inferQuality(
  raw: RawToolResult,
  _config: AwarenessConfig,
): QualitySignals {
  const signals: QualitySignals = {};
  const content = extractTextContent(raw.result);
  const error = raw.error || (raw.result as any)?.isError;

  // Confidence: penalized by errors, empty results, bash errors
  if (error) {
    signals.confidence = 0.0;
  } else if (!content || content.length === 0) {
    signals.confidence = 0.3;
  } else if (raw.toolName === "bash" && looksLikeBashError(content)) {
    signals.confidence = 0.3;
  } else {
    signals.confidence = 0.8; // Default for successful tool calls
  }

  // Completeness
  if (!content || content.length === 0) {
    signals.completeness = "minimal";
  } else if (
    isTextTruncated(content) ||
    (raw.result as any)?.details?.truncated === true
  ) {
    signals.completeness = "partial";
  } else {
    signals.completeness = "full";
  }

  // Freshness — can't infer without timestamps in result
  signals.freshness = 0.5; // Unknown by default

  // Accuracy — correlated with confidence unless contradicted
  signals.accuracy = signals.confidence;

  return signals;
}

/**
 * Infer limitation flags from raw result + tool name.
 */
export function inferLimitations(raw: RawToolResult): LimitationFlags {
  const flags: LimitationFlags = {};
  const content = extractTextContent(raw.result);
  const result = raw.result as Record<string, unknown> | undefined;

  // Truncated: check heuristic + explicit flag
  flags.truncated = isTextTruncated(content) || result?.truncated === true;

  // Limited scope: partial results, filtered output
  if (result?.details) {
    const details = result.details as Record<string, unknown>;
    if (details.truncated === true) flags.truncated = true;
    if (details.totalCount && details.count) {
      flags.limited_scope = (details.count as number) < (details.totalCount as number);
    }
    // Pagination indicators
    if (details.limit && details.total) {
      flags.limited_scope = (details.limit as number) < (details.total as number);
    }
  }

  // API response indicators
  if (result) {
    // HTTP error status
    if (
      (result.status && typeof result.status === "number" && result.status >= 400) ||
      (result.statusCode && typeof result.statusCode === "number" && result.statusCode >= 400)
    ) {
      flags.requires_human_review = true;
    }

    // Rate limiting
    if (
      result.retryAfter !== undefined ||
      (typeof result.text === "string" && /rate.?limit/i.test(result.text))
    ) {
      flags.limited_scope = true;
    }
  }

  // Tool-specific inference
  switch (raw.toolName) {
    case "bash": {
      // pi's standard bash tool doesn't include exitCode in details —
      // detect errors from content text patterns instead
      if (looksLikeBashError(content)) {
        flags.requires_human_review = true;
      }
      break;
    }
    case "read": {
      // Partial reads (details.offset/limit)
      const rDetails = result?.details as Record<string, unknown> | undefined;
      if (rDetails?.offset !== undefined || rDetails?.limit !== undefined) {
        flags.limited_scope = true;
      }
      break;
    }
    case "browser_navigate":
    case "browser_click":
    case "browser_type":
    case "browser_read":
    case "browser_screenshot":
    case "browser_scroll":
    case "browser_evaluate": {
      // Browser navigations may have HTTP errors
      if (
        typeof content === "string" &&
        (content.includes("Error:") || content.includes("ERR_") || content.includes("timeout"))
      ) {
        flags.limited_scope = true;
      }
      break;
    }
    case "write":
    case "edit": {
      // File writes are usually fine but check for partial writes
      const wDetails = result?.details as Record<string, unknown> | undefined;
      if (wDetails?.bytesWritten && wDetails?.bytesExpected) {
        flags.truncated =
          (wDetails.bytesWritten as number) < (wDetails.bytesExpected as number);
      }
      break;
    }
  }

  return flags;
}

/**
 * Generate warnings from the inferred signals + tool context.
 */
export function inferWarnings(
  raw: RawToolResult,
  quality: QualitySignals,
  limitations: LimitationFlags,
  config: AwarenessConfig,
): string[] {
  const warnings: string[] = [];

  // Confidence warnings
  if (quality.confidence !== undefined && quality.confidence < config.thresholds.lowConfidence) {
    warnings.push(
      `Low confidence (${(quality.confidence * 100).toFixed(0)}%) — result may be unreliable`,
    );
  }

  // Freshness warnings
  if (quality.freshness !== undefined && quality.freshness < config.thresholds.staleFreshness) {
    warnings.push("Data may be stale — freshness score is low");
  }

  // Completeness warnings
  if (quality.completeness === "minimal") {
    warnings.push("Minimal result returned — data may be incomplete");
  } else if (quality.completeness === "partial") {
    warnings.push("Partial result — not all requested data was returned");
  }

  // Truncation
  if (limitations.truncated) {
    warnings.push("Output was truncated — some content may be missing");
  }

  // Limited scope
  if (limitations.limited_scope) {
    warnings.push("Result is scoped/limited — may not cover full request");
  }

  // Human review
  if (limitations.requires_human_review) {
    warnings.push("Human review recommended before acting on this result");
  }

  // Sensitive content
  if (limitations.sensitive_content) {
    warnings.push("Result may contain sensitive data — handle with care");
  }

  // Staleness (explicit flag)
  if (limitations.stale) {
    warnings.push("Data may be outdated — verify freshness");
  }

  // Tool-specific warnings
  const result = raw.result as Record<string, unknown> | undefined;
  const detailsWarn = result?.details as Record<string, unknown> | undefined;
  const content = extractTextContent(raw.result);

  switch (raw.toolName) {
    case "bash": {
      if (looksLikeBashError(content)) {
        // Extract the first error line for the warning
        const errLine = content.split("\n").find(l =>
          /error|Error|ERROR|cannot|denied|not found|No such/i.test(l)
        );
        if (errLine) {
          warnings.push(`Bash error: ${errLine.trim().substring(0, 100)}`);
        } else {
          warnings.push("Command produced error output");
        }
      }
      if (detailsWarn?.timedOut) {
        warnings.push("Command timed out");
      }
      break;
    }
    case "read": {
      if (detailsWarn?.truncated) {
        warnings.push("File read was truncated at limit");
      }
      break;
    }
    case "browser_navigate":
    case "browser_read": {
      if (content.includes("screenshot/OCR failed") || content.includes("OCR unavailable")) {
        warnings.push("OCR/rendering failure — page content may be incomplete");
      }
      break;
    }
    case "ci_get_logs":
    case "ci_list_runs":
    case "ci_get_run": {
      if (content.includes("❌") || content.includes("Failed")) {
        warnings.push("CI API returned errors — check Gitea connectivity");
      }
      break;
    }
    case "doctor_audit":
    case "doctor_check_file": {
      // Doctor tools are informational — no warnings needed
      break;
    }
  }

  return warnings;
}

/**
 * Generate actionable suggestions based on warnings and tool type.
 */
export function inferSuggestions(
  raw: RawToolResult,
  warnings: string[],
  quality: QualitySignals,
): string[] {
  const suggestions: string[] = [];

  if (warnings.length === 0) return suggestions;

  // Generic suggestions based on limitation types
  if (quality.completeness === "partial" || quality.completeness === "minimal") {
    suggestions.push("Consider retrying with narrower scope or pagination parameters");
  }

  if (quality.freshness !== undefined && quality.freshness < 0.3) {
    suggestions.push("Verify time-sensitive claims against a real-time source");
  }

  // Tool-specific suggestions
  switch (raw.toolName) {
    case "bash": {
      const result = raw.result as Record<string, unknown> | undefined;
      const details = result?.details as Record<string, unknown> | undefined;
      const bashContent = extractTextContent(raw.result);
      if (looksLikeBashError(bashContent)) {
        suggestions.push("Check the error output above and adjust the command");
      }
      if (details?.timedOut) {
        suggestions.push("Increase timeout or break command into smaller operations");
      }
      break;
    }
    case "read": {
      if (raw.details?.truncated) {
        suggestions.push("Use offset and limit parameters to read remaining content");
      }
      break;
    }
    case "browser_navigate":
    case "browser_click":
    case "browser_read": {
      if (extractTextContent(raw.result).includes("OCR unavailable")) {
        suggestions.push("Install tesseract.js for OCR support: npm install tesseract.js");
      }
      break;
    }
    case "ci_get_logs":
    case "ci_list_runs": {
      if (extractTextContent(raw.result).includes("Failed")) {
        suggestions.push("Verify Gitea instance is running and reachable");
        suggestions.push("Check .circ.yml configuration for correct Gitea URL");
      }
      break;
    }
  }

  return suggestions;
}

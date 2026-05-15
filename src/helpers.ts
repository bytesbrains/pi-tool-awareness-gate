/**
 * pi-tool-awareness-gate — Helpers
 *
 * Utility functions for the awareness gate.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AwarenessConfig } from "./types";

/**
 * Generate a unique invocation ID for each tool call.
 */
export function generateInvocationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Get the envelope log path (relative to cwd).
 */
export function getEnvelopeLogPath(cwd: string, config: AwarenessConfig): string {
  return path.join(cwd, config.envelopeLogPath);
}

/**
 * Append a structured envelope to the log.
 */
export function appendEnvelopeLog(
  cwd: string,
  config: AwarenessConfig,
  entry: Record<string, unknown>,
): void {
  if (!config.logEnvelopes) return;
  const logPath = getEnvelopeLogPath(cwd, config);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
}

/**
 * Extract text content from a tool result, regardless of shape.
 */
export function extractTextContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";

  const r = result as Record<string, unknown>;

  // Standard pi tool result: { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(r.content)) {
    const texts: string[] = [];
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    return texts.join("\n");
  }

  // Raw string result
  if (typeof r.text === "string") return r.text;
  if (typeof r.message === "string") return r.message;

  return "";
}

/**
 * Check if text content appears truncated.
 * Uses heuristics: sudden cutoffs, missing closing markers, etc.
 */
export function isTextTruncated(text: string): boolean {
  if (!text || text.length < 100) return false;

  // Truncation indicators in typical tool output
  const truncationMarkers = [
    /\.\.\.\s*(truncated|omitted|remaining|(?:more|d+) (?:lines|bytes))/i,
    /\[truncated\]/i,
    /<omitted\s*\/?>/i,
    /\.\.\.\s*$/m,  // trailing ellipsis on last line
    /\btruncated\b.*\b(?:output|result|response)\b/i,
    // pi read tool truncation
    /more lines in file/i,
    /Use offset=\d+ to continue/i,
  ];

  for (const marker of truncationMarkers) {
    if (marker.test(text)) return true;
  }

  // Heuristic: text ends mid-sentence with no punctuation
  const lastChar = text.trim().slice(-1);
  const lastLine = text.trim().split("\n").pop() || "";
  if (
    lastLine.length > 20 &&
    !/[.!?;:)\]}"'>]$/.test(lastChar) &&
    !/^[\s#*\-–—]/.test(lastLine)
  ) {
    // Could be truncated — moderate confidence
    // Only flag if the last line looks like a natural sentence fragment
    if (/[a-z]$/.test(lastLine) && lastLine.split(" ").length > 3) {
      return true;
    }
  }

  return false;
}

/**
 * Determine status from raw tool result.
 */
export function inferStatus(result: unknown, error?: unknown): string {
  if (error) return "failure";

  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.isError === true) return "failure";
    if (r.status && typeof r.status === "string") return r.status;
    if (r.timeout === true) return "timeout";
  }

  return "success";
}

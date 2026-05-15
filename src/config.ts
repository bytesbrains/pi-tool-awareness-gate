/**
 * pi-tool-awareness-gate — Config
 *
 * Loads .awarenessrc.yml from project root.
 * Falls back to sensible defaults if not present.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AwarenessConfig } from "./types";
import { DEFAULT_AWARENESS_CONFIG } from "./types";

export function loadConfig(cwd: string): AwarenessConfig {
  const configPath = path.join(cwd, ".awarenessrc.yml");
  const config: AwarenessConfig = { ...DEFAULT_AWARENESS_CONFIG };

  if (!fs.existsSync(configPath)) return config;

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const result: Record<string, string> = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^\s*([\w][\w.]*):\s*(.+)$/);
      if (m) {
        let v = m[2].trim();
        // Strip surrounding quotes
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        result[m[1]] = v;
      }
    }

    // Top-level booleans
    if ("enabled" in result) config.enabled = result["enabled"] !== "false";
    if ("injectReminders" in result) config.injectReminders = result["injectReminders"] !== "false";
    if ("logEnvelopes" in result) config.logEnvelopes = result["logEnvelopes"] !== "false";

    // Strings
    if (result["envelopeLogPath"]) config.envelopeLogPath = result["envelopeLogPath"];
    if (result["excludedTools"]) {
      config.excludedTools = result["excludedTools"].split(",").map(s => s.trim()).filter(Boolean);
    }

    // Numbers
    if (result["maxWarningsInReminder"]) {
      const n = parseInt(result["maxWarningsInReminder"], 10);
      if (!isNaN(n)) config.maxWarningsInReminder = n;
    }
    if (result["thresholds.lowConfidence"]) {
      const n = parseFloat(result["thresholds.lowConfidence"]);
      if (!isNaN(n)) config.thresholds.lowConfidence = n;
    }
    if (result["thresholds.staleFreshness"]) {
      const n = parseFloat(result["thresholds.staleFreshness"]);
      if (!isNaN(n)) config.thresholds.staleFreshness = n;
    }
    if (result["thresholds.maxWarningsBeforeCritical"]) {
      const n = parseInt(result["thresholds.maxWarningsBeforeCritical"], 10);
      if (!isNaN(n)) config.thresholds.maxWarningsBeforeCritical = n;
    }

    return config;
  } catch {
    return config;
  }
}

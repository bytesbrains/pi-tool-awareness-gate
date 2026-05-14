import * as fs from "node:fs";
import * as path from "node:path";

export interface CiConfig {
  /** Max log lines returned per job (prevents context overflow) */
  maxLogLines: number;
  /** Enable/disable the rerun tool */
  allowRerun: boolean;
  /** Enable/disable the cancel tool */
  allowCancel: boolean;
  /** Default limit for listing runs */
  defaultLimit: number;
}

export const DEFAULT_CONFIG: CiConfig = {
  maxLogLines: 200,
  allowRerun: true,
  allowCancel: true,
  defaultLimit: 20,
};

export function loadConfig(cwd: string): CiConfig {
  const configPath = path.join(cwd, ".circ.yml");
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const result: Record<string, unknown> = {};
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([\w][\w.]*):\s*(.+)$/);
      if (m) {
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        )
          val = val.slice(1, -1);
        result[m[1]] = val;
      }
    }
    return {
      maxLogLines: parseInt(result["maxLogLines"] as string) || DEFAULT_CONFIG.maxLogLines,
      allowRerun:
        result["allowRerun"] !== undefined
          ? result["allowRerun"] === "true"
          : DEFAULT_CONFIG.allowRerun,
      allowCancel:
        result["allowCancel"] !== undefined
          ? result["allowCancel"] === "true"
          : DEFAULT_CONFIG.allowCancel,
      defaultLimit:
        parseInt(result["defaultLimit"] as string) || DEFAULT_CONFIG.defaultLimit,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

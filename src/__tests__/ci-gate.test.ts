import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../config";
import { truncateLogs, checkRateLimit } from "../helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ═══════════════════════════════════════
// Config
// ═══════════════════════════════════════
describe("CiConfig", () => {
  it("returns defaults when no config file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    const config = loadConfig(tmp);
    expect(config.maxLogLines).toBe(200);
    expect(config.allowRerun).toBe(true);
    expect(config.allowCancel).toBe(true);
    expect(config.defaultLimit).toBe(20);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses .circ.yml", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    fs.writeFileSync(
      path.join(tmp, ".circ.yml"),
      ["maxLogLines: 100", "allowRerun: false", "allowCancel: false", "defaultLimit: 10"].join("\n"),
    );
    const config = loadConfig(tmp);
    expect(config.maxLogLines).toBe(100);
    expect(config.allowRerun).toBe(false);
    expect(config.allowCancel).toBe(false);
    expect(config.defaultLimit).toBe(10);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses quoted string values", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    fs.writeFileSync(path.join(tmp, ".circ.yml"), 'maxLogLines: "256"');
    const config = loadConfig(tmp);
    expect(config.maxLogLines).toBe(256);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("handles partial config with defaults for missing keys", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    fs.writeFileSync(path.join(tmp, ".circ.yml"), "maxLogLines: 50");
    const config = loadConfig(tmp);
    expect(config.maxLogLines).toBe(50);
    expect(config.allowRerun).toBe(DEFAULT_CONFIG.allowRerun);
    expect(config.allowCancel).toBe(DEFAULT_CONFIG.allowCancel);
    expect(config.defaultLimit).toBe(DEFAULT_CONFIG.defaultLimit);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("handles invalid YAML gracefully", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    fs.writeFileSync(path.join(tmp, ".circ.yml"), "::: invalid :::");
    const config = loadConfig(tmp);
    expect(config).toEqual(DEFAULT_CONFIG);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════
// Log Truncation
// ═══════════════════════════════════════
describe("truncateLogs", () => {
  it("returns full text when under limit", () => {
    const text = "line 1\nline 2\nline 3";
    const result = truncateLogs(text, 10);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.totalLines).toBe(3);
  });

  it("returns full text when exactly at limit", () => {
    const text = "a\nb\nc\nd\ne";
    const result = truncateLogs(text, 5);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(5);
  });

  it("truncates when over limit, keeping head and tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = truncateLogs(text, 20);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(100);
    // Should contain a truncation marker
    expect(result.text).toContain("lines truncated");
    // Head portion should have first lines
    expect(result.text).toContain("line 1");
    // Tail portion should have last lines
    expect(result.text).toContain("line 100");
    // Should not exceed the limit significantly
    const outputLines = result.text.split("\n");
    expect(outputLines.length).toBeLessThanOrEqual(24); // 20 + marker lines
  });

  it("handles empty string", () => {
    const result = truncateLogs("", 100);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1); // empty string split gives [""]
    expect(result.text).toBe("");
  });
});

// ═══════════════════════════════════════
// Rate Limiter
// ═══════════════════════════════════════
describe("checkRateLimit", () => {
  it("allows first call", () => {
    const result = checkRateLimit("test-key-1", 10);
    expect(result.allowed).toBe(true);
    expect(result.retryAfter).toBe(0);
  });

  it("blocks second call within cooldown", () => {
    const key = "test-key-2";
    checkRateLimit(key, 10); // first call
    const result = checkRateLimit(key, 10); // second call immediately
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it("different keys don't interfere", () => {
    checkRateLimit("key-a", 10);
    const result = checkRateLimit("key-b", 10);
    expect(result.allowed).toBe(true);
  });

  it("retryAfter is a positive integer", () => {
    const key = "test-key-3";
    checkRateLimit(key, 60);
    const result = checkRateLimit(key, 60);
    expect(result.allowed).toBe(false);
    expect(Number.isInteger(result.retryAfter)).toBe(true);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════
import {
  listWorkflowsTool,
  listRunsTool,
  getRunTool,
  listJobsTool,
  getLogsTool,
  rerunTool,
  cancelTool,
} from "../tools/ci";

describe("ci tool definitions", () => {
  it("listWorkflowsTool has proper metadata", () => {
    expect(listWorkflowsTool.name).toBe("ci_list_workflows");
    expect(listWorkflowsTool.label).toBe("List Workflows");
    expect(listWorkflowsTool.description).toContain("registered CI workflows");
  });

  it("listRunsTool has filter parameters (actor removed — Gitea has no actor field)", () => {
    expect(listRunsTool.name).toBe("ci_list_runs");
    const props = (listRunsTool.parameters as any)?.properties;
    expect(props["workflow"]).toBeDefined();
    expect(props["status"]).toBeDefined();
    expect(props["branch"]).toBeDefined();
    expect(props["event"]).toBeDefined();
    expect(props["limit"]).toBeDefined();
    expect(props["actor"]).toBeUndefined();
  });

  it("getRunTool requires run_index", () => {
    expect(getRunTool.name).toBe("ci_get_run");
    const props = (getRunTool.parameters as any)?.properties;
    expect(props["run_index"]).toBeDefined();
  });

  it("listJobsTool requires run_index", () => {
    expect(listJobsTool.name).toBe("ci_list_jobs");
    const props = (listJobsTool.parameters as any)?.properties;
    expect(props["run_index"]).toBeDefined();
  });

  it("getLogsTool has run_index and optional job_index", () => {
    expect(getLogsTool.name).toBe("ci_get_logs");
    const props = (getLogsTool.parameters as any)?.properties;
    expect(props["run_index"]).toBeDefined();
    expect(props["job_index"]).toBeDefined();
  });

  it("rerunTool requires confirm=true and accepts optional branch", () => {
    expect(rerunTool.name).toBe("ci_rerun");
    const props = (rerunTool.parameters as any)?.properties;
    expect(props["run_index"]).toBeDefined();
    expect(props["confirm"]).toBeDefined();
    expect(props["branch"]).toBeDefined();
    // confirm is required (not optional)
    const required = (rerunTool.parameters as any)?.required || [];
    expect(required).toContain("confirm");
  });

  it("cancelTool requires confirm=true", () => {
    expect(cancelTool.name).toBe("ci_cancel");
    const props = (cancelTool.parameters as any)?.properties;
    expect(props["run_index"]).toBeDefined();
    expect(props["confirm"]).toBeDefined();
    const required = (cancelTool.parameters as any)?.required || [];
    expect(required).toContain("confirm");
  });
});

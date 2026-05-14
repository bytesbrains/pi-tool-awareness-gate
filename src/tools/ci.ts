import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import { resolveGitea, giteaApi, truncateLogs, checkRateLimit } from "../helpers";

// ─── Helper ─────────────────────────────────────────────────────────────────────

function opts(ctx: ExtensionContext) {
  return resolveGitea(ctx.cwd);
}

function guard(
  enabled: boolean,
  name: string,
): null | { content: { type: "text"; text: string }[]; isError: true; details: {} } {
  if (!enabled) {
    return {
      content: [{ type: "text", text: `⛔ "${name}" is disabled via .circ.yml (allowRerun/allowCancel: false).` }],
      isError: true,
      details: {},
    };
  }
  return null;
}

function confirm(
  confirmed: boolean,
  action: string,
): null | { content: { type: "text"; text: string }[]; isError: true; details: {} } {
  if (!confirmed) {
    return {
      content: [
        {
          type: "text",
          text: `⚠️ Destructive action: ${action}\nPass confirm=true to proceed.`,
        },
      ],
      isError: true,
      details: {},
    };
  }
  return null;
}

function rateLimit(
  key: string,
  seconds: number,
): null | { content: { type: "text"; text: string }[]; isError: true; details: {} } {
  const rl = checkRateLimit(key, seconds);
  if (!rl.allowed) {
    return {
      content: [
        {
          type: "text",
          text: `⏳ Rate limited. Try again in ${rl.retryAfter}s.`,
        },
      ],
      isError: true,
      details: { retryAfter: rl.retryAfter },
    };
  }
  return null;
}

// ─── List Workflows ─────────────────────────────────────────────────────────────

export const listWorkflowsTool = {
  name: "ci_list_workflows" as const,
  label: "List Workflows",
  description:
    "List registered CI workflows in the repository. Returns workflow ID, name, path, and state.",
  parameters: Type.Object({}),
  async execute(_id: string, _p: any, _s: any, _u: any, ctx: ExtensionContext) {
    const r = giteaApi("/actions/workflows", "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok || !r.data) {
      return {
        content: [{ type: "text", text: `❌ Failed to list workflows: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const workflows = (r.data as any)?.workflows ?? [];
    if (workflows.length === 0) {
      return { content: [{ type: "text", text: "No workflows registered." }], details: { count: 0 } };
    }
    const lines = [`🔧 Workflows (${workflows.length})`, ""];
    for (const w of workflows) {
      const badge = w.state === "active" ? "🟢" : w.state === "disabled" ? "🔴" : "⚪";
      lines.push(`   ${badge} #${w.id} ${w.name}`);
      lines.push(`        path: ${w.path}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { count: workflows.length } };
  },
};

// ─── List Runs ──────────────────────────────────────────────────────────────────

export const listRunsTool = {
  name: "ci_list_runs" as const,
  label: "List Workflow Runs",
  description:
    "List workflow runs with optional filters: workflow ID, status, branch, actor, event. Returns run index, status, conclusion, and timing.",
  parameters: Type.Object({
    workflow: Type.Optional(Type.String({ description: "Workflow ID to filter by" })),
    status: Type.Optional(
      Type.String({ description: "Filter by status: unknown, waiting, running, success, failure, cancelled, skipped, blocked" }),
    ),
    branch: Type.Optional(Type.String({ description: "Filter by branch name" })),
    actor: Type.Optional(Type.String({ description: "Filter by actor/trigger username" })),
    event: Type.Optional(Type.String({ description: "Filter by trigger event: push, pull_request, schedule" })),
    limit: Type.Optional(Type.Number({ description: "Max runs to return (default: 20, max: 50)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    const queryParts: string[] = [];
    const limit = Math.min(params.limit || config.defaultLimit, 50);
    queryParts.push(`limit=${limit}`);
    if (params.workflow) queryParts.push(`workflow_id=${encodeURIComponent(params.workflow)}`);
    if (params.status) queryParts.push(`status=${encodeURIComponent(params.status)}`);
    if (params.branch) queryParts.push(`branch=${encodeURIComponent(params.branch)}`);
    if (params.actor) queryParts.push(`actor=${encodeURIComponent(params.actor)}`);
    if (params.event) queryParts.push(`event=${encodeURIComponent(params.event)}`);

    const r = giteaApi(`/actions/runs?${queryParts.join("&")}`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to list runs: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const runs = (r.data as any)?.workflow_runs ?? [];
    if (runs.length === 0) {
      return { content: [{ type: "text", text: "No workflow runs found." }], details: { count: 0 } };
    }

    const lines = [`🏃 Workflow Runs (${runs.length})`, ""];
    for (const run of runs) {
      const icon = statusIcon(run.status, run.conclusion);
      const duration = run.updated_at && run.created_at
        ? formatDuration(run.created_at, run.updated_at)
        : "";
      lines.push(`   ${icon} #${run.run_number} ${run.display_title || run.title || "(untitled)"}`);
      lines.push(`        status: ${run.status}  |  conclusion: ${run.conclusion || "—"}  |  ${duration}`);
      lines.push(`        branch: ${run.head_branch}  |  event: ${run.event}  |  by: ${run.actor?.login || "?"}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: runs.length },
    };
  },
};

// ─── Get Run ────────────────────────────────────────────────────────────────────

export const getRunTool = {
  name: "ci_get_run" as const,
  label: "Get Run Details",
  description:
    "Get full details of a single workflow run: status, conclusion, timing, trigger info, and commit.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run index (numeric)" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runIndex = params.run_index;
    const r = giteaApi(`/actions/runs/${runIndex}`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok || !r.data) {
      return {
        content: [{ type: "text", text: `❌ Run #${runIndex} not found: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const run = r.data as Record<string, unknown>;
    const icon = statusIcon(run.status as string, run.conclusion as string);
    const duration = run.started_at && run.stopped_at
      ? formatDuration(run.started_at as string, run.stopped_at as string)
      : run.started_at
        ? `running since ${(run.started_at as string).slice(0, 19).replace("T", " ")}`
        : "";

    const lines = [
      `🏃 Run #${runIndex} ${icon}`,
      `   Title:    ${run.display_title || run.title || "(untitled)"}`,
      `   Status:   ${run.status}  |  Conclusion: ${run.conclusion || "—"}`,
      `   Branch:   ${run.head_branch}  |  Event: ${run.event}`,
      `   Commit:   ${(run.head_sha as string)?.slice(0, 8) || "?"}`,
      `   Actor:    ${(run.actor as any)?.login || "?"}`,
      `   Created:  ${(run.created_at as string)?.slice(0, 19).replace("T", " ") || "?"}`,
      `   Duration: ${duration}`,
      `   URL:      ${run.html_url || "—"}`,
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runIndex, status: run.status, conclusion: run.conclusion },
    };
  },
};

// ─── List Jobs ──────────────────────────────────────────────────────────────────

export const listJobsTool = {
  name: "ci_list_jobs" as const,
  label: "List Run Jobs",
  description:
    "List jobs for a specific workflow run. Shows job name, status, conclusion, runner, and timing.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run index" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runIndex = params.run_index;
    const r = giteaApi(`/actions/runs/${runIndex}/jobs`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok || !r.data) {
      return {
        content: [{ type: "text", text: `❌ Failed to list jobs for run #${runIndex}: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const jobs = (r.data as any)?.jobs ?? [];
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: `No jobs found for run #${runIndex}.` }], details: { count: 0 } };
    }

    const lines = [`📋 Jobs for Run #${runIndex} (${jobs.length})`, ""];
    for (const j of jobs) {
      const icon = statusIcon(j.status, j.conclusion);
      const duration = j.started_at && j.stopped_at
        ? formatDuration(j.started_at, j.stopped_at)
        : j.started_at ? "running…" : "";
      lines.push(`   ${icon} #${j.id} ${j.name}`);
      lines.push(`        status: ${j.status}  |  conclusion: ${j.conclusion || "—"}  |  ${duration}`);
      lines.push(`        runner: ${j.runner_name || "?"}  |  workflow: ${j.workflow_name || "?"}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runIndex, count: jobs.length },
    };
  },
};

// ─── Get Logs ───────────────────────────────────────────────────────────────────

export const getLogsTool = {
  name: "ci_get_logs" as const,
  label: "Get Job Logs",
  description:
    "Get logs for a job in a workflow run. Logs are truncated to the configured max lines, showing the head and tail so you can see setup and failures.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run index" }),
    job_index: Type.Optional(Type.String({ description: "Job index (optional; fetches all jobs' logs if omitted)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    const runIndex = params.run_index;

    // If a specific job is requested, fetch just that job's logs
    if (params.job_index) {
      const r = giteaApi(`/actions/runs/${runIndex}/jobs/${params.job_index}/logs`, "GET", null, opts(ctx), ctx.cwd);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `❌ Failed to get logs for job #${params.job_index}: ${r.error || "no logs available"}` }],
          isError: true,
          details: {},
        };
      }
      const raw = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const { text, truncated, totalLines } = truncateLogs(raw, config.maxLogLines);
      const header = truncated
        ? `📜 Job #${params.job_index} logs (${totalLines} lines, showing ${config.maxLogLines} — truncated)\n\n`
        : `📜 Job #${params.job_index} logs (${totalLines} lines)\n\n`;
      return {
        content: [{ type: "text", text: header + text }],
        details: { runIndex, jobIndex: params.job_index, totalLines, truncated },
      };
    }

    // Fetch all jobs' logs — list jobs first, then fetch each
    const jobsR = giteaApi(`/actions/runs/${runIndex}/jobs`, "GET", null, opts(ctx), ctx.cwd);
    if (!jobsR.ok || !jobsR.data) {
      return {
        content: [{ type: "text", text: `❌ Failed to list jobs for run #${runIndex}` }],
        isError: true,
        details: {},
      };
    }
    const jobs = (jobsR.data as any)?.jobs ?? [];
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: `No jobs for run #${runIndex}.` }], details: {} };
    }

    const parts: string[] = [`📜 Logs for Run #${runIndex} (${jobs.length} jobs)`, ""];
    for (const j of jobs) {
      const logR = giteaApi(`/actions/runs/${runIndex}/jobs/${j.id}/logs`, "GET", null, opts(ctx), ctx.cwd);
      const raw = logR.ok && typeof logR.data === "string" ? logR.data : logR.ok ? JSON.stringify(logR.data) : `(no logs: ${logR.error || "unknown"})`;
      const { text, truncated, totalLines } = truncateLogs(raw, config.maxLogLines);
      const icon = statusIcon(j.status, j.conclusion);
      parts.push(`─── ${icon} Job #${j.id}: ${j.name} ───`);
      if (truncated) parts.push(`   (${totalLines} lines total, showing ${config.maxLogLines} — head + tail)`);
      parts.push(text, "");
    }
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { runIndex, jobCount: jobs.length },
    };
  },
};

// ─── Rerun ──────────────────────────────────────────────────────────────────────

export const rerunTool = {
  name: "ci_rerun" as const,
  label: "Re-run Workflow",
  description:
    "Re-run a failed or cancelled workflow run. Requires confirm=true for safety.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run index to re-run" }),
    confirm: Type.Boolean({ description: "Must be true to confirm the re-run" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // Safety gate 1: feature flag
    const flag = guard(config.allowRerun, "ci_rerun");
    if (flag) return flag;

    // Safety gate 2: explicit confirmation
    const conf = confirm(params.confirm === true, `re-run workflow run #${params.run_index}`);
    if (conf) return conf;

    // Safety gate 3: rate limit
    const rl = rateLimit(`rerun:${params.run_index}`, 60);
    if (rl) return rl;

    const r = giteaApi(`/actions/runs/${params.run_index}/rerun`, "POST", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      const detail = r.statusCode === 422 ? "Run may already be in progress or not in a re-runnable state." : r.error;
      return {
        content: [{ type: "text", text: `❌ Failed to re-run #${params.run_index}: ${detail}` }],
        isError: true,
        details: {},
      };
    }
    return {
      content: [{ type: "text", text: `🔄 Re-run triggered for run #${params.run_index}.` }],
      details: { runIndex: params.run_index },
    };
  },
};

// ─── Cancel ─────────────────────────────────────────────────────────────────────

export const cancelTool = {
  name: "ci_cancel" as const,
  label: "Cancel Workflow Run",
  description:
    "Cancel a running workflow run. Requires confirm=true for safety.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run index to cancel" }),
    confirm: Type.Boolean({ description: "Must be true to confirm cancellation" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // Safety gate 1: feature flag
    const flag = guard(config.allowCancel, "ci_cancel");
    if (flag) return flag;

    // Safety gate 2: explicit confirmation
    const conf = confirm(params.confirm === true, `cancel workflow run #${params.run_index}`);
    if (conf) return conf;

    // Safety gate 3: rate limit
    const rl = rateLimit(`cancel:${params.run_index}`, 60);
    if (rl) return rl;

    const r = giteaApi(`/actions/runs/${params.run_index}/cancel`, "POST", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to cancel #${params.run_index}: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    return {
      content: [{ type: "text", text: `🛑 Cancelled run #${params.run_index}.` }],
      details: { runIndex: params.run_index },
    };
  },
};

// ─── Formatting helpers ─────────────────────────────────────────────────────────

function statusIcon(status: string, conclusion?: string): string {
  if (status === "running") return "🔄";
  if (status === "waiting" || status === "blocked") return "⏳";
  if (status === "cancelled") return "🚫";
  if (conclusion === "success") return "✅";
  if (conclusion === "failure") return "❌";
  if (conclusion === "skipped") return "⏭️";
  return "⚪";
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

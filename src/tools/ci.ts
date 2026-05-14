import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import { resolveGitea, giteaApi, truncateLogs, checkRateLimit } from "../helpers";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface GiteaRun {
  id: number;
  run_number: number;
  display_title: string;
  path: string; // workflow file path, e.g. ".gitea/workflows/ci.yml"
  event: string;
  head_branch: string;
  head_sha: string;
  status: string; // pending, queued, in_progress
  conclusion: string | null; // failure, success, skipped, cancelled
  started_at: string;
  completed_at: string | null;
  html_url: string;
  url: string;
  run_attempt: number;
}

interface GiteaJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  head_branch: string;
  head_sha: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

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
    const r = await giteaApi("/actions/workflows", "GET", null, opts(ctx), ctx.cwd);
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
    "List workflow runs with optional filters: workflow path, status, branch, event. Returns run ID, status, and timing.",
  parameters: Type.Object({
    workflow: Type.Optional(Type.String({ description: "Workflow path or ID to filter by (e.g., '.gitea/workflows/ci.yml' or 'ci.yml')" })),
    status: Type.Optional(
      Type.String({ description: "Filter by status: pending, queued, in_progress, failure, success, skipped" }),
    ),
    branch: Type.Optional(Type.String({ description: "Filter by branch name" })),
    event: Type.Optional(Type.String({ description: "Filter by trigger event: push, pull_request, schedule" })),
    limit: Type.Optional(Type.Number({ description: "Max runs to return (default: 20, max: 50)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    const limit = Math.min(params.limit || config.defaultLimit, 50);

    // Build query string with server-side filters (Gitea supports: event, branch, status)
    const qs = [`limit=${limit}`, "page=1"];
    if (params.event) qs.push(`event=${encodeURIComponent(params.event)}`);
    if (params.branch) qs.push(`branch=${encodeURIComponent(params.branch)}`);
    if (params.status) qs.push(`status=${encodeURIComponent(params.status)}`);

    const r = await giteaApi(`/actions/runs?${qs.join("&")}`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to list runs: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    let runs: GiteaRun[] = (r.data as any)?.workflow_runs ?? [];

    // Client-side workflow filter (Gitea doesn't support server-side workflow filter on /runs)
    if (params.workflow) {
      const wf = params.workflow.toLowerCase();
      runs = runs.filter((run: GiteaRun) => {
        const path = (run.path || "").toLowerCase();
        return path.includes(wf) || String(run.id) === wf;
      });
    }

    if (runs.length === 0) {
      return { content: [{ type: "text", text: "No workflow runs found." }], details: { count: 0 } };
    }

    const lines = [`🏃 Workflow Runs (${runs.length})`, ""];
    for (const run of runs) {
      const icon = statusIcon(run.status, run.conclusion);
      const duration = run.started_at && run.completed_at
        ? formatDuration(run.started_at, run.completed_at)
        : run.started_at
          ? "running..."
          : "";
      lines.push(`   ${icon} id=${run.id}  run#${run.run_number}  ${run.display_title || "(untitled)"}`);
      lines.push(`        status: ${run.conclusion || run.status}  |  ${duration}`);
      lines.push(`        branch: ${run.head_branch}  |  event: ${run.event}  |  workflow: ${run.path}`);
      lines.push(`        commit: ${(run.head_sha || "?").slice(0, 8)}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: runs.length, totalCount: (r.data as any)?.total_count },
    };
  },
};

// ─── Get Run ────────────────────────────────────────────────────────────────────

export const getRunTool = {
  name: "ci_get_run" as const,
  label: "Get Run Details",
  description:
    "Get a specific workflow run by ID. Also fetches its jobs so you can see all job statuses at a glance.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run ID (numeric, e.g. '42'). Use ci_list_runs to find IDs." }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runId = parseInt(params.run_index, 10);
    if (isNaN(runId)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run ID.` }],
        isError: true,
        details: {},
      };
    }

    // Fetch the run directly
    const runR = await giteaApi(`/actions/runs/${runId}`, "GET", null, opts(ctx), ctx.cwd);
    if (!runR.ok) {
      return {
        content: [{ type: "text", text: `❌ Run #${runId} not found: ${runR.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const run: GiteaRun = (runR.data as any) || {};

    // Also fetch jobs for this run
    const jobs: GiteaJob[] = [];
    const jobsR = await giteaApi(`/actions/runs/${runId}/jobs?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (jobsR.ok) {
      jobs.push(...((jobsR.data as any)?.jobs ?? []));
    }

    const created = (run.started_at || "?").slice(0, 19).replace("T", " ");
    const sha = (run.head_sha || "?").slice(0, 8);

    const lines = [
      `🏃 Run #${run.run_number} (id=${run.id})`,
      `   Title:    ${run.display_title || "(untitled)"}`,
      `   Branch:   ${run.head_branch}  |  Event: ${run.event}`,
      `   Commit:   ${sha}  |  Workflow: ${run.path}`,
      `   Started:  ${created}`,
      `   URL:      ${run.html_url || "—"}`,
      `   Status:   ${run.conclusion || run.status}  |  Attempt: ${run.run_attempt || 1}`,
      "",
    ];

    if (jobs.length > 0) {
      lines.push(`   Jobs (${jobs.length}):`);
      for (const j of jobs) {
        const icon = statusIcon(j.status, j.conclusion);
        lines.push(`   ${icon} id=${j.id}  ${j.name}  →  ${j.conclusion || j.status}`);
      }
    } else {
      lines.push(`   Jobs: (could not fetch — Gitea may not support /runs/{id}/jobs on this version)`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runId, runNumber: run.run_number, jobCount: jobs.length, workflow: run.path },
    };
  },
};

// ─── List Jobs ──────────────────────────────────────────────────────────────────

export const listJobsTool = {
  name: "ci_list_jobs" as const,
  label: "List Run Jobs",
  description:
    "List jobs for a specific workflow run by run ID. Returns job ID, name, status, and duration.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run ID (numeric, e.g. '42'). Use ci_list_runs to find IDs." }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runId = parseInt(params.run_index, 10);
    if (isNaN(runId)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run ID.` }],
        isError: true,
        details: {},
      };
    }

    const r = await giteaApi(`/actions/runs/${runId}/jobs?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch jobs for run #${runId}: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const jobs: GiteaJob[] = (r.data as any)?.jobs ?? [];

    if (jobs.length === 0) {
      return { content: [{ type: "text", text: `No jobs found for run #${runId}.` }], details: { count: 0 } };
    }

    const lines = [`📋 Jobs for Run #${runId} (${jobs.length})`, ""];
    for (const j of jobs) {
      const icon = statusIcon(j.status, j.conclusion);
      const duration = j.started_at && j.completed_at
        ? formatDuration(j.started_at, j.completed_at)
        : j.started_at
          ? "running..."
          : "";
      lines.push(`   ${icon} id=${j.id}  ${j.name}`);
      lines.push(`        status: ${j.conclusion || j.status}  |  ${duration}`);
      if (j.head_branch) {
        lines.push(`        branch: ${j.head_branch}  |  commit: ${(j.head_sha || "?").slice(0, 8)}`);
      }
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runId, count: jobs.length },
    };
  },
};

// ─── Get Logs ───────────────────────────────────────────────────────────────────

export const getLogsTool = {
  name: "ci_get_logs" as const,
  label: "Get Job Logs",
  description:
    "Get logs for a job by job ID, or all jobs in a run by run ID. Logs are truncated to the configured max lines, showing the head and tail.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run ID (numeric). If job_index is omitted, fetches logs for all jobs in this run." }),
    job_index: Type.Optional(Type.String({ description: "Job ID (numeric, e.g. '512'). If provided, fetches just that job's logs directly." })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // Path A: direct job ID — fetch that specific job's logs
    if (params.job_index) {
      const jobId = params.job_index;
      const r = await giteaApi(`/actions/jobs/${jobId}/logs`, "GET", null, opts(ctx), ctx.cwd);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `❌ Failed to get logs for job #${jobId}: ${r.error || "no logs available"}` }],
          isError: true,
          details: {},
        };
      }
      const raw = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
      const { text, truncated, totalLines } = truncateLogs(raw, config.maxLogLines);
      const header = truncated
        ? `📜 Job #${jobId} logs (${totalLines} lines, showing ${config.maxLogLines} — truncated)\n\n`
        : `📜 Job #${jobId} logs (${totalLines} lines)\n\n`;
      return {
        content: [{ type: "text", text: header + text }],
        details: { jobId, totalLines, truncated },
      };
    }

    // Path B: run ID — discover jobs via /runs/{id}/jobs, then fetch each job's logs
    const runId = parseInt(params.run_index, 10);
    if (isNaN(runId)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run ID.` }],
        isError: true,
        details: {},
      };
    }

    const jobsR = await giteaApi(`/actions/runs/${runId}/jobs?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!jobsR.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch jobs for run #${runId}: ${jobsR.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const jobs: GiteaJob[] = (jobsR.data as any)?.jobs ?? [];
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: `No jobs found for run #${runId}.` }], details: {} };
    }

    // Fetch logs for each job using its real job ID
    const parts: string[] = [`📜 Logs for Run #${runId} (${jobs.length} jobs)`, ""];
    for (const j of jobs) {
      const logR = await giteaApi(`/actions/jobs/${j.id}/logs`, "GET", null, opts(ctx), ctx.cwd);
      const icon = statusIcon(j.status, j.conclusion);
      if (logR.ok && typeof logR.data === "string") {
        const { text, truncated, totalLines } = truncateLogs(logR.data, config.maxLogLines);
        parts.push(`─── ${icon} Job id=${j.id} (${j.name}) ───`);
        if (truncated) parts.push(`   (${totalLines} lines total, showing ${config.maxLogLines} — head + tail)`);
        parts.push(text, "");
      } else {
        parts.push(`─── ${icon} Job id=${j.id} (${j.name}) — no logs available`);
        parts.push(`   (status: ${j.conclusion || j.status}, error: ${logR.error || "none"})`);
        parts.push("");
      }
    }
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { runId, jobCount: jobs.length },
    };
  },
};

// ─── Rerun ──────────────────────────────────────────────────────────────────────

export const rerunTool = {
  name: "ci_rerun" as const,
  label: "Re-run Workflow",
  description:
    "Re-run a workflow run (all jobs or just failed jobs). Uses Gitea's native rerun endpoint.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run ID (numeric). Use ci_list_runs to find IDs." }),
    confirm: Type.Boolean({ description: "Must be true to confirm" }),
    failed_only: Type.Optional(Type.Boolean({ description: "If true, rerun only failed jobs (default: false, reruns all jobs)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // Safety gate 1: feature flag
    const flag = guard(config.allowRerun, "ci_rerun");
    if (flag) return flag;

    // Safety gate 2: explicit confirmation
    const action = params.failed_only ? "rerun failed jobs" : "rerun entire run";
    const conf = confirm(params.confirm === true, `${action} (run #${params.run_index})`);
    if (conf) return conf;

    // Safety gate 3: rate limit
    const rl = rateLimit(`rerun:${params.run_index}`, 60);
    if (rl) return rl;

    const runId = parseInt(params.run_index, 10);
    if (isNaN(runId)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run ID.` }],
        isError: true,
        details: {},
      };
    }

    // Use Gitea's native rerun endpoint
    const endpoint = params.failed_only
      ? `/actions/runs/${runId}/rerun-failed-jobs`
      : `/actions/runs/${runId}/rerun`;

    const dispatchR = await giteaApi(endpoint, "POST", null, opts(ctx), ctx.cwd);
    if (!dispatchR.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to rerun run #${runId}: ${dispatchR.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    return {
      content: [{ type: "text", text: `🔄 Re-running run #${runId}${params.failed_only ? " (failed jobs only)" : ""}. Check ci_list_runs for the new run.` }],
      details: { runId, failedOnly: !!params.failed_only },
    };
  },
};

// ─── Cancel (NOT SUPPORTED by Gitea) ───────────────────────────────────────────

export const cancelTool = {
  name: "ci_cancel" as const,
  label: "Cancel Workflow Run",
  description:
    "Cancel a running workflow run. ⚠️ Gitea does not expose a cancel endpoint; this will return an error.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run ID to cancel" }),
    confirm: Type.Boolean({ description: "Must be true to confirm cancellation" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    const flag = guard(config.allowCancel, "ci_cancel");
    if (flag) return flag;

    const conf = confirm(params.confirm === true, `cancel workflow run #${params.run_index}`);
    if (conf) return conf;

    const rl = rateLimit(`cancel:${params.run_index}`, 60);
    if (rl) return rl;

    return {
      content: [{
        type: "text",
        text: `❌ Cancel not available: Gitea's Actions API does not expose a cancel endpoint for workflow runs.`,
      }],
      isError: true,
      details: {},
    };
  },
};

// ─── Formatting helpers ─────────────────────────────────────────────────────────

function statusIcon(status: string, conclusion: string | null): string {
  const s = conclusion || status;
  if (s === "in_progress" || s === "running") return "🔄";
  if (s === "pending" || s === "queued" || s === "waiting" || s === "blocked") return "⏳";
  if (s === "cancelled") return "🚫";
  if (s === "success") return "✅";
  if (s === "failure") return "❌";
  if (s === "skipped") return "⏭️";
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

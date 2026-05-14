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

// ─── List Tasks (Gitea "runs") ──────────────────────────────────────────────────
// Gitea models workflows as tasks: each task = a single job within a run.
// Tasks share a run_number. Status doubles as conclusion (no separate field).

export const listRunsTool = {
  name: "ci_list_runs" as const,
  label: "List Workflow Runs",
  description:
    "List workflow runs (Gitea tasks) with optional client-side filters: workflow ID, status, branch, event. Returns task index, status, and timing.",
  parameters: Type.Object({
    workflow: Type.Optional(Type.String({ description: "Workflow ID to filter by (e.g., 'ci.yml')" })),
    status: Type.Optional(
      Type.String({ description: "Filter by status: unknown, waiting, running, success, failure, cancelled, skipped, blocked" }),
    ),
    branch: Type.Optional(Type.String({ description: "Filter by branch name" })),
    event: Type.Optional(Type.String({ description: "Filter by trigger event: push, pull_request, schedule" })),
    limit: Type.Optional(Type.Number({ description: "Max runs to return (default: 20, max: 50)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    const limit = Math.min(params.limit || config.defaultLimit, 50);

    // Gitea tasks endpoint only supports page & limit; filter client-side
    const r = await giteaApi(`/actions/tasks?limit=${limit}&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to list tasks: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    let tasks = (r.data as any)?.workflow_runs ?? [];

    // Client-side filters (Gitea doesn't support server-side filtering for tasks)
    if (params.workflow) tasks = tasks.filter((t: any) => t.workflow_id === params.workflow);
    if (params.status) tasks = tasks.filter((t: any) => t.status === params.status);
    if (params.branch) tasks = tasks.filter((t: any) => t.head_branch === params.branch);
    if (params.event) tasks = tasks.filter((t: any) => t.event === params.event);

    if (tasks.length === 0) {
      return { content: [{ type: "text", text: "No workflow tasks found." }], details: { count: 0 } };
    }

    const lines = [`🏃 Workflow Tasks (${tasks.length})`, ""];
    for (const t of tasks) {
      const icon = statusIcon(t.status);
      const duration = t.updated_at && t.run_started_at
        ? formatDuration(t.run_started_at, t.updated_at)
        : "";
      lines.push(`   ${icon} #${t.id}  run=${t.run_number}  job: ${t.name}`);
      lines.push(`        status: ${t.status}  |  ${duration}`);
      lines.push(`        title: ${t.display_title || "(untitled)"}`);
      lines.push(`        branch: ${t.head_branch}  |  event: ${t.event}  |  workflow: ${t.workflow_id}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { count: tasks.length },
    };
  },
};

// ─── Get Run (tasks grouped by run_number) ─────────────────────────────────────
// Gitea has no individual run endpoint. Fetch all tasks and filter by run_number.

export const getRunTool = {
  name: "ci_get_run" as const,
  label: "Get Run Details",
  description:
    "Get all tasks (jobs) for a workflow run by run_number. Gitea has no single-run endpoint so this fetches and filters.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run number (numeric, e.g. '444')" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runNumber = parseInt(params.run_index, 10);
    if (isNaN(runNumber)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run number.` }],
        isError: true,
        details: {},
      };
    }

    // Fetch a large page to find all tasks for this run_number
    const r = await giteaApi(`/actions/tasks?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch tasks: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const allTasks = (r.data as any)?.workflow_runs ?? [];
    const tasks = allTasks.filter((t: any) => t.run_number === runNumber);

    if (tasks.length === 0) {
      return {
        content: [{ type: "text", text: `❌ Run #${runNumber} not found (no tasks with that run_number in the latest 100).` }],
        isError: true,
        details: {},
      };
    }

    // Run-level metadata from the first task
    const first = tasks[0];
    const title = first.display_title || "(untitled)";
    const branch = first.head_branch;
    const event = first.event;
    const sha = (first.head_sha || "?").slice(0, 8);
    const created = (first.created_at || "?").slice(0, 19).replace("T", " ");
    const url = first.url || "—";
    const workflow = first.workflow_id;

    const lines = [
      `🏃 Run #${runNumber}`,
      `   Title:    ${title}`,
      `   Branch:   ${branch}  |  Event: ${event}`,
      `   Commit:   ${sha}  |  Workflow: ${workflow}`,
      `   Created:  ${created}`,
      `   URL:      ${url}`,
      "",
      `   Jobs (${tasks.length}):`,
    ];
    for (const t of tasks) {
      const icon = statusIcon(t.status);
      lines.push(`   ${icon} id=${t.id}  ${t.name}  →  ${t.status}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runNumber, jobCount: tasks.length, workflow },
    };
  },
};

// ─── List Jobs (Gitea tasks filtered by run_number) ────────────────────────────
// In Gitea, tasks ARE the jobs. Filter by run_number to show jobs for a run.

export const listJobsTool = {
  name: "ci_list_jobs" as const,
  label: "List Run Jobs",
  description:
    "List jobs (tasks) for a specific workflow run by run_number. In Gitea each task is a job.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run number (numeric, e.g. '444')" }),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const runNumber = parseInt(params.run_index, 10);
    if (isNaN(runNumber)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run number.` }],
        isError: true,
        details: {},
      };
    }

    // Fetch tasks and filter by run_number
    const r = await giteaApi(`/actions/tasks?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!r.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch tasks: ${r.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    const allTasks = (r.data as any)?.workflow_runs ?? [];
    const jobs = allTasks.filter((t: any) => t.run_number === runNumber);

    if (jobs.length === 0) {
      return { content: [{ type: "text", text: `No jobs found for run #${runNumber} (not found in latest 100 tasks).` }], details: { count: 0 } };
    }

    const lines = [`📋 Jobs for Run #${runNumber} (${jobs.length})`, ""];
    for (const j of jobs) {
      const icon = statusIcon(j.status);
      const duration = j.updated_at && j.run_started_at
        ? formatDuration(j.run_started_at, j.updated_at)
        : "";
      lines.push(`   ${icon} id=${j.id}  ${j.name}`);
      lines.push(`        status: ${j.status}  |  ${duration}`);
      lines.push(`        workflow: ${j.workflow_id}  |  event: ${j.event}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { runNumber, count: jobs.length },
    };
  },
};

// ─── Get Logs ───────────────────────────────────────────────────────────────────
// Gitea: GET /actions/jobs/{job_id}/logs where job_id = task.id

export const getLogsTool = {
  name: "ci_get_logs" as const,
  label: "Get Job Logs",
  description:
    "Get logs for a job (task) by job_id, or all jobs in a run by run_number. Logs are truncated to the configured max lines, showing the head and tail.",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run number (numeric, used to find all jobs if job_index is omitted)" }),
    job_index: Type.Optional(Type.String({ description: "Job/task ID (numeric, e.g. '1657'). If provided, fetches just that job's logs directly." })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // If a specific job (internal Gitea job) ID is provided, fetch its logs directly
    if (params.job_index) {
      const jobId = params.job_index;
      const r = await giteaApi(`/actions/jobs/${jobId}/logs`, "GET", null, opts(ctx), ctx.cwd);
      if (!r.ok) {
        const hint = r.statusCode === 500
          ? `\n   💡 Note: Gitea job IDs are internal and differ from task IDs. Find job IDs via the Gitea web UI (e.g., http://127.0.0.1:3001/factory/wrok.in/actions).`
          : "";
        return {
          content: [{ type: "text", text: `❌ Failed to get logs for job #${jobId}: ${r.error || "no logs available"}${hint}` }],
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

    // No job_index — need to find jobs for the run_number
    // ⚠️ Gitea limitation: task IDs ≠ job IDs; no API to map between them.
    const runNumber = parseInt(params.run_index, 10);
    if (isNaN(runNumber)) {
      return {
        content: [{ type: "text", text: `❌ Invalid run_index: "${params.run_index}" — must be a numeric run number.` }],
        isError: true,
        details: {},
      };
    }

    // Fetch tasks to show what jobs exist in this run, then try each as a job ID
    const tasksR = await giteaApi(`/actions/tasks?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!tasksR.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch tasks for run #${runNumber}` }],
        isError: true,
        details: {},
      };
    }
    const allTasks = (tasksR.data as any)?.workflow_runs ?? [];
    const tasks = allTasks.filter((t: any) => t.run_number === runNumber);
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: `No jobs found for run #${runNumber}.` }], details: {} };
    }

    // Try fetching logs using each task ID as a job ID
    const parts: string[] = [`📜 Logs for Run #${runNumber} (${tasks.length} tasks)`, ""];
    let anySucceeded = false;
    for (const t of tasks) {
      const logR = await giteaApi(`/actions/jobs/${t.id}/logs`, "GET", null, opts(ctx), ctx.cwd);
      const icon = statusIcon(t.status);
      if (logR.ok && typeof logR.data === "string") {
        anySucceeded = true;
        const { text, truncated, totalLines } = truncateLogs(logR.data, config.maxLogLines);
        parts.push(`─── ${icon} Task id=${t.id} (${t.name}) ───`);
        if (truncated) parts.push(`   (${totalLines} lines total, showing ${config.maxLogLines} — head + tail)`);
        parts.push(text, "");
      } else {
        parts.push(`─── ${icon} Task id=${t.id} (${t.name}) — no logs (task IDs ≠ Gitea job IDs)`);
        parts.push("");
      }
    }
    if (!anySucceeded) {
      parts.push("💡 Gitea uses separate internal job IDs for logs. Find job IDs via the");
      parts.push("   Gitea web UI and use ci_get_logs with job_index=<job_id> directly.");
    }
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { runNumber, taskCount: tasks.length },
    };
  },
};

// ─── Rerun (via workflow dispatch — Gitea has no native rerun) ─────────────────

export const rerunTool = {
  name: "ci_rerun" as const,
  label: "Re-run Workflow",
  description:
    "Re-run a failed or cancelled workflow. Gitea has no native rerun endpoint — this triggers a new workflow dispatch for the same branch (pass confirm=true).",
  parameters: Type.Object({
    run_index: Type.String({ description: "Workflow run number or task ID to reference" }),
    confirm: Type.Boolean({ description: "Must be true to confirm" }),
    branch: Type.Optional(Type.String({ description: "Branch to dispatch the workflow on (defaults to the run's head_branch)" })),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);

    // Safety gate 1: feature flag
    const flag = guard(config.allowRerun, "ci_rerun");
    if (flag) return flag;

    // Safety gate 2: explicit confirmation
    const conf = confirm(params.confirm === true, `dispatch a workflow re-run (run #${params.run_index})`);
    if (conf) return conf;

    // Safety gate 3: rate limit
    const rl = rateLimit(`rerun:${params.run_index}`, 60);
    if (rl) return rl;

    // Fetch the run's tasks to find the workflow_id and branch
    const tasksR = await giteaApi(`/actions/tasks?limit=100&page=1`, "GET", null, opts(ctx), ctx.cwd);
    if (!tasksR.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to fetch tasks to find run #${params.run_index}.` }],
        isError: true,
        details: {},
      };
    }
    const runNumber = parseInt(params.run_index, 10);
    const allTasks = (tasksR.data as any)?.workflow_runs ?? [];
    const runTasks = isNaN(runNumber)
      ? allTasks.filter((t: any) => String(t.id) === params.run_index)
      : allTasks.filter((t: any) => t.run_number === runNumber);

    if (runTasks.length === 0) {
      return {
        content: [{ type: "text", text: `❌ Run #${params.run_index} not found in recent tasks.` }],
        isError: true,
        details: {},
      };
    }

    const workflowId = runTasks[0].workflow_id;
    const branch = params.branch || runTasks[0].head_branch || "main";

    // Use Gitea workflow dispatch endpoint
    const dispatchR = await giteaApi(
      `/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      "POST",
      { ref: `refs/heads/${branch}` },
      opts(ctx),
      ctx.cwd,
    );
    if (!dispatchR.ok) {
      return {
        content: [{ type: "text", text: `❌ Failed to dispatch workflow "${workflowId}" on ${branch}: ${dispatchR.error || "unknown"}` }],
        isError: true,
        details: {},
      };
    }
    return {
      content: [{ type: "text", text: `🔄 Dispatched workflow "${workflowId}" on branch "${branch}". Check ci_list_runs for the new tasks.` }],
      details: { workflowId, branch },
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
    run_index: Type.String({ description: "Workflow run number to cancel" }),
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

// Gitea combines status + conclusion into one field (no separate conclusion)
function statusIcon(status: string): string {
  if (status === "running") return "🔄";
  if (status === "waiting" || status === "blocked") return "⏳";
  if (status === "cancelled") return "🚫";
  if (status === "success") return "✅";
  if (status === "failure") return "❌";
  if (status === "skipped") return "⏭️";
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

# CI Gate — Agent Usage Guide

> You are an AI agent. Use ci-gate tools to observe CI workflows, diagnose failures, and re-trigger runs.

## Golden Rules

> **⚠️ Always check CI after submitting a PR.** Use `ci_list_runs()` to find the run for your branch before asking for reviews.

> **⚠️ Read logs before re-running.** Blindly re-running a failing workflow wastes compute. Use `ci_get_logs()` to diagnose first.

> **⚠️ Never skip confirm=true.** The `ci_rerun` and `ci_cancel` tools require explicit confirmation — this is intentional.

## Workflow

```
ci_list_runs(status="failure", branch="feat/my-branch")
  │
  ▼
ci_get_run(run_index="42")           ← see all jobs, find the failing one
  │
  ▼
ci_get_logs(run_index="42")          ← read failure logs for all jobs
  │   (or: run_index="42", job_index="512" for one job)
  ▼
[understand the error, fix the code]
  │
  ▼
contrib_propose(message="fix: resolve CI failure in build step")
  │
  ▼
contrib_submit(...)                  ← push the fix (triggers new CI run)
  │
  ▼
ci_list_runs(status="failure", branch="feat/my-branch")
                                       ← verify the fix passes
```

## Common Patterns

### Find a failing CI run for your PR

```
ci_list_runs(status="failure", branch="feat/my-feature", limit=5)
```

### Inspect a specific run

```
ci_get_run(run_index="42")
```

### See which job failed

```
ci_list_jobs(run_index="42")
```

### Read the failure logs (specific job)

```
ci_get_logs(run_index="42", job_index="512")
```
> 💡 Job IDs are numeric and come from `ci_list_jobs` or `ci_get_run` output — not an arbitrary index.

### Read all logs for a run (all jobs)

```
ci_get_logs(run_index="42")
```

### Re-run after fixing

```
ci_rerun(run_index="42", confirm=true)
```

### Cancel a stuck run

```
ci_cancel(run_index="42", confirm=true)
```

### List available workflows

```
ci_list_workflows()
```

### Filter runs by workflow and event

```
ci_list_runs(workflow="ci.yml", event="push", branch="main", limit=10)
```
> 💡 The `workflow` filter matches against the workflow file path (e.g., `.gitea/workflows/ci.yml`). A substring like `ci.yml` is enough.

## Log Truncation

Logs are truncated to `maxLogLines` (default: 200) per job. You'll see the first ~40% (setup) and last ~60% (failures/results). A marker shows how many lines were omitted. This keeps context manageable while surfacing the key information.

## Status Icons

| Icon | Meaning |
|---|---|
| 🔄 | Running |
| ⏳ | Waiting / Blocked |
| ✅ | Success |
| ❌ | Failure |
| 🚫 | Cancelled |
| ⏭️ | Skipped |
| ⚪ | Unknown / Other |

## When Things Go Wrong

| Problem | Solution |
|---|---|
| `ci_rerun` blocked without confirm | Pass `confirm=true` — this is a safety gate |
| `ci_rerun` blocked by feature flag | `.circ.yml` has `allowRerun: false` — ask a human |
| Logs are truncated | Increase `maxLogLines` in `.circ.yml`, or fetch a specific job with `job_index` |
| No workflows found | The repo may not have Gitea Actions configured |
| 404 on run ID | The run may have been deleted or the ID is wrong — use `ci_list_runs()` to find it |
| Rate limited | Wait for the cooldown (60s) before retrying a destructive action |
| `ci_get_logs` returns "no logs available" for a job | The job may not have produced logs (e.g., skipped or still queued). Check its status first with `ci_list_jobs` |
| Need to rerun only failed jobs | Use `ci_rerun(run_index="42", confirm=true, failed_only=true)` |

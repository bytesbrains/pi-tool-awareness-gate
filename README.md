# CI Gate for Pi

[![npm version](https://img.shields.io/npm/v/pi-ci-gate)](https://www.npmjs.com/package/pi-ci-gate)
[![license](https://img.shields.io/npm/l/pi-ci-gate)](./LICENSE)

> CI observability gate for AI agents — view workflow runs, job statuses, and logs from Gitea Actions with safety controls. **Agents self-diagnose CI failures instead of asking humans.**

## Philosophy

`pi-contrib-gate` handles the *contribution* side (branch → commit → PR).  
`pi-review-gate` handles the *review* side (check → approve → merge).  
`pi-project-gate` handles the *project* side (issue → plan → release).  
`pi-ci-gate` handles the *CI* side (observe → diagnose → re-trigger).

## Install

```bash
pi install npm:pi-ci-gate
```

## Tools

| Tool | Safety | What it does |
|---|---|---|
| `ci_list_workflows()` | ✅ Read-only | List registered workflows in the repo |
| `ci_list_runs(workflow?, status?, branch?, limit?)` | ✅ Read-only | List workflow runs with filters |
| `ci_get_run(run_index)` | ✅ Read-only | Get full run details (status, timing, trigger) |
| `ci_list_jobs(run_index)` | ✅ Read-only | List jobs for a run with statuses |
| `ci_get_logs(run_index, job_index?)` | ✅ Read-only | Get job logs (truncated to safe limits) |
| `ci_rerun(run_index, confirm)` | ⚠️ Destructive | Re-run a failed/cancelled workflow |
| `ci_cancel(run_index, confirm)` | ⚠️ Destructive | Cancel a running workflow |

## Safety Harness

The destructive tools (`ci_rerun`, `ci_cancel`) have a triple safety gate:

```
🛡️ Gate 1: Feature flag
   └─ .circ.yml: allowRerun: false / allowCancel: false → tool blocked entirely

🛡️ Gate 2: Explicit confirmation
   └─ Must pass confirm=true — prevents accidental triggers

🛡️ Gate 3: Rate limiting
   └─ 60s cooldown between destructive actions on the same run
```

Log output is also truncated: shows the head (setup) and tail (failures), keeping agents from drowning in logs while still surfacing what matters.

## Configuration

Create `.circ.yml`:

```yaml
# Max log lines returned per job (head + tail split)
maxLogLines: 200

# Enable/disable destructive tools
allowRerun: true
allowCancel: true

# Default limit for listing runs
defaultLimit: 20
```

## Workflow

```
ci_list_runs(status="failure")   ← find failed runs
  │
  ▼
ci_get_run(42)                  ← inspect a specific run
  │
  ▼
ci_list_jobs(42)               ← see which jobs failed
  │
  ▼
ci_get_logs(42, job_index=1)   ← read the failure logs
  │
  ▼
[fix the code]
  │
  ▼
ci_rerun(42, confirm=true)     ← re-trigger the workflow
  │
  ▼
ci_get_run(42)                 ← verify it passed ✅
```

## Integration

Install all four gates for full agent governance:

```bash
pi install npm:pi-contrib-gate
pi install npm:pi-review-gate
pi install npm:pi-project-gate
pi install npm:pi-ci-gate
```

## License

MIT © [nandal](https://github.com/nandal)

/**
 * pi-ci-gate — CI Observability Gate
 *
 * Tools: ci_list_workflows, ci_list_runs, ci_get_run, ci_list_jobs,
 *        ci_get_logs, ci_rerun, ci_cancel
 * Config: .circ.yml
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  listWorkflowsTool,
  listRunsTool,
  getRunTool,
  listJobsTool,
  getLogsTool,
  rerunTool,
  cancelTool,
} from "./tools/ci";

export default function (pi: ExtensionAPI) {
  pi.registerTool(listWorkflowsTool);
  pi.registerTool(listRunsTool);
  pi.registerTool(getRunTool);
  pi.registerTool(listJobsTool);
  pi.registerTool(getLogsTool);
  pi.registerTool(rerunTool);
  pi.registerTool(cancelTool);
}

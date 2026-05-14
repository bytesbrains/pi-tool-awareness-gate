import * as cp from "node:child_process";

export function exec(
  cmd: string,
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = cp.execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 });
    return { ok: true, stdout: r.trim(), stderr: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e.stdout?.trim() || "",
      stderr: e.stderr?.trim() || e.message,
    };
  }
}

export function resolveGitea(cwd: string): { repo: string; token: string } {
  const remote = exec(
    "git remote get-url gitea 2>/dev/null || git remote get-url origin",
    cwd,
  );
  const url = remote.stdout || "";
  const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const repo = match ? `${match[1]}/${match[2]}` : "factory/wrok.in";
  const credMatch = url.match(/:\/\/([^:]+):([^@]+)@/);
  return { repo, token: credMatch ? credMatch[2] : (process.env.GITEA_TOKEN || "") };
}

export function giteaApi(
  path: string,
  method: string,
  body: Record<string, unknown> | null,
  opts: { repo: string; token?: string },
  cwd: string,
): { ok: boolean; data: unknown; error?: string; statusCode?: number } {
  const base = `http://127.0.0.1:3001/api/v1/repos/${opts.repo}`;
  const headers = [
    opts.token ? `-H "Authorization: token ${opts.token}"` : "",
    `-H "Content-Type: application/json"`,
  ]
    .filter(Boolean)
    .join(" ");
  const dataFlag = body
    ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`
    : "";
  const cmd = `curl -sf -w "\\n%{http_code}" -X ${method} "${base}${path}" ${headers} ${dataFlag}`;
  const r = exec(cmd, cwd);
  if (!r.ok) {
    const lines = r.stdout.split("\n");
    const code = lines[lines.length - 1]?.trim();
    return {
      ok: false,
      data: null,
      statusCode: parseInt(code) || undefined,
      error:
        r.stderr || lines.slice(0, -1).join("\n") || "API error",
    };
  }
  const lines = r.stdout.split("\n");
  const statusCode = parseInt(lines[lines.length - 1]?.trim());
  const bodyText = lines.slice(0, -1).join("\n");
  try {
    return { ok: true, data: JSON.parse(bodyText), statusCode };
  } catch {
    return { ok: true, data: bodyText, statusCode };
  }
}

/** Truncate logs to maxLines, keeping head + tail so agents see setup and failures. */
export function truncateLogs(
  raw: string,
  maxLines: number,
): { text: string; truncated: boolean; totalLines: number } {
  const allLines = raw.split("\n");
  const totalLines = allLines.length;
  if (totalLines <= maxLines) {
    return { text: raw, truncated: false, totalLines };
  }
  const head = Math.floor(maxLines * 0.4);
  const tail = maxLines - head;
  const headText = allLines.slice(0, head).join("\n");
  const tailText = allLines.slice(-tail).join("\n");
  return {
    text: `${headText}\n\n... [${totalLines - maxLines} lines truncated] ...\n\n${tailText}`,
    truncated: true,
    totalLines,
  };
}

/** In-memory rate limiter for destructive actions. */
const rateLimitMap = new Map<string, number>();
export function checkRateLimit(
  key: string,
  cooldownSeconds: number,
): { allowed: boolean; retryAfter: number } {
  const last = rateLimitMap.get(key) || 0;
  const now = Date.now();
  const elapsed = (now - last) / 1000;
  if (elapsed < cooldownSeconds) {
    return { allowed: false, retryAfter: Math.ceil(cooldownSeconds - elapsed) };
  }
  rateLimitMap.set(key, now);
  return { allowed: true, retryAfter: 0 };
}

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

export async function giteaApi(
  path: string,
  method: string,
  body: Record<string, unknown> | null,
  opts: { repo: string; token?: string },
  _cwd: string,
): Promise<{ ok: boolean; data: unknown; error?: string; statusCode?: number }> {
  const base = `http://127.0.0.1:3001/api/v1/repos/${opts.repo}`;
  const url = `${base}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `token ${opts.token}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const statusCode = res.status;
    if (!res.ok) {
      return { ok: false, data: null, statusCode, error: text || `HTTP ${statusCode}` };
    }
    try {
      return { ok: true, data: JSON.parse(text), statusCode };
    } catch {
      return { ok: true, data: text, statusCode };
    }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message || "Network error" };
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

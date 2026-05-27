import spawn from "cross-spawn";
import fs from "node:fs";
import type { Usage } from "./persist.js";
import type { AgentSession } from "./claude.js";

/**
 * A Gemini CLI session (provider="gemini"). Configuration-based — md-agent never
 * auto-detects it; a role opts in via RoleSpec.provider.
 *
 * v1 is STATELESS: unlike ClaudeSession there is no cross-turn session resume —
 * every send() is an independent `gemini -p` call with the system prompt prepended.
 * That's a perfect drop-in for the (already stateless) orchestrator and for
 * self-contained / mechanical role work, but a Gemini-backed role does NOT retain
 * conversational memory between dispatches. Pick it for cheap-bulk seats, not for
 * roles that accumulate deep context across turns.
 *
 * Headless invocation: `gemini -p <prompt> -m <model> -o json -y --skip-trust`.
 *   -o json  → one object: { session_id, response, stats?, error? }
 *   -y       → auto-approve tool calls (headless; matches `claude -p` behavior)
 *   --skip-trust → run in the (user-owned, configured) workspace without the trust gate
 *
 * Cost note: Gemini token usage is read best-effort from `stats`; per-turn USD cost
 * is not computed (left 0), so the dashboard tally under-counts Gemini turns. Turn
 * counts are still recorded. Gemini tiers are cheap, so this is acceptable for v1.
 */
export class GeminiSession implements AgentSession {
  private systemPrompt: string | null;
  private model: string | null;
  private heartbeatPath: string | null;
  private lastBeat = 0;
  private sessionId: string | null = null;
  private lastUsageData: Usage | null = null;

  constructor(
    opts: { systemPrompt?: string; model?: string; heartbeatPath?: string } = {}
  ) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.model = opts.model ?? null;
    this.heartbeatPath = opts.heartbeatPath ?? null;
  }

  get id(): string | null {
    return this.sessionId;
  }

  get lastUsage(): Usage | null {
    return this.lastUsageData;
  }

  setHeartbeatPath(p: string): void {
    this.heartbeatPath = p;
  }

  /** Touch the heartbeat file (throttled) so the watchdog sees the turn is alive. */
  private beat(): void {
    if (!this.heartbeatPath) return;
    const now = Date.now();
    if (now - this.lastBeat < 1500) return;
    this.lastBeat = now;
    try {
      fs.writeFileSync(this.heartbeatPath, String(now));
    } catch {
      // best-effort liveness signal; never break a turn over it
    }
  }

  async send(prompt: string): Promise<string> {
    this.beat();
    // Stateless: prepend the system prompt every turn (there is no resumed context).
    const fullPrompt = this.systemPrompt ? `${this.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    // Deliver the prompt on STDIN, not as a -p arg. A multiline arg gets mangled by
    // the Windows gemini.ps1/.cmd shim (newlines split the command, dropping the rest
    // of the prompt AND trailing flags like -o json). gemini appends the -p value to
    // stdin input, so `-p ""` + stdin = the full prompt; flags stay newline-free args.
    const args = ["-p", "", "-o", "json", "-y", "--skip-trust"];
    if (this.model) args.push("-m", this.model);
    const timeoutMs = 5 * 60_000;

    return new Promise<string>((resolve, reject) => {
      const child = spawn("gemini", args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      // `gemini -o json` emits its result at the END (not streamed), so beat on a
      // timer while the call runs to keep the liveness watchdog satisfied.
      const beatTimer = setInterval(() => this.beat(), 3000);
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        clearInterval(beatTimer);
        reject(new Error(`gemini timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      child.stdout!.on("data", (b: Buffer) => {
        this.beat();
        out += b.toString("utf8");
      });
      child.stderr!.on("data", (b: Buffer) => {
        err += b.toString("utf8");
      });
      child.on("error", (e) => {
        clearInterval(beatTimer);
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearInterval(beatTimer);
        clearTimeout(timer);
        const obj = this.parseJson(out);
        if (obj && typeof obj.session_id === "string") this.sessionId = obj.session_id;
        if (obj && obj.error) {
          const msg =
            typeof obj.error === "string"
              ? obj.error
              : (obj.error.message ?? JSON.stringify(obj.error));
          reject(new Error(`gemini error: ${msg}`));
          return;
        }
        if (code !== 0 && !obj) {
          const tail = (s: string) => {
            const t = s.trim();
            return t.length > 1500 ? "…" + t.slice(-1500) : t || "(empty)";
          };
          reject(
            new Error(
              `gemini exited ${code}\n` +
                `  model: ${this.model ?? "(default)"}\n` +
                `  stderr: ${tail(err)}\n` +
                `  stdout: ${tail(out)}`
            )
          );
          return;
        }
        this.lastUsageData = this.extractUsage(obj);
        resolve(this.extractText(obj, out).trim());
      });
      child.stdin!.write(fullPrompt);
      child.stdin!.end();
    });
  }

  /** Parse the single JSON object `-o json` prints (tolerate leading noise). */
  private parseJson(out: string): Record<string, any> | null {
    const s = out.trim();
    const start = s.indexOf("{");
    if (start < 0) return null;
    try {
      return JSON.parse(s.slice(start));
    } catch {
      return null;
    }
  }

  /** Defensive text extraction across the likely field names; raw stdout as last resort. */
  private extractText(obj: Record<string, any> | null, raw: string): string {
    if (obj) {
      if (typeof obj.response === "string") return obj.response;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.output === "string") return obj.output;
    }
    return raw.trim();
  }

  /**
   * Best-effort token usage from `stats.models.<model>.tokens`
   * ({ input, prompt, candidates, total, cached, … }); cost is not computed for
   * Gemini in v1. `candidates` is sometimes 0 even on a reply, so fall back to
   * total - input for output.
   */
  private extractUsage(obj: Record<string, any> | null): Usage {
    const zero: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
    };
    const models = obj?.stats?.models;
    if (!models) return zero;
    let input = 0;
    let output = 0;
    let cached = 0;
    for (const k of Object.keys(models)) {
      const t = (models as Record<string, any>)[k]?.tokens ?? {};
      const inp = Number(t.input ?? t.prompt ?? 0) || 0;
      const cand = Number(t.candidates ?? t.output ?? 0) || 0;
      const total = Number(t.total ?? 0) || 0;
      input += inp;
      output += cand > 0 ? cand : Math.max(0, total - inp);
      cached += Number(t.cached ?? 0) || 0;
    }
    return { ...zero, inputTokens: input, outputTokens: output, cacheReadTokens: cached };
  }
}

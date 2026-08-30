import spawn from "cross-spawn";
import fs from "node:fs";
import type { Usage } from "./persist.js";
import type { AgentSession } from "./claude.js";

/**
 * A persistent Antigravity (`agy`) conversation.
 *
 * Unlike the Gemini CLI adapter this replaces, agy is STATEFUL: `-p --output-format
 * json` returns a `conversation_id`, and passing it back via `--conversation <id>`
 * resumes that thread. So an agy seat behaves like a claude seat — the system prompt
 * is sent once on the first turn, not re-sent every turn, and a resumed role keeps
 * its context.
 *
 * The response envelope is flat:
 *   { conversation_id, status, response, duration_seconds, num_turns,
 *     usage: { input_tokens, output_tokens, thinking_tokens,
 *              cache_read_tokens, total_tokens } }
 */
export class AgySession implements AgentSession {
  private systemPrompt: string | null;
  private model: string | null;
  private permissionMode: string | null;
  private cwd: string | null;
  private heartbeatPath: string | null;
  private lastBeat = 0;
  private conversationId: string | null = null;
  private lastUsageData: Usage | null = null;
  private onSessionId: ((id: string) => void) | null;

  constructor(opts: {
    systemPrompt?: string;
    model?: string;
    heartbeatPath?: string;
    permissionMode?: string;
    /** Working directory for the spawned CLI. Defaults to md-agent's own cwd. */
    cwd?: string;
    /** Resume an existing conversation instead of starting a new one. */
    resumeId?: string;
    onSessionId?: (id: string) => void;
  }) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.model = opts.model ?? null;
    this.permissionMode = opts.permissionMode ?? null;
    this.cwd = opts.cwd ?? null;
    this.heartbeatPath = opts.heartbeatPath ?? null;
    this.conversationId = opts.resumeId ?? null;
    this.onSessionId = opts.onSessionId ?? null;
  }

  get id(): string | null {
    return this.conversationId;
  }

  get lastUsage(): Usage | null {
    return this.lastUsageData;
  }

  setHeartbeatPath(p: string): void {
    this.heartbeatPath = p;
  }

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

  /**
   * agy has no --system-prompt flag, so the mandate rides on the first turn only.
   * On resume the conversation already carries it — re-sending would duplicate it.
   */
  private composePrompt(prompt: string): string {
    if (this.conversationId || !this.systemPrompt) return prompt;
    return `${this.systemPrompt}\n\n---\n\n${prompt}`;
  }

  /** RoleSpec.permissionMode is written in claude's vocabulary; translate it. */
  private permissionArgs(): string[] {
    switch (this.permissionMode) {
      case "acceptEdits":
      case "accept-edits":
        return ["--mode", "accept-edits"];
      case "plan":
        return ["--mode", "plan"];
      case "bypassPermissions":
      case "dangerouslySkipPermissions":
        return ["--dangerously-skip-permissions"];
      default:
        return [];
    }
  }

  async send(prompt: string): Promise<string> {
    this.beat();
    const timeoutMs = 10 * 60_000;
    const args = ["-p", this.composePrompt(prompt), "--output-format", "json"];
    if (this.conversationId) args.push("--conversation", this.conversationId);
    if (this.model) args.push("--model", this.model);
    args.push(...this.permissionArgs());
    // Keep agy's own print timeout above ours so OUR timer is the one that fires
    // and produces a diagnosable error rather than an opaque CLI kill.
    args.push("--print-timeout", `${Math.floor(timeoutMs / 1000) + 60}s`);

    return new Promise<string>((resolve, reject) => {
      const child = spawn("agy", args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });
      let out = "";
      let err = "";
      // The JSON envelope is emitted at the END, so beat on a timer to keep the
      // liveness watchdog satisfied during a long turn.
      const beatTimer = setInterval(() => this.beat(), 3000);
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        clearInterval(beatTimer);
        reject(new Error(`agy timed out after ${timeoutMs / 1000}s`));
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

        if (obj && typeof obj.conversation_id === "string" && !this.conversationId) {
          this.conversationId = obj.conversation_id;
          this.onSessionId?.(obj.conversation_id);
        }

        const tail = (s: string) => {
          const t = s.trim();
          return t.length > 1500 ? "…" + t.slice(-1500) : t || "(empty)";
        };

        // status is the authoritative outcome: a non-SUCCESS envelope can still
        // arrive on exit 0, so check it before trusting `response`.
        const status = typeof obj?.status === "string" ? obj.status : null;
        if (status && status !== "SUCCESS") {
          reject(
            new Error(
              `agy status ${status}\n` +
                `  model: ${this.model ?? "(default)"}\n` +
                `  response: ${tail(String(obj?.response ?? ""))}\n` +
                `  stderr: ${tail(err)}`
            )
          );
          return;
        }
        if (code !== 0 && !obj) {
          reject(
            new Error(
              `agy exited ${code}\n` +
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
    });
  }

  /** Parse the single JSON object `--output-format json` prints (tolerate leading noise). */
  private parseJson(out: string): Record<string, any> | null {
    const s = out.trim();
    if (!s) return null;
    try {
      return JSON.parse(s) as Record<string, any>;
    } catch {
      const i = s.indexOf("{");
      const j = s.lastIndexOf("}");
      if (i >= 0 && j > i) {
        try {
          return JSON.parse(s.slice(i, j + 1)) as Record<string, any>;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private extractText(obj: Record<string, any> | null, raw: string): string {
    if (obj && typeof obj.response === "string") return obj.response;
    return raw.trim();
  }

  /**
   * agy reports flat token counts. thinking_tokens is folded into output because
   * that is how reasoning tokens bill; cost is not computed here (no price table).
   */
  private extractUsage(obj: Record<string, any> | null): Usage {
    const u = obj?.usage ?? {};
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens) + n(u.thinking_tokens),
      cacheReadTokens: n(u.cache_read_tokens),
      cacheCreationTokens: 0,
      costUsd: 0,
    };
  }
}

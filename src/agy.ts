import spawn from "cross-spawn";
import fs from "node:fs";
import type { Usage, WindowSnapshot } from "./persist.js";
import { looksExhausted, promptExcerpt, ProviderExhaustedError, TurnLog, type AgentSession } from "./claude.js";

/** "Resets in 164h48m" → unix seconds, when agy says when. */
function parseResetsIn(text: string): number | undefined {
  const m = /resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const secs = (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
  return Math.floor(Date.now() / 1000) + secs;
}

/**
 * A persistent Antigravity (`agy`) conversation.
 *
 * Unlike the Gemini CLI adapter this replaces, agy is STATEFUL: a turn returns a
 * `conversation_id`, and passing it back via `--conversation <id>` resumes that
 * thread. So an agy seat behaves like a claude seat — the system prompt is sent
 * once on the first turn, not re-sent every turn, and a resumed role keeps its
 * context.
 *
 * Runs with `--output-format stream-json`: one NDJSON event per line —
 *   {"event":"init", "conversation_id", "init":{model, cwd, tools}}
 *   {"event":"step_update", "step_update":{state, step_type, text_delta?, usage?}}
 *   {"event":"result", "result":{conversation_id, status, response,
 *        duration_seconds, num_turns, usage:{input_tokens, output_tokens,
 *        thinking_tokens, cache_read_tokens, total_tokens}}}
 * The `result` envelope is what the old `--output-format json` returned whole;
 * streaming adds a real per-chunk heartbeat and lets the turn be teed to the
 * seat's log as it happens.
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
  private log: TurnLog | null;

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
    /** Append every streamed line of every turn here (see TurnLog). */
    logPath?: string;
  }) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.model = opts.model ?? null;
    this.permissionMode = opts.permissionMode ?? null;
    this.cwd = opts.cwd ?? null;
    this.heartbeatPath = opts.heartbeatPath ?? null;
    this.conversationId = opts.resumeId ?? null;
    this.onSessionId = opts.onSessionId ?? null;
    this.log = opts.logPath ? new TurnLog(opts.logPath) : null;
  }

  get id(): string | null {
    return this.conversationId;
  }

  get lastUsage(): Usage | null {
    return this.lastUsageData;
  }

  /** Antigravity reports token counts only — no window utilization. */
  get lastWindows(): WindowSnapshot | null {
    return null;
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

  /**
   * RoleSpec.permissionMode is written in claude's vocabulary; translate it.
   *
   * NOTE the vocabularies are not equivalent. "acceptEdits" maps to
   * `--mode accept-edits`, which grants file edits but NOT command execution —
   * in headless mode agy cannot prompt, so a seat that shells out has those
   * calls auto-denied and returns an empty response. A seat that must run
   * commands needs "bypassPermissions".
   */
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
    const fullPrompt = this.composePrompt(prompt);
    const args = ["-p", fullPrompt, "--output-format", "stream-json"];
    if (this.conversationId) args.push("--conversation", this.conversationId);
    if (this.model) args.push("--model", this.model);
    // agy resolves paths against its project, not the process cwd — started
    // bare it works in ~/.gemini/antigravity-cli/scratch, and a worktree seat
    // would write into whatever project it last knew. --add-dir binds this
    // turn to the seat's directory; repeating it per turn is idempotent.
    args.push("--add-dir", this.cwd ?? process.cwd());
    args.push(...this.permissionArgs());
    // Keep agy's own print timeout above ours so OUR timer is the one that fires
    // and produces a diagnosable error rather than an opaque CLI kill.
    args.push("--print-timeout", `${Math.floor(timeoutMs / 1000) + 60}s`);

    this.log?.mark("turn", {
      provider: "agy",
      model: this.model,
      resume: this.conversationId,
      ...promptExcerpt(prompt),
      systemChars: fullPrompt.length - prompt.length,
    });
    const startedAt = Date.now();

    return new Promise<string>((resolve, reject) => {
      const child = spawn("agy", args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });
      let out = "";
      let err = "";
      let lineBuf = "";
      // Streamed lines beat on arrival; the timer covers a long silent tool call
      // (agy emits nothing between step updates), so the watchdog stays fed.
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
        const text = b.toString("utf8");
        out += text;
        lineBuf += text;
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line) this.log?.raw(line);
        }
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
        if (lineBuf.trim()) this.log?.raw(lineBuf.trim());
        const obj = this.parseResult(out);
        this.log?.mark("end", {
          code,
          ms: Date.now() - startedAt,
          status: obj?.status ?? null,
          usage: obj ? this.extractUsage(obj) : null,
          ...(code === 0 ? {} : { stderr: err.slice(-1500) }),
        });

        if (obj && typeof obj.conversation_id === "string" && !this.conversationId) {
          this.conversationId = obj.conversation_id;
          this.onSessionId?.(obj.conversation_id);
        }

        const tail = (s: string) => {
          const t = s.trim();
          return t.length > 1500 ? "…" + t.slice(-1500) : t || "(empty)";
        };

        // Out of quota is not a failed turn to retry — it is a seat that cannot
        // work until the window resets. Surface it as its own error so the seat
        // stops itself instead of looping on empty replies.
        const everything = `${String(obj?.response ?? "")}\n${err}\n${out.slice(-2000)}`;
        if (looksExhausted(everything)) {
          const line = everything.split("\n").find((l) => looksExhausted(l))?.trim() ?? "quota reached";
          reject(new ProviderExhaustedError("agy", `agy: ${line.slice(0, 300)}`, parseResetsIn(everything)));
          return;
        }

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
        // agy reports status SUCCESS even when every tool call was auto-denied
        // and it produced nothing; the reason goes to stderr, outside the
        // envelope. An empty response is therefore a FAILED turn — treating it
        // as success writes an empty outbox and the orchestrator silently
        // proceeds as though the seat had answered.
        if (status === "SUCCESS" && !String(obj?.response ?? "").trim()) {
          reject(
            new Error(
              `agy returned an empty response\n` +
                `  model: ${this.model ?? "(default)"}\n` +
                `  This usually means a tool was auto-denied in headless mode. A seat that\n` +
                `  must run commands needs permissionMode "bypassPermissions"; --mode\n` +
                `  accept-edits grants edits only.\n` +
                `  stderr: ${tail(err)}`
            )
          );
          return;
        }
        // No result envelope at all (killed mid-stream, or a startup failure that
        // never reached `result`): there is nothing to read as a reply.
        if (!status) {
          reject(
            new Error(
              `agy exited ${code} without a result envelope\n` +
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

  /**
   * Pull the final envelope out of the NDJSON stream: the `result` event's
   * payload, or — for a stream cut off before it — the conversation id from
   * `init` so a partial turn can still be resumed. Tolerates a stray non-JSON
   * line (agy prints its own notices to stdout).
   */
  private parseResult(out: string): Record<string, any> | null {
    let init: Record<string, any> | null = null;
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(t) as Record<string, any>;
      } catch {
        continue;
      }
      if (ev.event === "result" && ev.result && typeof ev.result === "object") return ev.result;
      if (ev.event === "init" && typeof ev.conversation_id === "string") {
        init = { conversation_id: ev.conversation_id };
      }
      // A bare envelope (older agy, or --output-format json) is accepted as-is.
      if (typeof ev.status === "string" && "response" in ev) return ev;
    }
    return init;
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

import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import type { Usage, WindowSnapshot } from "./persist.js";

/**
 * Append-only NDJSON tee of one seat's turns. Every line the agent CLI streams
 * is written verbatim between `md-agent` turn markers, so a seat's tool calls
 * and reasoning survive the turn (the outbox carries only its final report).
 */
export class TurnLog {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly file: string) {}

  private open(): fs.WriteStream {
    if (!this.stream) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.stream = fs.createWriteStream(this.file, { flags: "a" });
    }
    return this.stream;
  }

  /** Write a marker line authored by md-agent (not the CLI). */
  mark(event: string, data: Record<string, unknown> = {}): void {
    try {
      this.open().write(JSON.stringify({ md: event, ts: new Date().toISOString(), ...data }) + "\n");
    } catch {
      // the log is for humans; never fail a turn over it
    }
  }

  /** Write one raw line exactly as the CLI streamed it. */
  raw(line: string): void {
    try {
      this.open().write(line + "\n");
    } catch {
      // see mark()
    }
  }
}

/**
 * The provider will not serve this seat again for a while: a plan window or
 * quota is exhausted. The seat stops itself on this rather than looping.
 */
export class ProviderExhaustedError extends Error {
  constructor(
    readonly provider: "claude" | "agy",
    message: string,
    /** Unix seconds when the limit resets, when the provider says. */
    readonly resetsAt?: number
  ) {
    super(message);
    this.name = "ProviderExhaustedError";
  }
}

/** Provider text that means "out of quota", as the CLIs phrase it. */
export function looksExhausted(text: string): boolean {
  return /quota (reached|exceeded|exhausted)|usage limit reached|rate limit(ed| exceeded)|out of (credits|quota)|upgrade your subscription|resets in \d/i.test(text);
}

const PROMPT_LOG_CHARS = 4000;

/** What a turn marker records of the prompt: enough to read, not the whole brief. */
export function promptExcerpt(prompt: string): { prompt: string; promptChars: number } {
  return {
    prompt: prompt.length > PROMPT_LOG_CHARS ? prompt.slice(0, PROMPT_LOG_CHARS) + "…" : prompt,
    promptChars: prompt.length,
  };
}

/**
 * The provider-agnostic seat interface the orchestrator and roles drive. Both
 * ClaudeSession and AgySession implement it, so the run loop never cares which
 * agent CLI is behind a seat (configuration-based; see RoleSpec.provider).
 */
export interface AgentSession {
  /** Send one turn; resolve with the assistant's text reply. */
  send(prompt: string): Promise<string>;
  /** Token usage + cost of the most recent send(), or null before any turn. */
  readonly lastUsage: Usage | null;
  /** Persisted session id when the provider supports resume; else null. */
  readonly id: string | null;
  /** Point the liveness heartbeat at a file (set once the run dir exists). */
  setHeartbeatPath(p: string): void;
  /** Plan-window utilization the last turn reported, when the provider exposes it. */
  readonly lastWindows: WindowSnapshot | null;
}

/**
 * A persistent (session-resumed) claude conversation.
 * First call starts a new session and prepends the system prompt to the
 * user's first message; subsequent calls use --resume <session-id> so the
 * session keeps that context.
 */
export class ClaudeSession implements AgentSession {
  private sessionId: string | null = null;
  private systemPrompt: string | null;
  private onSessionId: ((id: string) => void) | null;
  private model: string | null;
  private cwd: string | null;
  private lastUsageData: Usage | null = null;
  private readonly stateless: boolean;
  private heartbeatPath: string | null;
  private permissionMode: string | null;
  private lastBeat = 0;
  private log: TurnLog | null;
  private disallowedTools: string[];
  private lastWindowsData: WindowSnapshot | null = null;

  constructor(
    opts: {
      systemPrompt?: string;
      /** Reattach to an existing claude session instead of starting a new one. */
      resumeSessionId?: string;
      /** Called once, when a fresh session id is first captured. */
      onSessionId?: (id: string) => void;
      /** Concrete claude model id to run this session on (passed as --model). */
      model?: string;
      /**
       * Working directory for the spawned CLI. Defaults to md-agent's own cwd
       * (the target repo). Set per role to isolate a seat's edits — see
       * RoleSpec.cwd and RunState.isolation.
       */
      cwd?: string;
      /**
       * Never carry conversation state between turns. Every `send()` is a fresh,
       * independent call: the system prompt is prepended each time and no
       * `--resume` is used. Use this when the caller supplies the full context
       * (e.g. a maintained ledger) on every turn, so resident tokens stay
       * bounded instead of growing with the conversation.
       */
      stateless?: boolean;
      /**
       * If set, the session "beats" this file (updates its mtime) on every chunk
       * of stream output, so a watchdog can tell a working turn (recent beats)
       * from a hung one (stale). Throttled internally.
       */
      heartbeatPath?: string;
      /**
       * Claude CLI --permission-mode (e.g. "acceptEdits", "bypassPermissions",
       * "plan"). Headless -p sessions auto-deny tools the host settings don't
       * allow, so unattended seats that edit files need an explicit mode rather
       * than inheriting whatever the host happens to permit.
       */
      permissionMode?: string;
      /** Append every streamed line of every turn here (see TurnLog). */
      logPath?: string;
      /** Tools this session may not use (`--disallowedTools`), e.g. to keep a coordinator from editing. */
      disallowedTools?: string[];
      /** Kill the turn after this many seconds; 0 = no cap (the orchestrator's own turns). */
      turnTimeoutSec?: number;
    } = {}
  ) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.sessionId = opts.resumeSessionId ?? null;
    this.onSessionId = opts.onSessionId ?? null;
    this.model = opts.model ?? null;
    this.cwd = opts.cwd ?? null;
    this.stateless = opts.stateless ?? false;
    this.heartbeatPath = opts.heartbeatPath ?? null;
    this.permissionMode = opts.permissionMode ?? null;
    this.log = opts.logPath ? new TurnLog(opts.logPath) : null;
    this.disallowedTools = opts.disallowedTools ?? [];
    this.turnTimeoutMs = (opts.turnTimeoutSec ?? 0) * 1000;
  }

  private readonly turnTimeoutMs: number;

  get lastWindows(): WindowSnapshot | null {
    return this.lastWindowsData;
  }

  /** Touch the heartbeat file (throttled) to signal this turn is alive + producing. */
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

  /** Set/override the heartbeat file after construction (e.g. once the run dir exists). */
  setHeartbeatPath(p: string): void {
    this.heartbeatPath = p;
  }

  get id(): string | null {
    return this.sessionId;
  }

  /** Token usage + cost of the most recent `send()`, or null before any turn. */
  get lastUsage(): Usage | null {
    return this.lastUsageData;
  }

  /**
   * Send `prompt` to claude, get back the full text response.
   * Captures session_id on first turn and reuses it on subsequent turns.
   */
  async send(prompt: string): Promise<string> {
    this.beat(); // mark the turn started (covers the gap before first output)
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }
    if (this.disallowedTools.length) {
      args.push("--disallowedTools", ...this.disallowedTools);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // First turn: prepend the system prompt as part of the user message
    // (more robust than passing --append-system-prompt through arg quoting).
    const fullPrompt =
      !this.sessionId && this.systemPrompt
        ? `${this.systemPrompt}\n\n---\n\n${prompt}`
        : prompt;

    this.log?.mark("turn", {
      provider: "claude",
      model: this.model,
      resume: this.sessionId,
      ...promptExcerpt(prompt),
      systemChars: fullPrompt.length - prompt.length,
    });
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let assistantText = "";
      let rawStdout = ""; // full stdout, kept so a non-zero exit can surface the real error
      let limited: { message: string; resetsAt?: number } | null = null;
      let timedOut = false;
      const turnTimer =
        this.turnTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill();
              } catch {
                // already gone
              }
            }, this.turnTimeoutMs)
          : null;

      child.stdout!.on("data", (chunk: Buffer) => {
        this.beat(); // stream output = the turn is actively working
        const text = chunk.toString("utf8");
        rawStdout += text;
        stdoutBuf += text;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          this.log?.raw(line);
          try {
            const msg = JSON.parse(line);
            if (typeof msg.session_id === "string" && !this.sessionId && !this.stateless) {
              this.sessionId = msg.session_id;
              this.onSessionId?.(msg.session_id);
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && typeof block.text === "string") {
                  assistantText += block.text;
                }
              }
            }
            // The CLI reports the account's plan windows on every turn — the
            // same numbers the usage page shows. Keep the latest.
            if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
              const info = msg.rate_limit_info;
              if (typeof info.status === "string" && info.status !== "allowed" && !info.isUsingOverage) {
                limited = {
                  message: `claude ${info.rateLimitType ?? "plan"} limit: ${info.status}`,
                  resetsAt: Number(info.resetsAt) || undefined,
                };
              }
            }
            if (msg.type === "rate_limit_event" && msg.rate_limit_info?.unifiedWindows) {
              const w = msg.rate_limit_info.unifiedWindows;
              this.lastWindowsData = {
                fiveHour: w.five_hour ? { utilization: Number(w.five_hour.utilization) || 0, resetsAt: Number(w.five_hour.resetsAt) || 0 } : undefined,
                sevenDay: w.seven_day ? { utilization: Number(w.seven_day.utilization) || 0, resetsAt: Number(w.seven_day.resetsAt) || 0 } : undefined,
                at: Date.now(),
              };
            }
            if (msg.type === "result") {
              const u = (msg.usage ?? {}) as Record<string, number>;
              this.lastUsageData = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheReadTokens: u.cache_read_input_tokens ?? 0,
                cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
                costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
              };
              if (typeof msg.result === "string" && !assistantText) {
                assistantText = msg.result;
              }
            }
          } catch {
            // Non-JSON line — ignore.
          }
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
      });

      child.on("error", reject);
      child.on("exit", (code) => {
        if (turnTimer) clearTimeout(turnTimer);
        if (timedOut) {
          this.log?.mark("end", { code, ms: Date.now() - startedAt, timedOut: true });
          reject(new Error(`claude turn exceeded its ${Math.round(this.turnTimeoutMs / 1000)}s cap and was stopped — the ask was too big for one turn; re-scope it smaller`));
          return;
        }
        this.log?.mark("end", {
          code,
          ms: Date.now() - startedAt,
          usage: this.lastUsageData,
          ...(code === 0 ? {} : { stderr: stderrBuf.slice(-1500) }),
        });
        if (code === 0 && limited && !assistantText.trim()) {
          reject(new ProviderExhaustedError("claude", limited.message, limited.resetsAt));
          return;
        }
        if (code === 0) {
          resolve(assistantText.trim());
        } else if (limited || looksExhausted(stderrBuf + rawStdout)) {
          reject(new ProviderExhaustedError("claude", limited?.message ?? `claude reports its limit is reached: ${(stderrBuf || rawStdout).trim().slice(-300)}`, limited?.resetsAt));
        } else {
          // The claude CLI in stream-json mode writes its error to STDOUT, and
          // the line-parser above silently drops non-JSON lines — so stderr is
          // usually empty on failure. Surface both raw streams (tailed) so the
          // actual cause (bad model, auth, usage limit, arg error) is visible.
          const tail = (s: string) => {
            const t = s.trim();
            return t.length > 1500 ? "…" + t.slice(-1500) : t || "(empty)";
          };
          reject(
            new Error(
              `claude exited ${code}\n` +
                `  args: ${args.join(" ")}\n` +
                `  stderr: ${tail(stderrBuf)}\n` +
                `  stdout: ${tail(rawStdout)}`,
            ),
          );
        }
      });

      child.stdin!.write(fullPrompt);
      child.stdin!.end();
    });
  }
}

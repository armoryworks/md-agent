import spawn from "cross-spawn";
import fs from "node:fs";
import type { Usage } from "./persist.js";

/**
 * The provider-agnostic seat interface the orchestrator and roles drive. Both
 * ClaudeSession and GeminiSession implement it, so the run loop never cares which
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
  private lastUsageData: Usage | null = null;
  private readonly stateless: boolean;
  private heartbeatPath: string | null;
  private permissionMode: string | null;
  private lastBeat = 0;

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
    } = {}
  ) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.sessionId = opts.resumeSessionId ?? null;
    this.onSessionId = opts.onSessionId ?? null;
    this.model = opts.model ?? null;
    this.stateless = opts.stateless ?? false;
    this.heartbeatPath = opts.heartbeatPath ?? null;
    this.permissionMode = opts.permissionMode ?? null;
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
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    // First turn: prepend the system prompt as part of the user message
    // (more robust than passing --append-system-prompt through arg quoting).
    const fullPrompt =
      !this.sessionId && this.systemPrompt
        ? `${this.systemPrompt}\n\n---\n\n${prompt}`
        : prompt;

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let assistantText = "";
      let rawStdout = ""; // full stdout, kept so a non-zero exit can surface the real error

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
        if (code === 0) {
          resolve(assistantText.trim());
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

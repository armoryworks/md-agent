import spawn from "cross-spawn";
import type { Usage } from "./persist.js";

/**
 * A persistent (session-resumed) claude conversation.
 * First call starts a new session and prepends the system prompt to the
 * user's first message; subsequent calls use --resume <session-id> so the
 * session keeps that context.
 */
export class ClaudeSession {
  private sessionId: string | null = null;
  private systemPrompt: string | null;
  private onSessionId: ((id: string) => void) | null;
  private model: string | null;
  private lastUsageData: Usage | null = null;

  constructor(
    opts: {
      systemPrompt?: string;
      /** Reattach to an existing claude session instead of starting a new one. */
      resumeSessionId?: string;
      /** Called once, when a fresh session id is first captured. */
      onSessionId?: (id: string) => void;
      /** Concrete claude model id to run this session on (passed as --model). */
      model?: string;
    } = {}
  ) {
    this.systemPrompt = opts.systemPrompt ?? null;
    this.sessionId = opts.resumeSessionId ?? null;
    this.onSessionId = opts.onSessionId ?? null;
    this.model = opts.model ?? null;
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
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (this.model) {
      args.push("--model", this.model);
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

      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (typeof msg.session_id === "string" && !this.sessionId) {
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
          reject(new Error(`claude exited ${code}: ${stderrBuf}`));
        }
      });

      child.stdin!.write(fullPrompt);
      child.stdin!.end();
    });
  }
}

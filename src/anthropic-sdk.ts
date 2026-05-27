import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import type { Usage } from "./persist.js";
import type { AgentSession } from "./claude.js";

/**
 * OPT-IN orchestrator transport (P3 Step 2), off by default — enable with
 * MD_AGENT_ORCH_SDK=1. Backs the orchestrator seat with the Anthropic Messages API
 * instead of the `claude` CLI, marking the (static) system prompt
 * `cache_control: ephemeral` so warm turns read it from cache instead of re-paying.
 *
 * Stateless by design (matches the orchestrator): every send() is one streamed
 * Messages request — cached system prefix + the ledger/event as the user turn — so
 * the small per-turn payload stays bounded while the big static prefix is cached.
 *
 * Requires ANTHROPIC_API_KEY in the environment (separate from the CLI's auth).
 * Only worth enabling once P3 Step 1's cache-hit metric shows the CLI orchestrator
 * is running cold (sparse turn cadence past the ~5-min cache TTL). USD cost is not
 * computed on this path (the API returns tokens, not cost); token usage incl. cache
 * read/creation IS captured, so the Step-1 cache metric still works.
 */
export class AnthropicSdkSession implements AgentSession {
  private client: Anthropic;
  private systemPrompt: string | null;
  private model: string;
  private maxTokens: number;
  private heartbeatPath: string | null;
  private lastBeat = 0;
  private lastUsageData: Usage | null = null;

  constructor(
    opts: { systemPrompt?: string; model?: string; maxTokens?: number; heartbeatPath?: string } = {}
  ) {
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    this.systemPrompt = opts.systemPrompt ?? null;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.maxTokens = opts.maxTokens ?? 16384;
    this.heartbeatPath = opts.heartbeatPath ?? null;
  }

  get id(): string | null {
    return null; // stateless transport — no resumable session id
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
      // best-effort liveness signal
    }
  }

  async send(prompt: string): Promise<string> {
    this.beat();
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      // The static system prompt is the cacheable prefix; the ledger+event ride in
      // the user turn and change every call.
      system: this.systemPrompt
        ? [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }]
        : undefined,
      messages: [{ role: "user", content: prompt }],
    });
    stream.on("text", () => this.beat()); // stream output = the turn is alive
    const msg = await stream.finalMessage();
    const u = msg.usage;
    this.lastUsageData = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: 0, // not computed on this path (API returns tokens, not cost)
    };
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}

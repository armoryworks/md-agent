/**
 * Live smoke test for the Gemini adapter (src/gemini.ts).
 * Run in a shell where GEMINI_API_KEY is set + the CLI is authed:
 *   npx tsx smoke-gemini.ts        (or: npm run smoke:gemini)
 *
 * Makes ONE cheap Flash-lite call through the real GeminiSession and checks that
 * the JSON parser extracted clean text (not raw JSON) and captured a session id.
 * This validates the one path that was built defensively without a live call:
 * extractText() / extractUsage() against the actual `gemini -o json` shape.
 */
import { GeminiSession } from "./src/gemini.js";

async function main(): Promise<void> {
  console.log("[smoke-gemini] one Flash-lite call through GeminiSession…\n");
  const session = new GeminiSession({
    systemPrompt: "You are a terse test fixture. Answer in as few words as possible.",
    model: "gemini-2.5-flash-lite",
  });

  let reply: string;
  try {
    reply = await session.send("Reply with exactly one word: pong");
  } catch (e) {
    console.error("✗ FAIL — send() threw:\n" + (e as Error).message);
    console.error(
      "\nIf this is an auth/trust error, fix that first (GEMINI_API_KEY / --skip-trust is already passed)."
    );
    process.exit(1);
  }

  console.log("reply      :", JSON.stringify(reply));
  console.log("session id :", session.id);
  console.log("usage      :", JSON.stringify(session.lastUsage));

  let failures = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
    if (!cond) failures++;
  };

  console.log("");
  check("got a non-empty reply", reply.trim().length > 0);
  check(
    "reply is clean text, not raw JSON",
    !reply.trimStart().startsWith("{"),
    "extractText() likely fell back to raw stdout — the success field is NOT `response`; " +
      "inspect the object and update extractText() in src/gemini.ts"
  );
  check("reply contains 'pong'", /pong/i.test(reply), "model didn't comply, or text wasn't extracted");
  check("captured a session id", !!session.id, "session_id not parsed from the json envelope");
  check(
    "usage has token counts (optional)",
    !!session.lastUsage && session.lastUsage.outputTokens > 0,
    "stats token fields differ from what extractUsage() expects — non-fatal (cost untracked anyway)"
  );

  console.log(`\n${failures === 0 ? "ALL PASS ✓ — Gemini adapter validated" : `${failures} CHECK(S) FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

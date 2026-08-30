/**
 * Live smoke test for the Antigravity adapter (src/agy.ts).
 * Run in a shell where the agy CLI is installed and authed:
 *   npx tsx smoke-agy.ts        (or: npm run smoke:agy)
 *
 * Makes TWO cheap flash-low calls through the real AgySession. The second is the
 * point: agy is stateful, so it must reuse the conversation_id from the first and
 * the model must remember what it was told. That is the path built against a live
 * response shape rather than a guess — extractText()/extractUsage() over
 * `agy -p --output-format json`, plus --conversation resume.
 */
import { AgySession } from "./src/agy.js";

async function main(): Promise<void> {
  console.log("[smoke-agy] two flash-low calls through AgySession…\n");
  const session = new AgySession({
    systemPrompt: "You are a terse test fixture. Answer in as few words as possible.",
    model: "gemini-3.7-flash-low",
  });

  let reply: string;
  try {
    reply = await session.send("Reply with exactly one word: pong");
  } catch (e) {
    console.error("✗ FAIL — first send() threw:\n" + (e as Error).message);
    process.exit(1);
  }

  let ok = true;
  const check = (label: string, pass: boolean, detail: string) => {
    console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : " — " + detail}`);
    if (!pass) ok = false;
  };

  check("reply is clean text, not raw JSON", !reply.trimStart().startsWith("{"), `got: ${reply.slice(0, 120)}`);
  check("reply contains 'pong'", /pong/i.test(reply), `got: ${reply.slice(0, 120)}`);
  check("conversation id captured", !!session.id, "session.id is null — resume will not work");

  const u = session.lastUsage;
  check("usage recorded", !!u && u.inputTokens > 0, `got: ${JSON.stringify(u)}`);

  // The stateful path: a resumed turn must see the first one.
  const firstId = session.id;
  try {
    const second = await session.send("What single word did you just reply with?");
    check("second turn reuses the same conversation", session.id === firstId, `${firstId} -> ${session.id}`);
    check("session remembered the first turn", /pong/i.test(second), `got: ${second.slice(0, 120)}`);
  } catch (e) {
    check("second send() succeeded", false, (e as Error).message);
  }

  console.log(ok ? "\n[smoke-agy] PASS" : "\n[smoke-agy] FAIL");
  process.exit(ok ? 0 : 1);
}

void main();

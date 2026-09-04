// Shown after `npm install -g` where npm lets script output through (older
// npm, yarn, pnpm, or --foreground-scripts). The home screen makes the same
// offer on first run, which is the path that always works.
if (!process.env.CI && process.env.npm_config_loglevel !== "silent") {
  process.stdout.write(
    [
      "",
      "  md-agent installed.",
      "  Teach Claude Code when to reach for a team:  md-agent skill install",
      "  Then in any Claude Code session: /md-agent, or just describe a team-sized task.",
      "",
    ].join("\n")
  );
}

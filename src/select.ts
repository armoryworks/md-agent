import { checkbox, select, Separator } from "@inquirer/prompts";
import type { ParsedMarkdown, Section } from "./parse.js";

export type Selection =
  | { kind: "all" }
  | { kind: "frontmatter" }
  | { kind: "sections"; sections: Section[] }
  | { kind: "codeBlocks"; blocks: { lang: string; code: string }[] };

export async function chooseSelection(parsed: ParsedMarkdown): Promise<Selection> {
  const mode = await select({
    message: "What content should we send?",
    choices: [
      { name: "Entire file", value: "all" as const },
      { name: "Pick section(s)", value: "sections" as const },
      { name: "All code blocks", value: "codeBlocks" as const },
      ...(parsed.frontmatter
        ? [{ name: "Frontmatter only", value: "frontmatter" as const }]
        : []),
    ],
  });

  if (mode === "all") return { kind: "all" };
  if (mode === "frontmatter") return { kind: "frontmatter" };
  if (mode === "codeBlocks") return { kind: "codeBlocks", blocks: parsed.codeBlocks };

  // mode === "sections"
  if (parsed.sections.length === 0) {
    console.error("No sections found in this file. Sending entire file.");
    return { kind: "all" };
  }

  const picked = await checkbox({
    message: "Select section(s) (space to toggle, enter to confirm):",
    choices: parsed.sections.map((s, i) => ({
      name: s.heading,
      value: i,
    })),
    validate: (items) => items.length > 0 || "Pick at least one section.",
  });

  return {
    kind: "sections",
    sections: picked.map((i) => parsed.sections[i]),
  };
}

export function renderSelection(parsed: ParsedMarkdown, sel: Selection): string {
  switch (sel.kind) {
    case "all":
      return parsed.raw;
    case "frontmatter":
      return JSON.stringify(parsed.frontmatter, null, 2);
    case "sections":
      return sel.sections
        .map((s) => (s.level > 0 ? `${s.heading}\n\n${s.body}` : s.body))
        .join("\n\n");
    case "codeBlocks":
      return sel.blocks
        .map((b) => "```" + b.lang + "\n" + b.code + "```")
        .join("\n\n");
  }
}

import matter from "gray-matter";

export interface Section {
  heading: string;       // e.g. "## Installation" — or "(frontmatter)" / "(preamble)"
  level: number;         // heading level; 0 for frontmatter/preamble
  body: string;          // section body (without the heading line)
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown> | null;
  sections: Section[];   // includes preamble + every heading section
  codeBlocks: { lang: string; code: string }[];
  raw: string;           // original file content (without frontmatter)
}

export function parseMarkdown(input: string): ParsedMarkdown {
  const fm = matter(input);
  const body = fm.content;

  const sections: Section[] = [];
  const lines = body.split(/\r?\n/);

  let currentHeading = "(preamble)";
  let currentLevel = 0;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0 || sections.length === 0) {
      sections.push({ heading: currentHeading, level: currentLevel, body: text });
    }
    buffer = [];
  };

  const headingRe = /^(#{1,6})\s+(.*)$/;
  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      flush();
      currentLevel = m[1].length;
      currentHeading = `${m[1]} ${m[2].trim()}`;
    } else {
      buffer.push(line);
    }
  }
  flush();

  // Drop empty preamble if file starts with a heading.
  if (
    sections.length > 0 &&
    sections[0].heading === "(preamble)" &&
    sections[0].body === ""
  ) {
    sections.shift();
  }

  // Extract fenced code blocks across the whole body.
  const codeBlocks: { lang: string; code: string }[] = [];
  const fenceRe = /```(\w*)\r?\n([\s\S]*?)```/g;
  let cm: RegExpExecArray | null;
  while ((cm = fenceRe.exec(body)) !== null) {
    codeBlocks.push({ lang: cm[1] || "text", code: cm[2] });
  }

  return {
    frontmatter: Object.keys(fm.data).length > 0 ? (fm.data as Record<string, unknown>) : null,
    sections,
    codeBlocks,
    raw: body,
  };
}

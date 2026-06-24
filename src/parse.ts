import { promises as fs } from "node:fs";

/**
 * A parsed rule block extracted from an agent-instruction file.
 *
 * Heuristic: a markdown document is split into blocks by ATX headings
 * (`#`..`######`). Each heading starts a new block whose `headingPath` is the
 * stack of enclosing heading titles. Content before the first heading becomes
 * a synthetic block with an empty heading path (the file "preamble").
 *
 * Non-markdown files (e.g. `.cursorrules`) have no headings and are returned
 * as a single block with an empty heading path containing the whole file.
 */
export interface Block {
  /** Source file (relative path). */
  source: string;
  /** Stack of heading titles, outermost first. Empty for preamble / no-heading files. */
  headingPath: string[];
  /** Heading level (1-6) of the block's own heading, or 0 for preamble. */
  level: number;
  /** Raw body text exactly as it appeared (excludes the heading line itself). */
  rawBody: string;
  /** Normalized body: lowercased, whitespace-collapsed, list/quote markers stripped. */
  normalizedBody: string;
  /** 1-indexed inclusive start line of the block (heading line, or 1 for preamble). */
  startLine: number;
  /** 1-indexed inclusive end line of the block. */
  endLine: number;
}

export interface ParseOptions {
  /** Treat the input as a non-markdown plain-rules file (one big block). */
  plain?: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Normalize a body for cross-file matching.
 *
 * - Lowercase
 * - Strip leading list markers (`-`, `*`, `+`, `1.`) and blockquote `>`
 * - Collapse internal whitespace
 * - Drop blank lines
 * - Trim
 */
export function normalizeBody(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const line of lines) {
    const stripped = line
      .replace(/^\s*[>]+\s?/, "") // blockquote
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "") // list marker
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length > 0) cleaned.push(stripped);
  }
  return cleaned.join(" ").toLowerCase();
}

/**
 * Parse a markdown agent-instruction file into a flat array of blocks.
 *
 * The parser is deliberately tiny — it only understands ATX headings and
 * treats everything else as body. Fenced code blocks (``` ... ```) are kept
 * verbatim and never split, even if they contain `#` characters.
 */
export function parseBlocks(
  source: string,
  content: string,
  options: ParseOptions = {},
): Block[] {
  if (options.plain) {
    return [
      {
        source,
        headingPath: [],
        level: 0,
        rawBody: content,
        normalizedBody: normalizeBody(content),
        startLine: 1,
        endLine: Math.max(1, content.split(/\r?\n/).length),
      },
    ];
  }

  const lines = content.split(/\r?\n/);
  const blocks: Block[] = [];

  // Heading stack: each entry is { level, title }.
  const stack: { level: number; title: string }[] = [];

  let curStart = 1;
  let curLevel = 0;
  let curTitle: string | null = null;
  let curBody: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const pushHeadingPath = (level: number): string[] => {
    // Pop deeper-or-equal levels off the stack, then return the titles.
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    return stack.map((s) => s.title);
  };

  const flush = (endLine: number) => {
    // Skip empty preamble (no heading + no body).
    if (curTitle === null && curBody.every((l) => l.trim() === "")) return;

    const headingPath =
      curTitle === null ? [] : [...stack.map((s) => s.title), curTitle];
    const rawBody = curBody.join("\n").replace(/\n+$/, "");
    blocks.push({
      source,
      headingPath,
      level: curLevel,
      rawBody,
      normalizedBody: normalizeBody(rawBody),
      startLine: curStart,
      endLine,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Fenced code block tracking — never split inside a fence.
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0].repeat(3); // type of fence
      } else if (marker.startsWith(fenceMarker)) {
        inFence = false;
      }
      curBody.push(line);
      continue;
    }

    if (!inFence) {
      const h = HEADING_RE.exec(line);
      if (h) {
        // Close previous block.
        flush(lineNo - 1);

        const level = h[1].length;
        const title = h[2].trim();

        // Build the new heading's parent stack.
        if (curTitle !== null) {
          // Push the just-closed heading onto the stack first (if it would
          // be a parent of this one); otherwise unwind in pushHeadingPath.
          stack.push({ level: curLevel, title: curTitle });
        }
        pushHeadingPath(level);

        curStart = lineNo;
        curLevel = level;
        curTitle = title;
        curBody = [];
        continue;
      }
    }

    curBody.push(line);
  }
  flush(lines.length);

  return blocks;
}

export interface ParseFileOptions extends ParseOptions {
  /** Override the recorded `source` string (defaults to the file path). */
  source?: string;
}

/** Read a file from disk and parse it. */
export async function parseFile(
  filePath: string,
  options: ParseFileOptions = {},
): Promise<Block[]> {
  const content = await fs.readFile(filePath, "utf8");
  const plain =
    options.plain ??
    /(^|\/)\.cursorrules$|(^|\/)\.windsurfrules$/.test(filePath);
  return parseBlocks(options.source ?? filePath, content, { plain });
}

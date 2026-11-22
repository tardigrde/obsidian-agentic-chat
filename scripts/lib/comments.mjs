import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const CODE_ROOTS = ["src", "test", "scripts"];
export const BASELINE_PATH = path.join("config", "comment-baseline.json");
const CODE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".mjs", ".cjs", ".js", ".jsx"]);
const FUNCTIONAL = [
  /^\/\/\/\s*<reference\b/,
  /@ts-(?:ignore|expect-error|nocheck)\b/,
  /\beslint-(?:disable|enable)(?:-next-line|-line)?\b/,
  /\bNOSONAR\b/,
  /\b(?:istanbul|c8|v8)\s+ignore\b/,
  /\bStryker\s+disable/,
  /\bSPDX-License-Identifier\b/,
  /\b(?:MIT|Apache-2\.0|GPL|BSD|ISC)\b[^\n]*\bLicense\b/,
  /^\s*\/\*\s*(?:global|exported)\b/,
];

export function isFunctionalComment(text) {
  return FUNCTIONAL.some((pattern) => pattern.test(text));
}

export function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(path.extname(filePath));
}

export function scanComments(text, filePath = "input.ts") {
  const scriptKind = /\.(?:tsx|jsx)$/.test(filePath) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const full = source.getFullText();
  const ranges = new Map();
  const remember = (comment) => {
    ranges.set(`${comment.pos}:${comment.end}`, comment);
  };
  for (const comment of ts.getLeadingCommentRanges(full, 0) ?? []) remember(comment);
  const visit = (node) => {
    for (const child of node.getChildren(source)) {
      for (const comment of ts.getLeadingCommentRanges(full, child.pos) ?? []) remember(comment);
      for (const comment of ts.getTrailingCommentRanges(full, child.end) ?? []) remember(comment);
      visit(child);
    }
  };
  visit(source);
  return [...ranges.values()]
    .sort((left, right) => left.pos - right.pos)
    .map((comment) => ({ comment, raw: full.slice(comment.pos, comment.end) }))
    .filter(({ raw }) => !isFunctionalComment(raw))
    .map(({ comment, raw }) => ({
      file: filePath,
      line: source.getLineAndCharacterOfPosition(comment.pos).line + 1,
      endLine: source.getLineAndCharacterOfPosition(comment.end).line + 1,
      raw,
    }));
}

export function relativePath(filePath, root = process.cwd()) {
  return path.relative(root, path.resolve(root, filePath)).split(path.sep).join("/");
}

export function walkCodeFiles(root = process.cwd()) {
  const files = [];
  const visit = (absolute) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist", "vendor", "coverage"].includes(entry.name)) continue;
        visit(path.join(absolute, entry.name));
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        files.push(path.join(absolute, entry.name));
      }
    }
  };
  for (const top of CODE_ROOTS) {
    const absolute = path.join(root, top);
    if (fs.existsSync(absolute)) visit(absolute);
  }
  return files.sort();
}

export function collectComments(root = process.cwd(), files = walkCodeFiles(root)) {
  const result = new Map();
  for (const absolute of files) {
    const relative = relativePath(absolute, root);
    const comments = scanComments(fs.readFileSync(absolute, "utf8"), relative);
    result.set(relative, comments);
  }
  return result;
}

export function readBaseline(baselinePath = path.join(process.cwd(), BASELINE_PATH)) {
  if (!fs.existsSync(baselinePath)) return { version: 1, total: 0, files: {} };
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

export function compareBudget(commentsByFile, baseline) {
  const additions = [];
  let currentTotal = 0;
  let baselineTotal = 0;
  for (const [file, comments] of commentsByFile) {
    const budget = baseline.files?.[file] ?? 0;
    currentTotal += comments.length;
    baselineTotal += budget;
    if (comments.length <= budget) continue;
    additions.push({
      file,
      baseline: budget,
      current: comments.length,
      newComments: comments.slice(budget),
    });
  }
  return { additions, currentTotal, baselineTotal };
}

export function baselineFrom(commentsByFile) {
  const files = {};
  let total = 0;
  for (const [file, comments] of [...commentsByFile].sort(([left], [right]) => left.localeCompare(right))) {
    if (comments.length === 0) continue;
    files[file] = comments.length;
    total += comments.length;
  }
  return {
    version: 1,
    note: "Comment ratchet: adding comments above these per-file counts warns in CI; run `npm run lint:comments -- --update` after deleting comments to ratchet down.",
    total,
    files,
  };
}

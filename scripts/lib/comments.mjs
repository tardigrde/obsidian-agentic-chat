import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const CODE_ROOTS = ["src", "test", "scripts"];
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

function scriptKindFor(filePath) {
  if (/\.(?:tsx|jsx)$/.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(text, filePath) {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
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
  return { source, full, ranges: [...ranges.values()].sort((left, right) => left.pos - right.pos) };
}

export function scanComments(text, filePath = "input.ts") {
  const { source, full, ranges } = parse(text, filePath);
  return ranges
    .map((comment) => ({ comment, raw: full.slice(comment.pos, comment.end) }))
    .filter(({ raw }) => !isFunctionalComment(raw))
    .map(({ comment, raw }) => ({
      file: filePath,
      line: source.getLineAndCharacterOfPosition(comment.pos).line + 1,
      endLine: source.getLineAndCharacterOfPosition(comment.end).line + 1,
      raw,
    }));
}

export function blankComments(text, filePath = "input.ts") {
  const { full, ranges } = parse(text, filePath);
  let result = "";
  let cursor = 0;
  for (const comment of ranges) {
    result += full.slice(cursor, comment.pos) + full.slice(comment.pos, comment.end).replace(/[^\r\n]/g, " ");
    cursor = comment.end;
  }
  return result + full.slice(cursor);
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
  return files.sort((left, right) => left.localeCompare(right));
}

export function collectComments(root = process.cwd(), files = walkCodeFiles(root)) {
  const result = new Map();
  for (const absolute of files) {
    const relative = relativePath(absolute, root);
    result.set(relative, scanComments(fs.readFileSync(absolute, "utf8"), relative));
  }
  return result;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); // NOSONAR:S4036 -- git from PATH.
}

function inCodeRoots(file) {
  return isCodeFile(file) && CODE_ROOTS.some((top) => file.startsWith(`${top}/`));
}

export function resolveBase(candidates, cwd = process.cwd()) {
  for (const ref of candidates) {
    if (!ref) continue;
    try {
      const sha = git(cwd, ["merge-base", ref, "HEAD"]).trim();
      if (sha) return { ref, sha };
    } catch {
      // Missing ref or no shared history: try the next candidate.
    }
  }
  return null;
}

export function changedCodeFiles(sha, cwd = process.cwd()) {
  const changed = new Map();
  for (const line of git(cwd, ["diff", "--name-status", "-M", "--diff-filter=ACMR", sha]).split("\n")) {
    const [status, first, second] = line.split("\t");
    if (!status) continue;
    const file = second ?? first;
    if (inCodeRoots(file) && fs.existsSync(path.join(cwd, file))) changed.set(file, status.startsWith("R") ? first : file);
  }
  for (const file of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    if (inCodeRoots(file)) changed.set(file, file);
  }
  return changed;
}

function commentsAtBase(sha, file, cwd) {
  let text;
  try {
    text = git(cwd, ["show", `${sha}:${file}`]);
  } catch {
    return [];
  }
  return scanComments(text, file);
}

function unmatchedComments(current, base) {
  const pool = new Map();
  for (const comment of base) pool.set(comment.raw.trim(), (pool.get(comment.raw.trim()) ?? 0) + 1);
  return current.filter((comment) => {
    const key = comment.raw.trim();
    const left = pool.get(key) ?? 0;
    if (left === 0) return true;
    pool.set(key, left - 1);
    return false;
  });
}

export function compareToBase(currentByFile, baseByFile) {
  const additions = [];
  let currentTotal = 0;
  let baseTotal = 0;
  for (const [file, current] of currentByFile) {
    const base = baseByFile.get(file) ?? [];
    currentTotal += current.length;
    baseTotal += base.length;
    if (current.length <= base.length) continue;
    additions.push({
      file,
      base: base.length,
      current: current.length,
      added: current.length - base.length,
      newComments: unmatchedComments(current, base),
    });
  }
  return { additions, currentTotal, baseTotal };
}

export function compareWithBase(candidates, cwd = process.cwd()) {
  const base = resolveBase(candidates, cwd);
  if (!base) return null;
  const currentByFile = new Map();
  const baseByFile = new Map();
  for (const [file, baseFile] of changedCodeFiles(base.sha, cwd)) {
    currentByFile.set(file, scanComments(fs.readFileSync(path.join(cwd, file), "utf8"), file));
    baseByFile.set(file, commentsAtBase(base.sha, baseFile, cwd));
  }
  return { base, ...compareToBase(currentByFile, baseByFile) };
}

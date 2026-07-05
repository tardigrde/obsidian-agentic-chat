#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

const desktopOnlyAllowlist = new Map([
  [
    "src/mcp/fetcher.ts",
    {
      modules: new Set(["net", "tls"]),
      globals: new Set(["Buffer", "require"]),
      requiredText: [
        /Proxy support\..*Obsidian desktop's Node networking path/is,
        /On mobile, leave the plugin proxy fields empty/is,
      ],
    },
  ],
  [
    "src/mcp/oauth.ts",
    {
      modules: new Set(["http", "electron", "child_process"]),
      globals: new Set(["process", "require", "window.open"]),
      requiredText: [
        /OAuth sign-in uses a localhost callback on desktop and an `obsidian:\/\/agentic-chat-mcp-oauth` callback on mobile/is,
        /Providers that require localhost redirects still require Obsidian desktop sign-in/is,
      ],
    },
  ],
  [
    "src/tools/external-workspace.ts",
    {
      modules: new Set(["fs", "path", "electron"]),
      globals: new Set(["require"]),
      requiredText: [
        /External workspace root tools are desktop-only/is,
        /They are not registered on mobile/is,
      ],
    },
  ],
]);

const forbiddenModules = new Set([
  "child_process",
  "electron",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:path",
  "node:tls",
  "os",
  "path",
  "tls",
]);

const readme = readFile("README.md");
const manifest = JSON.parse(readFile("manifest.json"));
const bundle = existsSync(path.join(root, "main.js")) ? readFile("main.js") : "";

if (manifest.isDesktopOnly !== false) {
  failures.push("manifest.json must keep isDesktopOnly=false for mobile support.");
}

if (!/desktop and mobile/i.test(readme)) {
  failures.push("README.md must explicitly state the plugin supports desktop and mobile.");
}

for (const [file, allow] of desktopOnlyAllowlist) {
  for (const pattern of allow.requiredText) {
    if (!pattern.test(readme)) failures.push(`${file} has a desktop-only allowlist but README.md lacks disclosure: ${pattern}`);
  }
}

for (const file of listFiles(path.join(root, "src")).filter((candidate) => candidate.endsWith(".ts"))) {
  scanSourceFile(relative(file), readFile(file));
}

if (bundle) scanBundle(bundle);

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.warn("[verify:mobile] mobile compatibility checks passed");

function scanSourceFile(relPath, source) {
  const allow = desktopOnlyAllowlist.get(relPath);

  for (const match of source.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?\s+from\s+["']([^"']+)["']/gm)) {
    const moduleName = match[1];
    if (isForbiddenModule(moduleName)) {
      failures.push(`${relPath}:${lineOf(source, match.index)} imports desktop-only module ${moduleName}; use a guarded optional path.`);
    }
  }

  for (const match of source.matchAll(/^\s*export\s+[^;]*?\s+from\s+["']([^"']+)["']/gm)) {
    const moduleName = match[1];
    if (isForbiddenModule(moduleName)) {
      failures.push(`${relPath}:${lineOf(source, match.index)} re-exports desktop-only module ${moduleName}.`);
    }
  }

  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const moduleName = match[1];
    if (isForbiddenModule(moduleName)) {
      failures.push(`${relPath}:${lineOf(source, match.index)} directly requires desktop-only module ${moduleName}; use optional require with fallback.`);
    }
  }

  for (const match of source.matchAll(/\brequireFn\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const moduleName = match[1];
    if (isForbiddenModule(moduleName) && !allow?.modules.has(moduleName)) {
      failures.push(`${relPath}:${lineOf(source, match.index)} uses optional desktop module ${moduleName} without a mobile allowlist.`);
    }
  }

  const globalChecks = [
    { label: "Buffer", pattern: /\bBuffer\b/g },
    { label: "require", pattern: /globalThis\.require|typeof\s+require/g },
    { label: "process", pattern: /typeof\s+process\b|process\.[A-Za-z_]/g },
    { label: "window.open", pattern: /window\.open\b/g },
  ];

  for (const check of globalChecks) {
    for (const match of source.matchAll(check.pattern)) {
      if (!allow?.globals.has(check.label)) {
        failures.push(`${relPath}:${lineOf(source, match.index)} uses ${check.label}, which is not mobile-safe outside an allowlisted desktop fallback.`);
      }
    }
  }
}

function scanBundle(source) {
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const moduleName = match[1];
    if (isForbiddenModule(moduleName)) {
      failures.push(`main.js contains a direct desktop-only require(${JSON.stringify(moduleName)}).`);
    }
  }

  for (const marker of ["__AGENTIC_CHAT_E2E_TURNS__", "__AGENTIC_CHAT_E2E_CALLS__", "__AGENTIC_CHAT_E2E_CALL_LOG__"]) {
    if (source.includes(marker)) failures.push(`main.js contains WDIO-only marker ${marker}.`);
  }
}

function isForbiddenModule(moduleName) {
  if (forbiddenModules.has(moduleName)) return true;
  return moduleName.startsWith("node:") && moduleName !== "node:buffer";
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) files.push(...listFiles(file));
    else files.push(file);
  }
  return files;
}

function readFile(file) {
  return readFileSync(path.isAbsolute(file) ? file : path.join(root, file), "utf8");
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function lineOf(source, index = 0) {
  return source.slice(0, index).split(/\r?\n/).length;
}

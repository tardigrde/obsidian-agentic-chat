import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const bundle = readFileSync("main.js", "utf8");

const failures = [];
const forbiddenImports = [
  "node:fs",
  "node:os",
  "node:path",
  "electron",
  "@anthropic-ai/sdk",
  "@aws-sdk/",
  "@google/genai",
  "@mistralai/mistralai",
];
const importedSpecifiers = [
  ...bundle.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g),
].map((match) => match[1]);

if (!manifest.isDesktopOnly) {
  for (const specifier of forbiddenImports) {
    const isForbidden = specifier.endsWith("/")
      ? importedSpecifiers.some((imported) => imported.startsWith(specifier))
      : importedSpecifiers.includes(specifier);
    if (isForbidden) {
      failures.push(`main.js contains desktop-only or unused import: ${specifier}`);
    }
  }
}

if (versions[manifest.version] !== manifest.minAppVersion) {
  failures.push(
    `versions.json maps ${manifest.version} to ${versions[manifest.version] ?? "(missing)"}; expected ${manifest.minAppVersion}`,
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

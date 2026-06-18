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

if (!manifest.isDesktopOnly) {
  for (const specifier of forbiddenImports) {
    if (bundle.includes(specifier)) {
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

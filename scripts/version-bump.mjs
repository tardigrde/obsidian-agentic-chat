// Sync package metadata, manifest.json, and versions.json to the release version.
// Invoked by semantic-release (@semantic-release/exec prepareCmd).
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error("usage: node scripts/version-bump.mjs <version>");
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
packageJson.version = targetVersion;
writeFileSync("package.json", JSON.stringify(packageJson, null, 2) + "\n");

const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
packageLock.version = targetVersion;
if (packageLock.packages?.[""]) packageLock.packages[""].version = targetVersion;
writeFileSync("package-lock.json", JSON.stringify(packageLock, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

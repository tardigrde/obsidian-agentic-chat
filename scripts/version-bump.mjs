// Sync manifest.json and versions.json to the version passed as argv[2].
// Invoked by semantic-release (@semantic-release/exec prepareCmd); package.json
// is bumped separately by @semantic-release/npm.
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error("usage: node scripts/version-bump.mjs <version>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

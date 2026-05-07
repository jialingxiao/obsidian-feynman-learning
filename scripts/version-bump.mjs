import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error("Usage: node scripts/version-bump.mjs <version>");
  console.error("Example: node scripts/version-bump.mjs 1.0.4");
  process.exit(1);
}

const pkg      = JSON.parse(readFileSync("package.json",  "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

let versions = {};
try { versions = JSON.parse(readFileSync("versions.json", "utf8")); } catch {}

pkg.version      = targetVersion;
manifest.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;

writeFileSync("package.json",  JSON.stringify(pkg,      null, 2) + "\n");
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`✓ Version bumped to ${targetVersion}`);
console.log(`  Updated: package.json, manifest.json, versions.json`);

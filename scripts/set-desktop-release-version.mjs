import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rawTag = process.argv[2];
if (!rawTag) throw new Error("A release tag is required, for example v0.1.0");

const version = rawTag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid release tag: ${rawTag}. Expected vMAJOR.MINOR.PATCH`);
}

const packagePath = fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url));
const source = readFileSync(packagePath, "utf8");
const versionField = /("version"\s*:\s*")[^"]+("\s*[,}])/;
if (!versionField.test(source)) throw new Error(`Could not find a version field in ${packagePath}`);

const next = source.replace(versionField, `$1${version}$2`);
if (next !== source) writeFileSync(packagePath, next, "utf8");
console.log(`Desktop release version: ${version}`);

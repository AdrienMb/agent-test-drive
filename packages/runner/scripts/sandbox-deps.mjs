// Writes dist/sandbox-deps.json: the exact installed version of each runner dependency.
// Railway sandboxes can't run our Docker image, so the server installs these versions with npm
// in a sandbox template, and the server image doesn't need to ship the SDKs (~350 MB each).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const { dependencies = {} } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

function installedVersion(name) {
  for (let dir = pkgDir; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
    if (dirname(dir) === dir) throw new Error(`${name} is not installed; run yarn install`);
  }
}

const versions = Object.fromEntries(
  Object.entries(dependencies)
    .filter(([, range]) => !range.startsWith("workspace:"))
    .map(([name]) => [name, installedVersion(name)]),
);
writeFileSync(join(pkgDir, "dist", "sandbox-deps.json"), `${JSON.stringify(versions, null, 2)}\n`);

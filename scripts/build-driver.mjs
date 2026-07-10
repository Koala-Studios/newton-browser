import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "driver", "src");
const destination = path.join(root, "packages", "driver", "dist");

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:js|css)$/.test(entry.name)) continue;
  fs.copyFileSync(path.join(source, entry.name), path.join(destination, entry.name));
}
console.log("browser bridge driver build ok");

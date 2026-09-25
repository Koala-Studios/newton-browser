import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The files a boundary check reads: Git's tracked and non-ignored files, so local runtime
 * residue (ignored run evidence, builds, profiles) is never scanned. A path through a symlink
 * is reported instead of followed.
 */
export function sourceInventory(root) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = [], symlinks = [];
  for (const relative of [...new Set(output.split("\0").filter(Boolean))].sort()) {
    if (relative.includes("\\") || relative.split("/").some(part => part === ".." || part === "")) { symlinks.push(relative); continue; }
    let linked = false, current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch { stat = undefined; }
      if (!stat) { linked = undefined; break; }
      if (stat.isSymbolicLink()) { linked = true; break; }
    }
    if (linked === undefined) continue; // deleted in the working tree
    if (linked) symlinks.push(relative);
    else files.push(path.join(root, relative));
  }
  return { files, symlinks };
}

import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterInstallation } from "./adapter-update.ts";

export type AdapterControl = Pick<AdapterInstallation, "quiesce" | "reload" | "waitBootstrap" | "smoke">;
/** Single bundled code file: atomically replace it, leaving the stable manifest/ID/permissions intact. */
export async function developmentAdapterInstallation(directory: string, staged: string, control: AdapterControl): Promise<AdapterInstallation> {
  const {root,oldCode,newCode}=await readAdapterBuilds(directory,staged);
  return adapterCodeInstallation(root,oldCode,newCode,control);
}
export async function readAdapterBuilds(directory:string,staged:string):Promise<{root:string;oldCode:Buffer;newCode:Buffer}>{
  const root = await checkedDirectory(directory), stage = await checkedDirectory(staged);
  const currentManifest = await checkedFile(path.join(root, "manifest.json"), 16 * 1024);
  const stagedManifest = await checkedFile(path.join(stage, "manifest.json"), 16 * 1024);
  const current=JSON.parse(currentManifest.toString()),candidate=JSON.parse(stagedManifest.toString());
  // Packaged worker artifacts have no installation-specific key. Preserve the
  // installed key; an explicitly different key still fails exact comparison.
  if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&candidate.key===undefined)candidate.key=current.key;
  if (JSON.stringify(current) !== JSON.stringify(candidate)) throw new Error("adapter_manifest_changed");
  const oldCode = await checkedFile(path.join(root, "worker.js"), 1024 * 1024);
  const newCode = await checkedFile(path.join(stage, "worker.js"), 1024 * 1024);
  return {root,oldCode,newCode};
}
export function adapterCodeInstallation(root:string,oldCode:Buffer,newCode:Buffer,control:AdapterControl):AdapterInstallation{
  const previous = hash(oldCode), next = hash(newCode);
  const versions = new Map([[previous, oldCode], [next, newCode]]);
  return {
    ...control,
    async validateBuild(digest) { if (digest !== next || !versions.has(digest)) throw new Error("adapter_build_changed"); },
    async currentDigest() { return hash(await checkedFile(path.join(root, "worker.js"), 1024 * 1024)); },
    async publish(digest) {
      if (await checkedDirectory(root) !== root) throw new Error("adapter_path_changed");
      const code = versions.get(digest); if (!code || hash(code) !== digest) throw new Error("adapter_build_unknown");
      const filename = path.join(root, `worker-${randomUUID()}.stage`);
      const handle = await fs.open(filename, "wx");
      try{
        try { await handle.writeFile(code); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(filename, path.join(root, "worker.js"));
      }finally{await fs.unlink(filename).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    },
  };
}
async function checkedDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory), canonical = await fs.realpath(resolved);
  if (canonical !== resolved || (await fs.lstat(resolved)).isSymbolicLink()) throw new Error("adapter_path_invalid");
  return canonical;
}
async function checkedFile(filename: string, cap: number): Promise<Buffer> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new Error("adapter_file_invalid");
  return fs.readFile(filename);
}
function hash(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }

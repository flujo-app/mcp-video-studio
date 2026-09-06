import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioException } from "./errors.js";

export async function atomicWrite(filePath: string, content: string | Uint8Array): Promise<void> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, resolved);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readJson<T>(filePath: string): Promise<T> {
  try {
    const handle = await open(filePath, "r");
    try {
      const limit = 64 * 1024 * 1024, info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw new Error("JSON document exceeds the 64 MiB file limit.");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error("JSON document exceeds the 64 MiB file limit.");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } finally { await handle.close(); }
  } catch (error) {
    throw new StudioException("READ_FAILED", `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`, "runtime");
  }
}

export async function sha256File(filePath: string,signal?:AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new StudioException("NOT_A_FILE", `${filePath} is not a file.`, "input");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath,{signal});
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return { sha256: hash.digest("hex"), bytes: info.size };
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function ensureInside(root: string, candidate: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (!isInside(resolvedRoot, resolved)) throw new StudioException("PATH_OUTSIDE_ROOT", `${resolved} is outside ${resolvedRoot}.`, "policy");
  return confinedPath(resolvedRoot,resolved);
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const content=JSON.stringify(value,null,2)+"\n";
  if(Buffer.byteLength(content)>64*1024*1024)throw new StudioException("JSON_SIZE_LIMIT","JSON documents and history entries are limited to 64 MiB.","input");
  await atomicWrite(filePath,content);
}

export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const [info,disk]=await Promise.all([stat(source),statfs(path.dirname(destination))]);
  if(info.size+64*1024*1024>disk.bavail*disk.bsize)throw new StudioException("DISK_CAPACITY","Insufficient free space to publish this media atomically.","runtime");
  const temporary=path.join(path.dirname(destination),`.${path.basename(destination)}.${randomUUID()}.tmp`);
  try{await copyFile(source,temporary);const handle=await open(temporary,"r+");try{await handle.sync();}finally{await handle.close();}await rename(temporary,destination);}finally{await rm(temporary,{force:true}).catch(()=>undefined);}
}

export function confinedPath(root:string,candidate:string):string{
  const resolvedRoot=path.resolve(root),resolved=path.resolve(candidate);
  if(!isInside(resolvedRoot,resolved))throw new StudioException("PATH_OUTSIDE_ROOT","Managed project path escapes its directory.","policy");
  let current=resolved;
  for(;;){
    try{if(lstatSync(current).isSymbolicLink())throw new StudioException("SYMLINK_PATH","Managed project paths cannot traverse symlinks. Use an explicit linked media asset instead.","policy");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(current===resolvedRoot)break;
    current=path.dirname(current);
  }
  return resolved;
}

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioException } from "./errors.js";

export async function atomicWrite(filePath: string, content: string | Uint8Array): Promise<void> {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, resolved);
}

export async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw new StudioException("READ_FAILED", `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`, "runtime");
  }
}

export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new StudioException("NOT_A_FILE", `${filePath} is not a file.`, "input");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
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
  return resolved;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function copyFileAtomic(source: string, destination: string): Promise<void> {
  const data = await readFile(source);
  await atomicWrite(destination, data);
}

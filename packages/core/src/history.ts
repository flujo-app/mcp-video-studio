import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectCommand, StudioProject } from "@mcp-video-studio/contracts";
import { atomicWrite, readJson, writeJson } from "./fs.js";

export interface HistoryEntry {
  id: string;
  createdAt: string;
  commands: ProjectCommand[];
  before: StudioProject;
  after: StudioProject;
}

interface HistoryState {
  past: string[];
  future: string[];
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, "history", "state.json");
}

function entryPath(projectRoot: string, id: string): string {
  return path.join(projectRoot, "history", "transactions", `${id}.json`);
}

export async function loadHistoryState(projectRoot: string): Promise<HistoryState> {
  try {
    return await readJson<HistoryState>(statePath(projectRoot));
  } catch {
    return { past: [], future: [] };
  }
}

export async function recordHistory(projectRoot: string, entry: HistoryEntry): Promise<void> {
  await mkdir(path.dirname(entryPath(projectRoot, entry.id)), { recursive: true });
  const state = await loadHistoryState(projectRoot);
  await writeJson(entryPath(projectRoot, entry.id), entry);
  await writeJson(statePath(projectRoot), { past: [...state.past, entry.id].slice(-200), future: [] });
}

export async function historyUndo(projectRoot: string): Promise<{ project: StudioProject; transactionId: string } | undefined> {
  const state = await loadHistoryState(projectRoot);
  const id = state.past.at(-1);
  if (!id) return undefined;
  const entry = await readJson<HistoryEntry>(entryPath(projectRoot, id));
  await writeJson(statePath(projectRoot), { past: state.past.slice(0, -1), future: [id, ...state.future] });
  return { project: entry.before, transactionId: id };
}

export async function historyRedo(projectRoot: string): Promise<{ project: StudioProject; transactionId: string } | undefined> {
  const state = await loadHistoryState(projectRoot);
  const id = state.future[0];
  if (!id) return undefined;
  const entry = await readJson<HistoryEntry>(entryPath(projectRoot, id));
  await writeJson(statePath(projectRoot), { past: [...state.past, id], future: state.future.slice(1) });
  return { project: entry.after, transactionId: id };
}

export async function verifyHistory(projectRoot: string): Promise<{ entries: number; missing: string[] }> {
  const state = await loadHistoryState(projectRoot);
  const expected = new Set([...state.past, ...state.future]);
  const directory = path.join(projectRoot, "history", "transactions");
  let names: string[] = [];
  try { names = await readdir(directory); } catch { /* no history yet */ }
  const present = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
  return { entries: present.size, missing: [...expected].filter((id) => !present.has(id)) };
}

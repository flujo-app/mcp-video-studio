import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createDefaultProject, type MutationResult, type ProjectCommand, type ProjectDelta, type StudioProject } from "@mcp-video-studio/contracts";
import { applyProjectCommands } from "./commands.js";
import { StudioException } from "./errors.js";
import { confinedPath, readJson, writeJson } from "./fs.js";
import { projectWriteLock } from "./file-lock.js";
import { commitProject, historyRedo, historyUndo, recordHistory, verifyHistory } from "./history.js";
import { validateProject } from "./validation.js";

type Lock = Promise<void>;
const locks = new Map<string, Lock>();

async function underLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.then(() => current);
  locks.set(key, queued);
  await prior;
  try { return await projectWriteLock(key,operation); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

export function projectFile(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "project.json");
}

function changedEverything(project: StudioProject): ProjectDelta {
  return {
    sequences: project.sequences.map((item) => item.id),
    tracks: project.sequences.flatMap((sequence) => sequence.tracks.map((track) => track.id)),
    clips: project.sequences.flatMap((sequence) => sequence.clips.map((clip) => clip.id)),
    media: project.media.map((item) => item.id),
    animations: project.animations.map((item) => item.id),
    generatedArtifacts: project.generatedArtifacts.map((item) => item.id)
  };
}

export class ProjectStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    for(const name of ["project.json","assets","fonts","proxies","cache","history/transactions","jobs","exports"])confinedPath(this.root,path.join(this.root,name));
  }

  static async create(root: string, name: string): Promise<ProjectStore> {
    const store = new ProjectStore(root);
    try {
      await stat(projectFile(store.root));
      throw new StudioException("PROJECT_EXISTS", `A project already exists at ${store.root}.`, "input");
    } catch (error) {
      if (error instanceof StudioException) throw error;
    }
    await Promise.all(["assets", "fonts", "proxies", "cache", "history/transactions", "jobs", "exports"].map((directory) => mkdir(path.join(store.root, directory), { recursive: true })));
    const project = validateProject(createDefaultProject(name));
    await writeJson(projectFile(store.root), {...project,_history:{past:[],future:[]}});
    return store;
  }

  async read(): Promise<StudioProject> {
    return validateProject(await readJson<StudioProject>(projectFile(this.root)));
  }

  async mutate(expectedRevision: number, commands: ProjectCommand[]): Promise<MutationResult> {
    if (!Array.isArray(commands) || commands.length > 1000) throw new StudioException("TRANSACTION_LIMIT", "Use between 1 and 1000 commands.", "input");
    if (commands.length === 0) throw new StudioException("EMPTY_TRANSACTION", "Provide at least one command.", "input");
    return underLock(this.root, async () => {
      const before = await this.read();
      if (before.revision !== expectedRevision) throw new StudioException("REVISION_CONFLICT", "Project revision changed.", "conflict", { expectedRevision, actualRevision: before.revision });
      const applied = applyProjectCommands(before, commands);
      const now = new Date().toISOString();
      applied.project.revision = before.revision + 1;
      applied.project.updatedAt = now;
      const after = validateProject(applied.project);
      const transactionId = randomUUID();
      await recordHistory(this.root, { id: transactionId, createdAt: now, commands: structuredClone(commands), before, after });
      return { success: true, projectId: after.projectId, revision: after.revision, transactionId, changed: applied.changed, warnings: applied.warnings };
    });
  }

  async replace(expectedRevision: number, mutator: (project: StudioProject) => void, changed: ProjectDelta): Promise<MutationResult> {
    return underLock(this.root, async () => {
      const before = await this.read();
      if (before.revision !== expectedRevision) throw new StudioException("REVISION_CONFLICT", "Project revision changed.", "conflict", { expectedRevision, actualRevision: before.revision });
      let after = structuredClone(before);
      mutator(after);
      after.revision += 1;
      after.updatedAt = new Date().toISOString();
      after = validateProject(after);
      const transactionId = randomUUID();
      await recordHistory(this.root, { id: transactionId, createdAt: after.updatedAt, commands: [], before, after });
      return { success: true, projectId: after.projectId, revision: after.revision, transactionId, changed, warnings: [] };
    });
  }

  async undo(expectedRevision: number): Promise<MutationResult> {
    return underLock(this.root, async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new StudioException("REVISION_CONFLICT", "Project revision changed.", "conflict", { expectedRevision, actualRevision: current.revision });
      const restored = await historyUndo(this.root);
      if (!restored) throw new StudioException("NOTHING_TO_UNDO", "There is no transaction to undo.", "input");
      restored.project.revision = current.revision + 1;
      restored.project.updatedAt = new Date().toISOString();
      restored.project=validateProject(restored.project);
      await commitProject(this.root, restored.project, restored.state);
      return { success: true, projectId: current.projectId, revision: restored.project.revision, transactionId: `undo:${restored.transactionId}`, changed: changedEverything(restored.project), warnings: [] };
    });
  }

  async redo(expectedRevision: number): Promise<MutationResult> {
    return underLock(this.root, async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new StudioException("REVISION_CONFLICT", "Project revision changed.", "conflict", { expectedRevision, actualRevision: current.revision });
      const restored = await historyRedo(this.root);
      if (!restored) throw new StudioException("NOTHING_TO_REDO", "There is no transaction to redo.", "input");
      restored.project.revision = current.revision + 1;
      restored.project.updatedAt = new Date().toISOString();
      restored.project=validateProject(restored.project);
      await commitProject(this.root, restored.project, restored.state);
      return { success: true, projectId: current.projectId, revision: restored.project.revision, transactionId: `redo:${restored.transactionId}`, changed: changedEverything(restored.project), warnings: [] };
    });
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const project = await this.read();
    const history = await verifyHistory(this.root);
    return { root: this.root, projectId: project.projectId, revision: project.revision, history };
  }
}

export async function discoverProjects(baseDir: string): Promise<Array<{ path: string; name: string; projectId: string; revision: number }>> {
  const result: Array<{ path: string; name: string; projectId: string; revision: number }> = [];
  const entries = await readdir(baseDir, { withFileTypes: true, encoding: "utf8" }).catch(() => undefined);
  if (!entries) return result;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(baseDir, entry.name);
    try {
      const project = await new ProjectStore(root).read();
      result.push({ path: root, name: project.name, projectId: project.projectId, revision: project.revision });
    } catch { /* not a Studio project */ }
  }
  return result;
}

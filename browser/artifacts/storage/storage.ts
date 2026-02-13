import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Artifact {
  id: string;
  taskName: string;
  format: string;
  data: Buffer;
  createdAt: number;
}

/**
 * Persists task output artifacts (extracted data, screenshots, etc.)
 * to the local filesystem under a configurable root directory.
 */
export class ArtifactStorage {
  constructor(private readonly rootDir: string) {}

  async store(artifact: Artifact): Promise<string> {
    const dir = join(this.rootDir, artifact.taskName);
    await mkdir(dir, { recursive: true });

    const filename = `${artifact.id}.${artifact.format}`;
    const path = join(dir, filename);
    await writeFile(path, artifact.data);
    return path;
  }

  async load(taskName: string, id: string, format: string): Promise<Buffer> {
    const path = join(this.rootDir, taskName, `${id}.${format}`);
    return readFile(path);
  }

  async list(taskName: string): Promise<string[]> {
    const dir = join(this.rootDir, taskName);
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}

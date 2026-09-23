import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Create a minimal git directory (HEAD/config/objects/refs) for metadata tests. */
export async function createGitDirectory(path: string, config = ""): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(path, "config"), config);
  await mkdir(join(path, "objects"));
  await mkdir(join(path, "refs"));
}

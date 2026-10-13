import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A separate lock allows CLI resets and the HTTP process to update one atomic file. */
export class JsonStore<T> {
  private readonly file: string;
  constructor(
    private readonly dir: string,
    private readonly initial: () => T,
  ) {
    this.file = join(dir, "security.json");
  }
  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.initial();
      throw error;
    }
  }
  async update<R>(change: (value: T) => R | Promise<R>): Promise<R> {
    await mkdir(this.dir, { recursive: true });
    const lock = `${this.file}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        handle = await open(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!handle)
      throw new Error(
        "Security store is busy; inspect security.json.lock if a previous process crashed.",
      );
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const value = await this.read();
      const result = await change(value);
      const output = await open(temp, "wx", 0o600);
      try {
        await output.writeFile(JSON.stringify(value, null, 2));
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temp, this.file);
      return result;
    } finally {
      await rm(temp, { force: true });
      await handle.close();
      await rm(lock, { force: true });
    }
  }
}

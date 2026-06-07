import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function assertReadableFile(path: string, label: string): Promise<void> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      throw new Error(`${label} path is not a file: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} file does not exist: ${path}`);
    }
    throw error;
  }
}

export async function readBinaryFile(path: string, label: string): Promise<Uint8Array> {
  await assertReadableFile(path, label);
  return new Uint8Array(await readFile(path));
}

export async function readJsonFile(path: string, label: string): Promise<unknown> {
  const text = await readTextFile(path, label);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} file is not valid JSON: ${message}`);
  }
}

export async function readTextFile(path: string, label: string): Promise<string> {
  await assertReadableFile(path, label);
  return readFile(path, "utf8");
}

export function sha1(data: Uint8Array | string): string {
  return createHash("sha1").update(data).digest("hex");
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createRunId(parts: string[]): string {
  return `run_${sha1(parts.join(":")).slice(0, 12)}`;
}

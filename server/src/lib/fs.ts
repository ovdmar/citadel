import fs from 'node:fs';
import path from 'node:path';

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function ensureParent(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function listJsonFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dirPath, name))
    .sort();
}

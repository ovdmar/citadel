import { OPERATOR_DATA_PATH } from './config.js';
import { ensureParent, readJsonFile } from './fs.js';
import fs from 'node:fs';
import type { OperatorFlags } from '../types.js';

interface OperatorFlagsFile {
  jobs?: Record<string, OperatorFlags>;
}

export function getAllOperatorFlags(): Record<string, OperatorFlags> {
  return readJsonFile<OperatorFlagsFile>(OPERATOR_DATA_PATH)?.jobs || {};
}

export function getOperatorFlags(jobId: string): OperatorFlags {
  return getAllOperatorFlags()[jobId] || {};
}

export function setMarkedStale(jobId: string, stale: boolean) {
  const file = readJsonFile<OperatorFlagsFile>(OPERATOR_DATA_PATH) || { jobs: {} };
  file.jobs ||= {};
  const current = file.jobs[jobId] || {};
  if (stale) {
    current.markedStaleAt = new Date().toISOString();
    file.jobs[jobId] = current;
  } else {
    delete current.markedStaleAt;
    if (Object.keys(current).length === 0) delete file.jobs[jobId];
    else file.jobs[jobId] = current;
  }
  ensureParent(OPERATOR_DATA_PATH);
  fs.writeFileSync(OPERATOR_DATA_PATH, JSON.stringify(file, null, 2));
  return file.jobs?.[jobId] || {};
}

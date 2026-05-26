import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DumpRecord } from "./types.js";

const DUMP_PATH = resolve(process.cwd(), "dump.json");

export function loadRecord(): DumpRecord | null {
  if (!existsSync(DUMP_PATH)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(DUMP_PATH, "utf-8");
  } catch (err) {
    console.error(`Error reading dump.json: ${err}`);
    process.exit(1);
    return null;
  }

  try {
    return JSON.parse(raw) as DumpRecord;
  } catch {
    console.error(
      "dump.json exists but could not be parsed. Please fix or delete it and try again.",
    );
    process.exit(1);
  }
}

export function saveRecord(record: DumpRecord): void {
  record.updatedAt = Date.now();
  writeFileSync(DUMP_PATH, JSON.stringify(record, null, 2), "utf-8");
}

export function createFreshRecord(): DumpRecord {
  const now = Date.now();
  return { version: 1, createdAt: now, updatedAt: now, nodes: [] };
}

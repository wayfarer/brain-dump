import { resolve } from "node:path";

import Database from "better-sqlite3";

import type { DumpNode, MemoryDateGranularity } from "./types.js";

const DEFAULT_DB_PATH = resolve(process.cwd(), "dump.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_id TEXT REFERENCES nodes(id),
  captured_at INTEGER NOT NULL,
  memory_date TEXT,
  memory_date_granularity TEXT,
  segment TEXT NOT NULL DEFAULT 'life_story',
  depth INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_tag ON nodes(tag);
CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_captured_at ON nodes(captured_at);
CREATE INDEX IF NOT EXISTS idx_nodes_segment ON nodes(segment);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  content,
  content='nodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO nodes_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

export type Db = Database.Database;

export function openDb(path: string = DEFAULT_DB_PATH): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

interface NodeRow {
  id: string;
  tag: string;
  content: string;
  parent_id: string | null;
  captured_at: number;
  memory_date: string | null;
  memory_date_granularity: string | null;
  segment: string;
  depth: number;
}

function rowToNode(row: NodeRow): DumpNode {
  return {
    id: row.id,
    tag: row.tag,
    content: row.content,
    parentId: row.parent_id,
    capturedAt: row.captured_at,
    memoryDate: row.memory_date,
    memoryDateGranularity: row.memory_date_granularity as MemoryDateGranularity | null,
    segment: row.segment,
    depth: row.depth,
  };
}

export function insertNode(db: Db, node: DumpNode): void {
  db.prepare(
    `INSERT INTO nodes (
      id, tag, content, parent_id, captured_at,
      memory_date, memory_date_granularity, segment, depth
    ) VALUES (
      @id, @tag, @content, @parent_id, @captured_at,
      @memory_date, @memory_date_granularity, @segment, @depth
    )`,
  ).run({
    id: node.id,
    tag: node.tag,
    content: node.content,
    parent_id: node.parentId,
    captured_at: node.capturedAt,
    memory_date: node.memoryDate,
    memory_date_granularity: node.memoryDateGranularity,
    segment: node.segment,
    depth: node.depth,
  });
}

export function getNodeById(db: Db, id: string): DumpNode | null {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function getRecentNodes(db: Db, limit: number, segment?: string): DumpNode[] {
  const rows = segment
    ? (db
        .prepare("SELECT * FROM nodes WHERE segment = ? ORDER BY captured_at DESC LIMIT ?")
        .all(segment, limit) as NodeRow[])
    : (db
        .prepare("SELECT * FROM nodes ORDER BY captured_at DESC LIMIT ?")
        .all(limit) as NodeRow[]);
  return rows.map(rowToNode);
}

export function getNodeCount(db: Db, segment?: string): number {
  const row = segment
    ? (db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE segment = ?").get(segment) as {
        count: number;
      })
    : (db.prepare("SELECT COUNT(*) AS count FROM nodes").get() as { count: number });
  return row.count;
}

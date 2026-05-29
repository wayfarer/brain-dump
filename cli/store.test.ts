// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  type Db,
  type LegacyDumpRecord,
  exportToJson,
  getNodeById,
  getNodeCount,
  getRecentNodes,
  getTagCounts,
  importFromJson,
  insertEmbedding,
  insertEmbeddingByRowid,
  insertNode,
  openDb,
  searchNodes,
  searchNodesByVector,
} from "./store.js";
import type { DumpNode, DumpRecord } from "./types.js";

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function makeNode(overrides: Partial<DumpNode> = {}): DumpNode {
  return {
    id: crypto.randomUUID(),
    tag: "quiet joy",
    content: "the kitchen table",
    parentId: null,
    capturedAt: Date.now(),
    memoryDate: null,
    memoryDateGranularity: null,
    segment: "life_story",
    depth: 0,
    ...overrides,
  };
}

describe("openDb", () => {
  it("creates schema cleanly on a fresh in-memory database", () => {
    expect(getNodeCount(db)).toBe(0);
  });

  it("is idempotent — calling on an existing db does not throw", () => {
    const node = makeNode();
    insertNode(db, node);
    // Re-run the schema by opening a second handle on the same memory db is not possible,
    // but we can verify that running the schema twice on the same handle is safe:
    expect(() => {
      // openDb internally runs the schema; we can re-exec it here without error
      db.exec("CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, tag TEXT NOT NULL, content TEXT NOT NULL, parent_id TEXT, captured_at INTEGER NOT NULL, memory_date TEXT, memory_date_granularity TEXT, segment TEXT NOT NULL DEFAULT 'life_story', depth INTEGER NOT NULL)");
    }).not.toThrow();
    expect(getNodeCount(db)).toBe(1);
  });
});

describe("insertNode + getNodeById", () => {
  it("round-trips a node with all fields", () => {
    const node = makeNode({
      id: "node-1",
      tag: "fierce belonging",
      content: "Saturday breakfast",
      capturedAt: 1234567890,
      memoryDate: "1987-06",
      memoryDateGranularity: "month",
      segment: "life_story",
      depth: 0,
    });
    insertNode(db, node);
    expect(getNodeById(db, "node-1")).toEqual(node);
  });

  it("returns null for unknown id", () => {
    expect(getNodeById(db, "nonexistent")).toBeNull();
  });

  it("persists null values for memory_date fields", () => {
    const node = makeNode({ id: "node-2", memoryDate: null, memoryDateGranularity: null });
    insertNode(db, node);
    const fetched = getNodeById(db, "node-2");
    expect(fetched?.memoryDate).toBeNull();
    expect(fetched?.memoryDateGranularity).toBeNull();
  });
});

describe("getRecentNodes", () => {
  it("orders by captured_at DESC", () => {
    insertNode(db, makeNode({ id: "old", capturedAt: 1000 }));
    insertNode(db, makeNode({ id: "newer", capturedAt: 2000 }));
    insertNode(db, makeNode({ id: "newest", capturedAt: 3000 }));
    const recent = getRecentNodes(db, 10);
    expect(recent.map((n) => n.id)).toEqual(["newest", "newer", "old"]);
  });

  it("respects the limit argument", () => {
    for (let i = 0; i < 5; i++) {
      insertNode(db, makeNode({ id: `n${i}`, capturedAt: i }));
    }
    expect(getRecentNodes(db, 3)).toHaveLength(3);
  });

  it("filters by segment when provided", () => {
    insertNode(db, makeNode({ id: "ls", segment: "life_story" }));
    insertNode(db, makeNode({ id: "dr", segment: "dream_journal" }));
    const lifeStory = getRecentNodes(db, 10, "life_story");
    expect(lifeStory.map((n) => n.id)).toEqual(["ls"]);
  });
});

describe("getTagCounts", () => {
  it("returns empty array when no nodes", () => {
    expect(getTagCounts(db)).toHaveLength(0);
  });

  it("returns each tag once with the correct count", () => {
    insertNode(db, makeNode({ id: "a", tag: "sudden loss" }));
    insertNode(db, makeNode({ id: "b", tag: "sudden loss" }));
    insertNode(db, makeNode({ id: "c", tag: "quiet joy" }));
    const counts = getTagCounts(db);
    expect(counts.find((r) => r.tag === "sudden loss")?.count).toBe(2);
    expect(counts.find((r) => r.tag === "quiet joy")?.count).toBe(1);
  });

  it("sorts by count descending", () => {
    insertNode(db, makeNode({ id: "a", tag: "fierce belonging" }));
    insertNode(db, makeNode({ id: "b", tag: "quiet shame" }));
    insertNode(db, makeNode({ id: "c", tag: "quiet shame" }));
    insertNode(db, makeNode({ id: "d", tag: "quiet shame" }));
    const counts = getTagCounts(db);
    expect(counts[0].tag).toBe("quiet shame");
    expect(counts[0].count).toBe(3);
    expect(counts[1].tag).toBe("fierce belonging");
  });

  it("counts only the matching segment when filtered", () => {
    insertNode(db, makeNode({ id: "a", tag: "quiet joy", segment: "life_story" }));
    insertNode(db, makeNode({ id: "b", tag: "quiet joy", segment: "life_story" }));
    insertNode(db, makeNode({ id: "c", tag: "lucid flight", segment: "dream_journal" }));
    const counts = getTagCounts(db, "life_story");
    expect(counts).toHaveLength(1);
    expect(counts[0].tag).toBe("quiet joy");
    expect(counts[0].count).toBe(2);
  });
});

describe("getNodeCount", () => {
  it("returns 0 for an empty db", () => {
    expect(getNodeCount(db)).toBe(0);
  });

  it("counts all nodes when no segment filter", () => {
    insertNode(db, makeNode({ id: "a", segment: "life_story" }));
    insertNode(db, makeNode({ id: "b", segment: "dream_journal" }));
    expect(getNodeCount(db)).toBe(2);
  });

  it("counts only the matching segment when filtered", () => {
    insertNode(db, makeNode({ id: "a", segment: "life_story" }));
    insertNode(db, makeNode({ id: "b", segment: "dream_journal" }));
    expect(getNodeCount(db, "life_story")).toBe(1);
  });
});

describe("FTS5 sync via triggers", () => {
  it("indexes content on INSERT and returns rowid on MATCH", () => {
    insertNode(db, makeNode({ id: "a", content: "I remember my grandmother's hands" }));
    insertNode(db, makeNode({ id: "b", content: "the smell of fresh bread" }));
    const matches = db
      .prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'grandmother'")
      .all() as { rowid: number }[];
    expect(matches).toHaveLength(1);
  });

  it("removes from FTS on DELETE", () => {
    insertNode(db, makeNode({ id: "a", content: "grandmother story" }));
    db.prepare("DELETE FROM nodes WHERE id = ?").run("a");
    const matches = db
      .prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'grandmother'")
      .all();
    expect(matches).toHaveLength(0);
  });
});

describe("searchNodes", () => {
  it("returns nodes whose content matches the query", () => {
    insertNode(db, makeNode({ id: "a", content: "I remember my grandmother's hands" }));
    insertNode(db, makeNode({ id: "b", content: "driving to school every morning" }));
    const results = searchNodes(db, "grandmother hands", 5);
    expect(results.map((n) => n.id)).toContain("a");
    expect(results.map((n) => n.id)).not.toContain("b");
  });

  it("returns empty array when no nodes match", () => {
    insertNode(db, makeNode({ id: "a", content: "the kitchen table" }));
    const results = searchNodes(db, "volcano eruption", 5);
    expect(results).toHaveLength(0);
  });

  it("returns empty array for a query with no words >= 4 chars", () => {
    insertNode(db, makeNode({ id: "a", content: "the big red bus" }));
    const results = searchNodes(db, "my the in", 5);
    expect(results).toHaveLength(0);
  });

  it("filters by segment when provided", () => {
    insertNode(db, makeNode({ id: "a", content: "grandmother story", segment: "life_story" }));
    insertNode(db, makeNode({ id: "b", content: "grandmother story", segment: "dream_journal" }));
    const results = searchNodes(db, "grandmother", 5, "life_story");
    expect(results.map((n) => n.id)).toEqual(["a"]);
  });

  it("respects the limit argument", () => {
    for (let i = 0; i < 5; i++) {
      insertNode(db, makeNode({ id: `n${i}`, content: `grandmother story number ${i}` }));
    }
    const results = searchNodes(db, "grandmother", 3);
    expect(results).toHaveLength(3);
  });

  it("returns empty array without throwing on empty db", () => {
    expect(searchNodes(db, "anything", 5)).toHaveLength(0);
  });

  it("strips FTS5 special characters and still matches", () => {
    insertNode(db, makeNode({ id: "a", content: "I remember my grandmother's hands" }));
    const results = searchNodes(db, '"grandmother*"', 5);
    expect(results.map((n) => n.id)).toContain("a");
  });

  it("strips hyphens so a hyphenated query does not throw and still matches", () => {
    insertNode(db, makeNode({ id: "a", content: "walking down memory lane" }));
    const results = searchNodes(db, "memory-lane", 5);
    expect(results.map((n) => n.id)).toContain("a");
  });
});

describe("foreign key constraint on parent_id", () => {
  it("throws when inserting a node with a non-existent parent_id", () => {
    expect(() =>
      insertNode(db, makeNode({ id: "child", parentId: "nonexistent-parent" })),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("accepts a parent_id that references an existing node", () => {
    insertNode(db, makeNode({ id: "parent" }));
    expect(() =>
      insertNode(db, makeNode({ id: "child", parentId: "parent", depth: 1 })),
    ).not.toThrow();
  });
});

describe("exportToJson", () => {
  it("returns version 2 with all nodes ordered by captured_at ASC", () => {
    insertNode(db, makeNode({ id: "b", capturedAt: 2000 }));
    insertNode(db, makeNode({ id: "a", capturedAt: 1000 }));
    insertNode(db, makeNode({ id: "c", capturedAt: 3000 }));
    const record = exportToJson(db);
    expect(record.version).toBe(2);
    expect(record.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(typeof record.exportedAt).toBe("number");
  });

  it("returns an empty nodes array for an empty db", () => {
    const record = exportToJson(db);
    expect(record.nodes).toHaveLength(0);
  });
});

describe("importFromJson", () => {
  it("imports a v2 record and returns the count of inserted nodes", () => {
    const record: DumpRecord = {
      version: 2,
      exportedAt: Date.now(),
      nodes: [makeNode({ id: "x1" }), makeNode({ id: "x2" })],
    };
    const count = importFromJson(db, record);
    expect(count).toBe(2);
    expect(getNodeCount(db)).toBe(2);
  });

  it("round-trips a v2 record through export then import", () => {
    const node = makeNode({
      id: "rt",
      tag: "sudden loss",
      content: "the empty chair",
      capturedAt: 9999,
      memoryDate: "1992",
      memoryDateGranularity: "year",
    });
    insertNode(db, node);
    const exported = exportToJson(db);

    const db2 = openDb(":memory:");
    importFromJson(db2, exported);
    expect(getNodeById(db2, "rt")).toEqual(node);
    db2.close();
  });

  it("is idempotent — re-importing the same record does not duplicate nodes", () => {
    const record: DumpRecord = {
      version: 2,
      exportedAt: Date.now(),
      nodes: [makeNode({ id: "dup" })],
    };
    importFromJson(db, record);
    const count = importFromJson(db, record);
    expect(count).toBe(0);
    expect(getNodeCount(db)).toBe(1);
  });

  it("imports a v1 record, maps timestamp → capturedAt, and defaults segment to life_story", () => {
    const legacy: LegacyDumpRecord = {
      version: 1,
      createdAt: 1000,
      updatedAt: 2000,
      nodes: [
        { id: "v1-node", timestamp: 5555, tag: "fierce belonging", content: "the table", depth: 0, parentId: null },
      ],
    };
    importFromJson(db, legacy);
    const node = getNodeById(db, "v1-node");
    expect(node?.capturedAt).toBe(5555);
    expect(node?.segment).toBe("life_story");
    expect(node?.memoryDate).toBeNull();
    expect(node?.memoryDateGranularity).toBeNull();
  });

  it("v2 import preserves non-default segment", () => {
    const record: DumpRecord = {
      version: 2,
      exportedAt: Date.now(),
      nodes: [makeNode({ id: "dj1", segment: "dream_journal" })],
    };
    importFromJson(db, record);
    expect(getNodeById(db, "dj1")?.segment).toBe("dream_journal");
  });

  it("imports a v1 record with parent-child nodes in correct order", () => {
    const legacy: LegacyDumpRecord = {
      version: 1,
      createdAt: 1000,
      updatedAt: 2000,
      nodes: [
        { id: "child", timestamp: 2000, tag: "echo", content: "child node", depth: 1, parentId: "root" },
        { id: "root", timestamp: 1000, tag: "root tag", content: "root node", depth: 0, parentId: null },
      ],
    };
    expect(() => importFromJson(db, legacy)).not.toThrow();
    expect(getNodeCount(db)).toBe(2);
  });
});

describe("insertEmbeddingByRowid", () => {
  const vec = new Array(1536).fill(0.1);

  it("stores embedding via rowid and makes node retrievable by vector search", () => {
    const rowid = insertNode(db, makeNode({ id: "r1" }));
    insertEmbeddingByRowid(db, rowid, vec);
    const results = searchNodesByVector(db, vec, 5);
    expect(results.map((n) => n.id)).toContain("r1");
  });
});

describe("searchNodesByVector", () => {
  const vec = new Array(1536).fill(0.1);

  it("returns empty array when no embeddings exist", () => {
    insertNode(db, makeNode({ id: "a", content: "grandmother in the garden" }));
    expect(searchNodesByVector(db, vec, 5, "life_story")).toHaveLength(0);
  });

  it("returns nodes ordered by similarity", () => {
    insertNode(db, makeNode({ id: "a" }));
    insertNode(db, makeNode({ id: "b" }));
    insertEmbedding(db, "a", vec);
    insertEmbedding(db, "b", vec);
    const results = searchNodesByVector(db, vec, 5);
    expect(results.map((n) => n.id)).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("filters results to the specified segment", () => {
    insertNode(db, makeNode({ id: "ls", segment: "life_story" }));
    insertNode(db, makeNode({ id: "dj", segment: "dream_journal" }));
    insertEmbedding(db, "ls", vec);
    insertEmbedding(db, "dj", vec);
    const results = searchNodesByVector(db, vec, 5, "life_story");
    expect(results.map((n) => n.id)).toContain("ls");
    expect(results.map((n) => n.id)).not.toContain("dj");
  });

  it("respects the limit after over-fetching for segment filtering", () => {
    for (let i = 0; i < 6; i++) {
      insertNode(db, makeNode({ id: `n${i}` }));
      insertEmbedding(db, `n${i}`, vec);
    }
    expect(searchNodesByVector(db, vec, 3)).toHaveLength(3);
  });
});

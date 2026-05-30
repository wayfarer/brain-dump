// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

import type { ExtractedNode } from "./backends/types.js";
import {
  buildSystemPrompt,
  buildOpeningMessage,
  persistNodes,
  SEGMENTS,
  type InterviewState,
} from "./interview.js";
import {
  type Db,
  getNodeById,
  getRecentNodes,
  insertNode,
  openDb,
} from "./store.js";
import type { DumpNode } from "./types.js";

function makeMockEmbedding(): number[] {
  return new Array(1536).fill(0);
}

function makeMockOpenAI() {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [
          { embedding: makeMockEmbedding(), index: 0, object: "embedding" },
        ],
        model: "text-embedding-3-small",
        object: "list",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
    },
  } as unknown as OpenAI;
}

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

function extracted(overrides: Partial<ExtractedNode> = {}): ExtractedNode {
  return {
    tag: "sudden loss",
    content: "I saw the dog",
    parentId: "",
    ...overrides,
  };
}

let db: Db;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function makeState(): InterviewState {
  return { db, lastParentId: null, segment: "life_story" };
}

// --- buildSystemPrompt ---

describe("buildSystemPrompt", () => {
  it("returns base prompt when db is empty", async () => {
    const prompt = await buildSystemPrompt(db, makeMockOpenAI(), "life_story");
    expect(prompt).toContain("warm, patient interviewer");
    expect(prompt).not.toContain("Context from previous sessions");
  });

  it("does not leak any extraction-mechanism wording (lives in backend tails now)", async () => {
    const prompt = await buildSystemPrompt(db, null, "life_story");
    expect(prompt).not.toContain("extract_memory_node");
  });

  it("includes context block with last 10 nodes when db has 11 nodes", async () => {
    for (let i = 0; i < 11; i++) {
      insertNode(db, makeNode({ id: `n${i}`, tag: `tag-${i}`, capturedAt: i }));
    }
    const prompt = await buildSystemPrompt(db, makeMockOpenAI(), "life_story");
    expect(prompt).toContain("tag-10");
    expect(prompt).not.toContain("tag-0");
    expect((prompt.match(/depth \d/g) ?? []).length).toBe(10);
  });

  it("prioritises search-matched nodes when recentInput is provided", async () => {
    const openai = makeMockOpenAI();
    insertNode(
      db,
      makeNode({
        id: "old",
        tag: "distant memory",
        content: "grandmother in the garden",
        capturedAt: 1,
      }),
    );
    for (let i = 0; i < 10; i++) {
      insertNode(
        db,
        makeNode({
          id: `new${i}`,
          tag: `recent-${i}`,
          content: "daily routine stuff",
          capturedAt: 1000 + i,
        }),
      );
    }
    expect(await buildSystemPrompt(db, openai, "life_story")).not.toContain(
      "distant memory",
    );
    expect(
      await buildSystemPrompt(
        db,
        openai,
        "life_story",
        "I was with my grandmother",
      ),
    ).toContain("distant memory");
  });

  it("works with a null client (no embeddings) — degrades to FTS5", async () => {
    insertNode(
      db,
      makeNode({
        id: "old",
        tag: "distant memory",
        content: "grandmother in the garden",
        capturedAt: 1,
      }),
    );
    const prompt = await buildSystemPrompt(
      db,
      null,
      "life_story",
      "grandmother",
    );
    expect(prompt).toContain("distant memory");
  });

  it("uses pre-computed recentEmbedding and does not call embeddings.create", async () => {
    const openai = makeMockOpenAI();
    insertNode(db, makeNode({ id: "e1", tag: "quiet joy" }));
    const prompt = await buildSystemPrompt(
      db,
      openai,
      "life_story",
      "some input",
      makeMockEmbedding(),
    );
    expect(prompt).toContain("Context from previous sessions");
    expect(openai.embeddings.create).not.toHaveBeenCalled();
  });
});

// --- buildOpeningMessage ---

describe("buildOpeningMessage", () => {
  it("returns first-session prompt when db is empty", () => {
    expect(buildOpeningMessage(db, "life_story")).toBe(
      "What is your first memory?",
    );
  });

  it("returns returning-user prompt when nodes exist", () => {
    insertNode(db, makeNode({ id: "a1", tag: "wonder" }));
    expect(buildOpeningMessage(db, "life_story")).toBe(
      "Welcome back. Where would you like to go today?",
    );
  });

  it("uses segment-specific questions for dream_journal", () => {
    expect(buildOpeningMessage(db, "dream_journal")).toBe(
      SEGMENTS.dream_journal.openingQuestion,
    );
    insertNode(
      db,
      makeNode({ id: "d1", tag: "dream vision", segment: "dream_journal" }),
    );
    expect(buildOpeningMessage(db, "dream_journal")).toBe(
      SEGMENTS.dream_journal.returnGreeting,
    );
  });
});

// --- persistNodes ---

describe("persistNodes", () => {
  it("persists a node with the full schema", () => {
    const state = makeState();
    persistNodes(db, state, [extracted()], null);
    const stored = getRecentNodes(db, 1)[0];
    expect(stored.tag).toBe("sudden loss");
    expect(stored.content).toBe("I saw the dog");
    expect(stored.parentId).toBeNull();
    expect(stored.depth).toBe(0);
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.segment).toBe("life_story");
    expect(stored.memoryDate).toBeNull();
    expect(stored.memoryDateGranularity).toBeNull();
    expect(state.lastParentId).toBe(stored.id);
  });

  it("stores memoryDate and a valid granularity", () => {
    persistNodes(
      db,
      makeState(),
      [extracted({ memoryDate: "1994", memoryDateGranularity: "year" })],
      null,
    );
    const stored = getRecentNodes(db, 1)[0];
    expect(stored.memoryDate).toBe("1994");
    expect(stored.memoryDateGranularity).toBe("year");
  });

  it("nulls an invalid granularity but keeps the date", () => {
    persistNodes(
      db,
      makeState(),
      [
        extracted({
          memoryDate: "1990s",
          memoryDateGranularity: "invalid_value",
        }),
      ],
      null,
    );
    const stored = getRecentNodes(db, 1)[0];
    expect(stored.memoryDate).toBe("1990s");
    expect(stored.memoryDateGranularity).toBeNull();
  });

  it("computes child depth from a resolved parent", () => {
    insertNode(db, makeNode({ id: "parent-id", tag: "quiet shame", depth: 0 }));
    persistNodes(
      db,
      makeState(),
      [extracted({ tag: "fear", content: "dark room", parentId: "parent-id" })],
      null,
    );
    const child = getRecentNodes(db, 1)[0];
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe("parent-id");
    expect(getNodeById(db, "parent-id")?.depth).toBe(0);
  });

  it("attaches an empty parent id to state.lastParentId when available", () => {
    insertNode(db, makeNode({ id: "last-id", tag: "quiet shame", depth: 0 }));
    const state: InterviewState = {
      db,
      lastParentId: "last-id",
      segment: "life_story",
    };
    persistNodes(
      db,
      state,
      [
        extracted({
          tag: "follow-up",
          content: "the next detail",
          parentId: "",
        }),
      ],
      null,
    );
    const child = getRecentNodes(db, 1)[0];
    expect(child.parentId).toBe("last-id");
    expect(child.depth).toBe(1);
  });

  it("falls back to state.lastParentId when an extracted parent id is invalid", () => {
    insertNode(db, makeNode({ id: "last-id", tag: "quiet shame", depth: 2 }));
    const state: InterviewState = {
      db,
      lastParentId: "last-id",
      segment: "life_story",
    };
    persistNodes(db, state, [extracted({ parentId: "missing-id" })], null);
    const child = getRecentNodes(db, 1)[0];
    expect(child.parentId).toBe("last-id");
    expect(child.depth).toBe(3);
  });

  it("persists multiple nodes and points lastParentId at the last", () => {
    const state = makeState();
    persistNodes(
      db,
      state,
      [
        extracted({ tag: "a", content: "first" }),
        extracted({ tag: "b", content: "second" }),
      ],
      null,
    );
    const recent = getRecentNodes(db, 2);
    expect(recent).toHaveLength(2);
    expect(state.lastParentId).toBe(recent[0].id); // most recent first
  });

  it("stores an embedding when one is provided", () => {
    expect(() =>
      persistNodes(db, makeState(), [extracted()], makeMockEmbedding()),
    ).not.toThrow();
    expect(getRecentNodes(db, 1)).toHaveLength(1);
  });
});

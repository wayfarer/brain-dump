// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

import type { ChatSession } from "./backends/index.js";
import type { ExtractedNode } from "./backends/types.js";
import {
  buildSystemPrompt,
  buildOpeningMessage,
  formatContextBlock,
  formatContextEntry,
  persistNodes,
  runTurn,
  SEGMENTS,
  truncateText,
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
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = openDb(":memory:");
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  db.close();
});

function makeState(): InterviewState {
  return { db, lastParentId: null, segment: "life_story" };
}

// --- context formatting helpers ---

describe("truncateText", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateText("short", 10)).toBe("short");
  });

  it("appends ellipsis when over limit", () => {
    expect(truncateText("abcdefghij", 7)).toBe("abcd...");
  });
});

describe("formatContextEntry", () => {
  it("formats tag, depth, and content", () => {
    const line = formatContextEntry(makeNode(), 240);
    expect(line).toBe('- depth 0 | "quiet joy" | the kitchen table');
  });

  it("includes memory date and granularity when present", () => {
    const line = formatContextEntry(
      makeNode({ memoryDate: "1987", memoryDateGranularity: "year" }),
      240,
    );
    expect(line).toContain("1987 (year)");
  });

  it("truncates long content", () => {
    const long = "x".repeat(300);
    const line = formatContextEntry(makeNode({ content: long }), 50);
    expect(line.endsWith("...")).toBe(true);
    expect(line.length).toBeLessThan(long.length + 30);
  });
});

describe("formatContextBlock", () => {
  it("joins multiple entries", () => {
    const block = formatContextBlock([
      makeNode({ tag: "a", content: "one" }),
      makeNode({ tag: "b", content: "two" }),
    ]);
    expect(block.split("\n")).toHaveLength(2);
  });

  it("shrinks content when section exceeds maxSectionChars", () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({
        tag: `tag-${i}`,
        content: "word ".repeat(80),
      }),
    );
    const block = formatContextBlock(nodes, {
      maxContentCharsPerNode: 240,
      maxSectionChars: 500,
    });
    expect(block.length).toBeLessThanOrEqual(500);
  });
});

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
      insertNode(
        db,
        makeNode({
          id: `n${i}`,
          tag: `tag-${i}`,
          content: `content-${i}`,
          capturedAt: i,
        }),
      );
    }
    const prompt = await buildSystemPrompt(db, makeMockOpenAI(), "life_story");
    expect(prompt).toContain("tag-10");
    expect(prompt).toContain("content-10");
    expect(prompt).not.toContain("tag-0");
    expect(prompt).not.toContain("content-0");
    expect((prompt.match(/depth \d/g) ?? []).length).toBe(10);
  });

  it("includes memory date in context when present", async () => {
    insertNode(
      db,
      makeNode({
        memoryDate: "1987",
        memoryDateGranularity: "year",
      }),
    );
    const prompt = await buildSystemPrompt(db, makeMockOpenAI(), "life_story");
    expect(prompt).toContain("1987 (year)");
    expect(prompt).toContain("the kitchen table");
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
    const withInput = await buildSystemPrompt(
      db,
      openai,
      "life_story",
      "I was with my grandmother",
    );
    expect(withInput).toContain("distant memory");
    expect(withInput).toContain("grandmother in the garden");
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
    expect(prompt).toContain("grandmother in the garden");
  });

  it("uses updated context instruction wording", async () => {
    insertNode(db, makeNode());
    const prompt = await buildSystemPrompt(db, makeMockOpenAI(), "life_story");
    expect(prompt).toContain(
      "do not quote or enumerate this list back to the user",
    );
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

// --- runTurn presentation bridge ---

describe("runTurn", () => {
  it("bridges backend text events to the presenter", async () => {
    const onFirstToken = vi.fn();
    const onContent = vi.fn();
    const session = {
      turn: vi.fn(async (_userInput: string, _systemPrompt: string, events) => {
        events?.onFirstText?.();
        events?.onText?.("Tell me more.");
        return { question: "Tell me more.", nodes: [] };
      }),
    } as unknown as ChatSession;

    await runTurn(session, null, makeState(), "hello", {
      onFirstToken,
      onContent,
    });

    expect(onFirstToken).toHaveBeenCalledTimes(1);
    expect(onContent).toHaveBeenCalledWith("Tell me more.");
    expect(stdoutSpy).toHaveBeenCalledWith("\n");
  });

  it("writes backend text to stdout when no content presenter is provided", async () => {
    const session = {
      turn: vi.fn(async (_userInput: string, _systemPrompt: string, events) => {
        events?.onText?.("Tell me more.");
        return { question: "Tell me more.", nodes: [] };
      }),
    } as unknown as ChatSession;

    await runTurn(session, null, makeState(), "hello");

    expect(stdoutSpy).toHaveBeenCalledWith("Tell me more.");
    expect(stdoutSpy).toHaveBeenCalledWith("\n");
  });
});

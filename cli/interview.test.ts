// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

import {
  buildSystemPrompt,
  buildOpeningMessage,
  runTurn,
  type InterviewState,
} from "./interview.js";
import {
  type Db,
  getNodeById,
  getNodeCount,
  getRecentNodes,
  insertNode,
  openDb,
} from "./store.js";
import type { DumpNode } from "./types.js";

// --- stream helpers ---

type Chunk = OpenAI.Chat.ChatCompletionChunk;

function makeStream(chunks: Chunk[]): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

function contentChunk(text: string): Chunk {
  return {
    id: "x",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }],
  };
}

function toolCallChunk(index: number, id: string, name: string, args: string): Chunk {
  return {
    id: "x",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: args } }],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

function makeMockClient(chunks: Chunk[]) {
  const mockCreate = vi.fn().mockResolvedValue(makeStream(chunks));
  return {
    client: { chat: { completions: { create: mockCreate } } } as unknown as OpenAI,
    mockCreate,
  };
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
  return { history: [], db, lastParentId: null };
}

// --- buildSystemPrompt ---

describe("buildSystemPrompt", () => {
  it("returns base prompt when db is empty", () => {
    const prompt = buildSystemPrompt(db);
    expect(prompt).toContain("warm, patient interviewer");
    expect(prompt).not.toContain("Context from previous sessions");
  });

  it("includes context block with last 10 nodes when db has 11 nodes", () => {
    for (let i = 0; i < 11; i++) {
      insertNode(db, makeNode({ id: `n${i}`, tag: `tag-${i}`, capturedAt: i }));
    }
    const prompt = buildSystemPrompt(db);
    expect(prompt).toContain("tag-10");
    expect(prompt).not.toContain("tag-0");
    const matches = prompt.match(/depth \d/g) ?? [];
    expect(matches).toHaveLength(10);
  });

  it("prioritises FTS-matched nodes when recentInput is provided", () => {
    insertNode(db, makeNode({ id: "old", tag: "distant memory", content: "grandmother in the garden", capturedAt: 1 }));
    for (let i = 0; i < 10; i++) {
      insertNode(db, makeNode({ id: `new${i}`, tag: `recent-${i}`, content: "daily routine stuff", capturedAt: 1000 + i }));
    }
    // Without recentInput, "distant memory" is too old to appear in last 10
    const promptWithout = buildSystemPrompt(db);
    expect(promptWithout).not.toContain("distant memory");
    // With recentInput matching "grandmother", it surfaces
    const promptWith = buildSystemPrompt(db, "I was with my grandmother");
    expect(promptWith).toContain("distant memory");
  });
});

// --- buildOpeningMessage ---

describe("buildOpeningMessage", () => {
  it("returns first-session prompt when db is empty", () => {
    expect(buildOpeningMessage(db)).toBe("What is your first memory?");
  });

  it("returns returning-user prompt when nodes exist", () => {
    insertNode(db, makeNode({ id: "a1", tag: "wonder" }));
    expect(buildOpeningMessage(db)).toBe("Welcome back. Where would you like to go today?");
  });
});

// --- runTurn ---

describe("runTurn", () => {
  it("content-only stream: appends history but persists nothing", async () => {
    const { client } = makeMockClient([contentChunk("Hello "), contentChunk("world")]);
    const state = makeState();
    await runTurn(client, state, "hi there");

    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toEqual({ role: "user", content: "hi there" });
    const assistant = state.history[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.content).toBe("Hello world");
    expect(assistant.tool_calls).toBeUndefined();
    expect(getNodeCount(db)).toBe(0);
  });

  it("single tool-call: persists node with full schema", async () => {
    const args = JSON.stringify({ tag: "sudden loss", content: "I saw the dog", parentId: "" });
    const { client } = makeMockClient([toolCallChunk(0, "call_001", "extract_memory_node", args)]);
    const state = makeState();
    await runTurn(client, state, "tell me more");

    expect(getNodeCount(db)).toBe(1);
    const stored = getRecentNodes(db, 1)[0];
    expect(stored.tag).toBe("sudden loss");
    expect(stored.content).toBe("I saw the dog");
    expect(stored.parentId).toBeNull();
    expect(stored.depth).toBe(0);
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.segment).toBe("life_story");
    expect(stored.memoryDate).toBeNull();
    expect(stored.memoryDateGranularity).toBeNull();
    expect(typeof stored.capturedAt).toBe("number");

    const toolMsg = state.history.find(
      (m) => m.role === "tool",
    ) as OpenAI.Chat.ChatCompletionToolMessageParam | undefined;
    expect(toolMsg?.content).toBe("ok");
    expect(state.lastParentId).toBe(stored.id);
  });

  it("tool-call with date fields: persists memoryDate and memoryDateGranularity", async () => {
    const args = JSON.stringify({
      tag: "summer freedom",
      content: "riding bikes until dark",
      parentId: "",
      memoryDate: "1994",
      memoryDateGranularity: "year",
    });
    const { client } = makeMockClient([toolCallChunk(0, "call_date", "extract_memory_node", args)]);
    const state = makeState();
    await runTurn(client, state, "what did you do that summer");

    const stored = getRecentNodes(db, 1)[0];
    expect(stored.memoryDate).toBe("1994");
    expect(stored.memoryDateGranularity).toBe("year");
  });

  it("tool-call with invalid granularity: stores null for memoryDateGranularity", async () => {
    const args = JSON.stringify({
      tag: "wonder and curiosity",
      content: "the attic boxes",
      parentId: "",
      memoryDate: "1990s",
      memoryDateGranularity: "invalid_value",
    });
    const { client } = makeMockClient([toolCallChunk(0, "call_badgran", "extract_memory_node", args)]);
    const state = makeState();
    await runTurn(client, state, "tell me about that");

    const stored = getRecentNodes(db, 1)[0];
    expect(stored.memoryDate).toBe("1990s");
    expect(stored.memoryDateGranularity).toBeNull();
  });

  it("multi-chunk argument assembly: assembles into a single persisted node", async () => {
    const { client } = makeMockClient([
      toolCallChunk(0, "call_002", "extract_memory_node", '{"tag":"'),
      toolCallChunk(0, "", "", 'sudden joy","content":"'),
      toolCallChunk(0, "", "", 'birthday cake","parentId":""}'),
    ]);
    const state = makeState();
    await runTurn(client, state, "what happened");

    expect(getNodeCount(db)).toBe(1);
    const stored = getRecentNodes(db, 1)[0];
    expect(stored.tag).toBe("sudden joy");
    expect(stored.content).toBe("birthday cake");
  });

  it("depth computation: child node gets parent depth + 1", async () => {
    insertNode(
      db,
      makeNode({ id: "parent-id", tag: "quiet shame", content: "the hallway", depth: 0 }),
    );
    const args = JSON.stringify({ tag: "fear", content: "dark room", parentId: "parent-id" });
    const { client } = makeMockClient([toolCallChunk(0, "call_003", "extract_memory_node", args)]);
    const state = makeState();
    await runTurn(client, state, "go on");

    const child = getRecentNodes(db, 1)[0];
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe("parent-id");

    const parent = getNodeById(db, "parent-id");
    expect(parent?.depth).toBe(0);
  });

  it("invalid JSON arguments: adds error tool message, persists nothing", async () => {
    const { client } = makeMockClient([
      toolCallChunk(0, "call_004", "extract_memory_node", "not-json{{{"),
    ]);
    const state = makeState();
    await runTurn(client, state, "something");

    expect(getNodeCount(db)).toBe(0);
    const toolMsg = state.history.find(
      (m) => m.role === "tool",
    ) as OpenAI.Chat.ChatCompletionToolMessageParam | undefined;
    expect(toolMsg?.content).toBe("error: invalid json");
  });

  it("content + tool call: assistant entry has both content and tool_calls", async () => {
    const args = JSON.stringify({ tag: "wonder", content: "the night sky", parentId: "" });
    const { client } = makeMockClient([
      contentChunk("Tell me more."),
      toolCallChunk(0, "call_005", "extract_memory_node", args),
    ]);
    const state = makeState();
    await runTurn(client, state, "it was beautiful");

    const assistant = state.history.find(
      (m) => m.role === "assistant",
    ) as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.content).toBe("Tell me more.");
    expect(assistant.tool_calls).toHaveLength(1);
    expect(getNodeCount(db)).toBe(1);
  });
});

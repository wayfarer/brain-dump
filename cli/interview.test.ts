// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return { ...actual, saveRecord: vi.fn() };
});

import { saveRecord } from "./store.js";
import {
  buildSystemPrompt,
  buildOpeningMessage,
  runTurn,
  type InterviewState,
} from "./interview.js";
import { createFreshRecord } from "./store.js";
import type { DumpRecord } from "./types.js";

const mockedSaveRecord = vi.mocked(saveRecord);

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

// --- mock client factory ---

function makeMockClient(chunks: Chunk[]) {
  const mockCreate = vi.fn().mockResolvedValue(makeStream(chunks));
  return {
    client: { chat: { completions: { create: mockCreate } } } as unknown as OpenAI,
    mockCreate,
  };
}

function makeState(record?: DumpRecord): InterviewState {
  return {
    history: [],
    record: record ?? createFreshRecord(),
    lastParentId: null,
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

// --- buildSystemPrompt ---

describe("buildSystemPrompt", () => {
  it("contains base prompt text for an empty record", () => {
    const record = createFreshRecord();
    const prompt = buildSystemPrompt(record);
    expect(prompt).toContain("warm, patient interviewer");
  });

  it("includes context block with last 10 nodes when record has 11 nodes", () => {
    const record = createFreshRecord();
    for (let i = 0; i < 11; i++) {
      record.nodes.push({
        id: `n${i}`,
        timestamp: i,
        tag: `tag-${i}`,
        content: "c",
        depth: 0,
        parentId: null,
      });
    }
    const prompt = buildSystemPrompt(record);
    expect(prompt).toContain("tag-10");    // last node present
    expect(prompt).not.toContain("tag-0"); // first node excluded
    const matches = prompt.match(/depth \d/g) ?? [];
    expect(matches).toHaveLength(10);
  });
});

// --- buildOpeningMessage ---

describe("buildOpeningMessage", () => {
  it("returns first-session prompt for an empty record", () => {
    expect(buildOpeningMessage(createFreshRecord())).toBe("What is your first memory?");
  });

  it("returns returning-user prompt when nodes exist", () => {
    const record = createFreshRecord();
    record.nodes.push({
      id: "a1",
      timestamp: 1,
      tag: "wonder",
      content: "the stars",
      depth: 0,
      parentId: null,
    });
    expect(buildOpeningMessage(record)).toBe("Welcome back. Where would you like to go today?");
  });
});

// --- runTurn ---

describe("runTurn", () => {
  it("content-only stream: appends user + assistant messages, no nodes saved", async () => {
    const { client } = makeMockClient([contentChunk("Hello "), contentChunk("world")]);
    const state = makeState();
    await runTurn(client, state, "hi there");

    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toEqual({ role: "user", content: "hi there" });
    const assistant = state.history[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Hello world");
    expect(assistant.tool_calls).toBeUndefined();
    expect(state.record.nodes).toHaveLength(0);
    expect(mockedSaveRecord).not.toHaveBeenCalled();
  });

  it("single tool-call: creates node with correct fields and saves record", async () => {
    const args = JSON.stringify({ tag: "sudden loss", content: "I saw the dog", parentId: "" });
    const { client } = makeMockClient([toolCallChunk(0, "call_001", "extract_memory_node", args)]);
    const state = makeState();
    await runTurn(client, state, "tell me more");

    expect(state.record.nodes).toHaveLength(1);
    const node = state.record.nodes[0];
    expect(node.tag).toBe("sudden loss");
    expect(node.content).toBe("I saw the dog");
    expect(node.parentId).toBeNull();
    expect(node.depth).toBe(0);
    expect(node.id).toMatch(/^[0-9a-f-]{36}$/);

    const toolMsg = state.history.find(
      (m) => m.role === "tool",
    ) as OpenAI.Chat.ChatCompletionToolMessageParam | undefined;
    expect(toolMsg?.content).toBe("ok");
    expect(mockedSaveRecord).toHaveBeenCalledOnce();
    expect(state.lastParentId).toBe(node.id);
  });

  it("multi-chunk argument assembly: assembles split arguments into valid node", async () => {
    const { client } = makeMockClient([
      toolCallChunk(0, "call_002", "extract_memory_node", '{"tag":"'),
      toolCallChunk(0, "", "", 'sudden joy","content":"'),
      toolCallChunk(0, "", "", 'birthday cake","parentId":""}'),
    ]);
    const state = makeState();
    await runTurn(client, state, "what happened");

    expect(state.record.nodes).toHaveLength(1);
    expect(state.record.nodes[0].tag).toBe("sudden joy");
    expect(state.record.nodes[0].content).toBe("birthday cake");
  });

  it("depth computation: child node gets parent depth + 1", async () => {
    const record = createFreshRecord();
    record.nodes.push({
      id: "parent-id",
      timestamp: 1,
      tag: "quiet shame",
      content: "the hallway",
      depth: 0,
      parentId: null,
    });
    const args = JSON.stringify({ tag: "fear", content: "dark room", parentId: "parent-id" });
    const { client } = makeMockClient([toolCallChunk(0, "call_003", "extract_memory_node", args)]);
    const state = makeState(record);
    await runTurn(client, state, "go on");

    const newNode = state.record.nodes[1];
    expect(newNode.depth).toBe(1);
    expect(newNode.parentId).toBe("parent-id");
  });

  it("invalid JSON arguments: adds error tool message, no node created", async () => {
    const { client } = makeMockClient([
      toolCallChunk(0, "call_004", "extract_memory_node", "not-json{{{"),
    ]);
    const state = makeState();
    await runTurn(client, state, "something");

    expect(state.record.nodes).toHaveLength(0);
    const toolMsg = state.history.find(
      (m) => m.role === "tool",
    ) as OpenAI.Chat.ChatCompletionToolMessageParam | undefined;
    expect(toolMsg?.content).toBe("error: invalid json");
    expect(mockedSaveRecord).not.toHaveBeenCalled();
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
    expect(state.record.nodes).toHaveLength(1);
  });
});

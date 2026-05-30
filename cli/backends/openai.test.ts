// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

import { OpenAIBackend } from "./openai.js";
import type { RunTurnInput } from "./types.js";

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
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

function toolCallChunk(
  index: number,
  id: string,
  name: string,
  args: string,
): Chunk {
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

function makeBackend(chunks: Chunk[]) {
  const create = vi.fn().mockResolvedValue(makeStream(chunks));
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { backend: new OpenAIBackend(client), create };
}

function input(overrides: Partial<RunTurnInput> = {}): RunTurnInput {
  return {
    userInput: "hi there",
    systemPrompt: "PROMPT",
    transcript: [],
    ...overrides,
  };
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => stdoutSpy.mockRestore());

describe("OpenAIBackend.runTurn", () => {
  it("content-only stream: returns the question, no nodes", async () => {
    const { backend } = makeBackend([
      contentChunk("Hello "),
      contentChunk("world"),
    ]);
    const result = await backend.runTurn(input());
    expect(result.question).toBe("Hello world");
    expect(result.nodes).toEqual([]);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("emits streamed text chunks through events", async () => {
    const onFirstText = vi.fn();
    const onText = vi.fn();
    const { backend } = makeBackend([
      contentChunk("Hello "),
      contentChunk("world"),
    ]);
    const result = await backend.runTurn(
      input({ events: { onFirstText, onText } }),
    );
    expect(result.question).toBe("Hello world");
    expect(onFirstText).toHaveBeenCalledTimes(1);
    expect(onText.mock.calls.map((call) => call[0])).toEqual([
      "Hello ",
      "world",
    ]);
  });

  it("single tool call becomes one ExtractedNode", async () => {
    const args = JSON.stringify({
      tag: "sudden loss",
      content: "I saw the dog",
      parentId: "",
    });
    const { backend } = makeBackend([
      toolCallChunk(0, "c1", "extract_memory_node", args),
    ]);
    const result = await backend.runTurn(input());
    expect(result.nodes).toEqual([
      {
        tag: "sudden loss",
        content: "I saw the dog",
        parentId: "",
        memoryDate: undefined,
        memoryDateGranularity: undefined,
      },
    ]);
  });

  it("assembles tool-call arguments across chunks", async () => {
    const { backend } = makeBackend([
      toolCallChunk(0, "c2", "extract_memory_node", '{"tag":"'),
      toolCallChunk(0, "", "", 'sudden joy","content":"'),
      toolCallChunk(0, "", "", 'birthday cake","parentId":""}'),
    ]);
    const result = await backend.runTurn(input());
    expect(result.nodes[0].tag).toBe("sudden joy");
    expect(result.nodes[0].content).toBe("birthday cake");
  });

  it("skips malformed tool-call JSON", async () => {
    const onFirstText = vi.fn();
    const onText = vi.fn();
    const { backend } = makeBackend([
      toolCallChunk(0, "c3", "extract_memory_node", "not-json{{{"),
    ]);
    const result = await backend.runTurn(
      input({ events: { onFirstText, onText } }),
    );
    expect(result.nodes).toEqual([]);
    expect(onFirstText).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it("surfaces two simultaneous tool calls", async () => {
    const a = JSON.stringify({
      tag: "quiet joy",
      content: "morning light",
      parentId: "",
    });
    const b = JSON.stringify({
      tag: "sudden loss",
      content: "empty chair",
      parentId: "",
    });
    const { backend } = makeBackend([
      toolCallChunk(0, "ca", "extract_memory_node", a),
      toolCallChunk(1, "cb", "extract_memory_node", b),
    ]);
    const result = await backend.runTurn(input());
    expect(result.nodes).toHaveLength(2);
  });

  it("returns both content and a node together", async () => {
    const args = JSON.stringify({
      tag: "wonder",
      content: "the night sky",
      parentId: "",
    });
    const { backend } = makeBackend([
      contentChunk("Tell me more."),
      toolCallChunk(0, "c5", "extract_memory_node", args),
    ]);
    const result = await backend.runTurn(input());
    expect(result.question).toBe("Tell me more.");
    expect(result.nodes).toHaveLength(1);
  });

  it("sends the system tail + transcript + current user message", async () => {
    const { backend, create } = makeBackend([contentChunk("ok")]);
    await backend.runTurn(
      input({
        transcript: [
          { role: "user", text: "u1" },
          { role: "assistant", text: "a1" },
        ],
      }),
    );
    const messages = create.mock.calls[0][0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("extract_memory_node");
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "hi there" },
    ]);
  });
});

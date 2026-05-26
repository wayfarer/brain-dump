// @vitest-environment node
import "dotenv/config";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import OpenAI from "openai";
import type { ChatCompletionToolMessageParam } from "openai/resources/chat/completions.js";

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return { ...actual, saveRecord: vi.fn() };
});

import { runTurn, type InterviewState } from "./interview.js";
import { createFreshRecord } from "./store.js";

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
});

describe.skipIf(!process.env.OPENAI_API_KEY)("live runTurn", () => {
  it(
    "extracts a memory node from a first-person memory statement",
    async () => {
      const client = new OpenAI();
      const record = createFreshRecord();
      const state: InterviewState = { history: [], record, lastParentId: null };

      await runTurn(
        client,
        state,
        "I remember standing at my grandmother's grave for the first time. I was seven and it was raining.",
      );

      expect(state.record.nodes.length).toBeGreaterThan(0);
      const node = state.record.nodes[0];
      expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(node.tag).toBeTruthy();
      expect(node.content).toBeTruthy();
      expect(node.depth).toBe(0);
      expect(node.parentId).toBeNull();

      const toolOk = state.history.some(
        (m) => m.role === "tool" && (m as ChatCompletionToolMessageParam).content === "ok",
      );
      expect(toolOk).toBe(true);
    },
    30_000,
  );
});

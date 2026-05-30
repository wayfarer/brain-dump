// @vitest-environment node
import "dotenv/config";
import { spawnSync } from "node:child_process";

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import OpenAI from "openai";

import { ChatSession } from "./backends/index.js";
import { CodexBackend } from "./backends/codex.js";
import { OpenAIBackend } from "./backends/openai.js";
import { runTurn, type InterviewState } from "./interview.js";
import { type Db, getNodeCount, getRecentNodes, openDb } from "./store.js";

function codexLoggedIn(): boolean {
  const r = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  if (r.error) return false; // codex not installed
  return /logged in/i.test((r.stdout ?? "") + (r.stderr ?? ""));
}

const MEMORY = "I remember standing at my grandmother's grave for the first time. I was seven and it was raining.";

function expectRootNode(db: Db): void {
  expect(getNodeCount(db)).toBeGreaterThan(0);
  const node = getRecentNodes(db, 1)[0];
  expect(node.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(node.tag).toBeTruthy();
  expect(node.content).toBeTruthy();
  expect(node.depth).toBe(0);
  expect(node.parentId).toBeNull();
  expect(node.segment).toBe("life_story");
  expect(typeof node.capturedAt).toBe("number");
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

describe.skipIf(!process.env.OPENAI_API_KEY)("live runTurn — OpenAI backend", () => {
  it(
    "extracts a memory node from a first-person memory statement",
    async () => {
      const client = new OpenAI();
      const session = new ChatSession(new OpenAIBackend(client), null);
      const state: InterviewState = { db, lastParentId: null, segment: "life_story" };
      await runTurn(session, client, state, MEMORY);
      session.close();
      expectRootNode(db);
    },
    30_000,
  );
});

describe.skipIf(!codexLoggedIn())("live runTurn — Codex backend (subscription)", () => {
  it(
    "extracts a memory node via the codex app-server",
    async () => {
      const session = new ChatSession(CodexBackend.create(), null);
      const state: InterviewState = { db, lastParentId: null, segment: "life_story" };
      try {
        await runTurn(session, null, state, MEMORY);
      } finally {
        session.close();
      }
      expectRootNode(db);
    },
    45_000,
  );
});

// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { ChatSession, createSession, detectCodexLogin } from "./index.js";
import {
  type ChatBackend,
  type RunTurnInput,
  type TurnResult,
  UsageLimitExceededError,
} from "./types.js";

class FakeBackend implements ChatBackend {
  calls: RunTurnInput[] = [];
  closed = false;
  constructor(
    readonly name: "codex" | "openai",
    private behavior: (input: RunTurnInput) => TurnResult,
  ) {}
  runTurn(input: RunTurnInput): Promise<TurnResult> {
    this.calls.push(input);
    return Promise.resolve(this.behavior(input));
  }
  close(): void {
    this.closed = true;
  }
}

const reply = (q: string): TurnResult => ({ question: q, nodes: [] });

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe("ChatSession", () => {
  it("uses the primary while it works, without switching", async () => {
    const primary = new FakeBackend("codex", () => reply("from codex"));
    const fallback = new FakeBackend("openai", () => reply("from openai"));
    const session = new ChatSession(primary, fallback);

    const r = await session.turn("hello", "P");
    expect(r.question).toBe("from codex");
    expect(session.activeName).toBe("codex");
    expect(fallback.calls).toHaveLength(0);
  });

  it("latches to the fallback on usage-limit, printing a notice once", async () => {
    const primary = new FakeBackend("codex", () => {
      throw new UsageLimitExceededError();
    });
    const fallback = new FakeBackend("openai", () => reply("from openai"));
    const session = new ChatSession(primary, fallback);

    const r1 = await session.turn("one", "P");
    expect(r1.question).toBe("from openai");
    expect(session.activeName).toBe("openai");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain(
      "Subscription limit reached",
    );

    // Second turn goes straight to fallback — primary not called again, no second notice.
    await session.turn("two", "P");
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(2);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("carries the transcript across the switch so the fallback has context", async () => {
    let seen: readonly { role: string; text: string }[] = [];
    const primary = new FakeBackend("codex", () => reply("q1"));
    const fallback = new FakeBackend("openai", (input) => {
      seen = input.transcript;
      return reply("q2");
    });
    const session = new ChatSession(primary, fallback);

    await session.turn("u1", "P"); // codex answers q1
    primary.runTurn = () => {
      throw new UsageLimitExceededError();
    };
    await session.turn("u2", "P"); // codex limits → fallback sees prior turn

    expect(seen).toEqual([
      { role: "user", text: "u1" },
      { role: "assistant", text: "q1" },
    ]);
  });

  it("passes turn events through to the active backend", async () => {
    const onText = vi.fn();
    const primary = new FakeBackend("codex", (input) => {
      input.events?.onText?.("hello");
      return reply("hello");
    });
    const session = new ChatSession(primary, null);
    await session.turn("u1", "P", { onText });
    expect(onText).toHaveBeenCalledWith("hello");
  });

  it("reuses turn events when falling back", async () => {
    const onText = vi.fn();
    const primary = new FakeBackend("codex", () => {
      throw new UsageLimitExceededError();
    });
    const fallback = new FakeBackend("openai", (input) => {
      input.events?.onText?.("fallback");
      return reply("fallback");
    });
    const session = new ChatSession(primary, fallback);
    await session.turn("u1", "P", { onText });
    expect(onText).toHaveBeenCalledWith("fallback");
  });

  it("throws a helpful error on usage-limit when there is no fallback", async () => {
    const primary = new FakeBackend("codex", () => {
      throw new UsageLimitExceededError();
    });
    const session = new ChatSession(primary, null);
    await expect(session.turn("hi", "P")).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("propagates non-usage-limit errors unchanged", async () => {
    const boom = new Error("network down");
    const primary = new FakeBackend("codex", () => {
      throw boom;
    });
    const session = new ChatSession(
      primary,
      new FakeBackend("openai", () => reply("x")),
    );
    await expect(session.turn("hi", "P")).rejects.toThrow("network down");
  });

  it("closes both backends", () => {
    const primary = new FakeBackend("codex", () => reply("x"));
    const fallback = new FakeBackend("openai", () => reply("y"));
    new ChatSession(primary, fallback).close();
    expect(primary.closed).toBe(true);
    expect(fallback.closed).toBe(true);
  });
});

describe("backend selection", () => {
  it("detectCodexLogin returns false when the command is unavailable", async () => {
    await expect(
      detectCodexLogin("definitely-not-codex-for-braindump-tests"),
    ).resolves.toBe(false);
  });

  it("forced codex mode fails early when login is unavailable", async () => {
    await expect(
      createSession({
        preference: "codex",
        openai: null,
        codexCommand: "definitely-not-codex-for-braindump-tests",
      }),
    ).rejects.toThrow(/Codex backend requested/);
  });
});

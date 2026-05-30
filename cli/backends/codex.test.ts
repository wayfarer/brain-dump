// @vitest-environment node
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { AppServerClient, type AppServerTransport } from "./appserver.js";
import { CodexBackend } from "./codex.js";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

class FakeTransport implements AppServerTransport {
  sent: Array<Record<string, unknown>> = [];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  send(line: string): void {
    this.sent.push(JSON.parse(line) as Record<string, unknown>);
  }
  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }
  close(): void {}

  push(msg: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(msg));
  }
  lastId(): number {
    return this.sent[this.sent.length - 1].id as number;
  }
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => stdoutSpy.mockRestore());

describe("CodexBackend", () => {
  it("starts a fresh thread per turn with the current prompt and transcript", async () => {
    const transport = new FakeTransport();
    const backend = new CodexBackend(new AppServerClient(transport));
    const firstText = vi.fn();
    const text = vi.fn();

    const first = backend.runTurn({
      userInput: "u1",
      systemPrompt: "PROMPT 1",
      transcript: [],
      events: { onFirstText: firstText, onText: text },
    });
    expect(transport.sent[0]).toMatchObject({ method: "initialize" });
    transport.push({ id: transport.lastId(), result: {} });
    await tick();
    expect(transport.sent[1]).toMatchObject({ method: "thread/start" });
    expect(
      (transport.sent[1].params as { baseInstructions: string })
        .baseInstructions,
    ).toContain("PROMPT 1");
    transport.push({
      id: transport.lastId(),
      result: { thread: { id: "t1" } },
    });
    await tick();
    expect(transport.sent[2]).toMatchObject({
      method: "turn/start",
      params: { threadId: "t1" },
    });
    transport.push({ id: transport.lastId(), result: {} });
    await tick();
    transport.push({
      method: "item/agentMessage/delta",
      params: { delta: '{"reply":"q1","node":null}' },
    });
    transport.push({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await expect(first).resolves.toMatchObject({ question: "q1", nodes: [] });
    expect(firstText).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith("q1");
    expect(stdoutSpy).not.toHaveBeenCalled();

    const second = backend.runTurn({
      userInput: "u2",
      systemPrompt: "PROMPT 2",
      transcript: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "q1" },
      ],
      events: { onFirstText: firstText, onText: text },
    });
    await tick();
    expect(transport.sent[3]).toMatchObject({ method: "thread/start" });
    expect(
      (transport.sent[3].params as { baseInstructions: string })
        .baseInstructions,
    ).toContain("PROMPT 2");
    transport.push({
      id: transport.lastId(),
      result: { thread: { id: "t2" } },
    });
    await tick();

    const turnStart = transport.sent[4] as {
      method: string;
      params: { threadId: string; input: Array<{ text: string }> };
    };
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: { threadId: "t2" },
    });
    expect(turnStart.params.input.map((i) => i.text)).toEqual([
      "Prior user: u1",
      "Prior assistant: q1",
      expect.stringContaining("Current user response:\nu2"),
    ]);
    expect(turnStart.params.input[2].text).toContain(
      "Extract a node only from this current user response.",
    );
    transport.push({ id: transport.lastId(), result: {} });
    await tick();
    transport.push({
      method: "item/agentMessage/delta",
      params: { delta: '{"reply":"q2","node":null}' },
    });
    transport.push({
      method: "turn/completed",
      params: { turn: { status: "completed" } },
    });
    await expect(second).resolves.toMatchObject({ question: "q2", nodes: [] });
    expect(firstText).toHaveBeenCalledTimes(2);
    expect(text).toHaveBeenCalledWith("q2");
  });
});

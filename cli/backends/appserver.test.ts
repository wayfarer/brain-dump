// @vitest-environment node
import { describe, it, expect } from "vitest";

import { AppServerClient, type AppServerTransport } from "./appserver.js";

/** In-memory transport: capture what the client sends, push lines back to it. */
class FakeTransport implements AppServerTransport {
  sent: Array<Record<string, unknown>> = [];
  private lineCb: ((line: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;

  send(line: string): void {
    this.sent.push(JSON.parse(line) as Record<string, unknown>);
  }
  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  close(): void {}

  // test helpers
  push(msg: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(msg));
  }
  exit(code: number | null): void {
    this.exitCb?.(code);
  }
  lastId(): number {
    return this.sent[this.sent.length - 1].id as number;
  }
}

describe("AppServerClient", () => {
  it("correlates a request with its response by id", async () => {
    const t = new FakeTransport();
    const client = new AppServerClient(t);
    const p = client.request("initialize", { hello: true });

    expect(t.sent[0]).toMatchObject({ method: "initialize", params: { hello: true } });
    t.push({ id: t.lastId(), result: { ok: 1 } });
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it("rejects when the server returns an error", async () => {
    const t = new FakeTransport();
    const client = new AppServerClient(t);
    const p = client.request("thread/start", {});
    t.push({ id: t.lastId(), error: { message: "nope" } });
    await expect(p).rejects.toThrow(/nope/);
  });

  it("accumulates agent deltas and resolves expectTurn on turn/completed", async () => {
    const t = new FakeTransport();
    const client = new AppServerClient(t);
    const turn = client.expectTurn();

    t.push({ method: "item/agentMessage/delta", params: { delta: '{"reply":"' } });
    t.push({ method: "item/agentMessage/delta", params: { delta: 'hi"}' } });
    t.push({ method: "turn/completed", params: { turn: { status: "completed" } } });

    const { turn: payload, text } = await turn;
    expect(text).toBe('{"reply":"hi"}');
    expect(payload).toEqual({ status: "completed" });
  });

  it("resets the delta buffer between turns", async () => {
    const t = new FakeTransport();
    const client = new AppServerClient(t);

    const t1 = client.expectTurn();
    t.push({ method: "item/agentMessage/delta", params: { delta: "first" } });
    t.push({ method: "turn/completed", params: { turn: {} } });
    expect((await t1).text).toBe("first");

    const t2 = client.expectTurn();
    t.push({ method: "item/agentMessage/delta", params: { delta: "second" } });
    t.push({ method: "turn/completed", params: { turn: {} } });
    expect((await t2).text).toBe("second");
  });

  it("auto-responds to server→client requests so it never deadlocks", () => {
    const t = new FakeTransport();
    new AppServerClient(t);
    t.push({ id: 99, method: "execCommandApproval", params: {} });
    expect(t.sent).toContainEqual({ id: 99, result: {} });
  });

  it("rejects pending requests when the server exits", async () => {
    const t = new FakeTransport();
    const client = new AppServerClient(t);
    const p = client.request("initialize", {});
    t.exit(1);
    await expect(p).rejects.toThrow(/exited/);
  });
});

/**
 * Minimal client for `codex app-server` (codex-cli >= 0.133.0).
 *
 * Framing is newline-delimited JSON with `{ id, method, params }` requests
 * (no `jsonrpc` field). Turns are async: `turn/start` returns immediately and
 * the assistant's text arrives only via `item/agentMessage/delta` notifications;
 * the completed-turn payload carries no items. So we accumulate deltas and
 * resolve on `turn/completed`.
 *
 * Auth is whatever `~/.codex/auth.json` holds — we never touch credentials.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

/** Injectable line transport so the client can be tested against a fake peer. */
export interface AppServerTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  close(): void;
}

/** Default transport: spawn `codex app-server` and frame stdin/stdout as JSONL. */
export function spawnCodexTransport(command = "codex"): AppServerTransport {
  const child = spawn(command, ["app-server"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const rl = createInterface({ input: child.stdout });
  return {
    send: (line) => child.stdin.write(line + "\n"),
    onLine: (cb) => rl.on("line", cb),
    onExit: (cb) => child.on("exit", cb),
    onError: (cb) => child.on("error", cb),
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

export interface CompletedTurn {
  /** The completed Turn payload from `turn/completed` (items are usually empty). */
  turn: Json;
  /** Accumulated `item/agentMessage/delta` text for the turn. */
  text: string;
}

export class AppServerClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  private turnWaiters: Array<{
    resolve: (t: CompletedTurn) => void;
    reject: (e: Error) => void;
  }> = [];
  private agentText = "";

  constructor(private transport: AppServerTransport) {
    transport.onLine((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Json;
      try {
        msg = JSON.parse(trimmed) as Json;
      } catch {
        return; // ignore non-JSON chatter
      }
      this.onMessage(msg);
    });
    transport.onExit((code) =>
      this.rejectAll(
        new Error(`codex app-server exited (code ${code ?? "null"})`),
      ),
    );
    transport.onError((err) => this.rejectAll(err));
  }

  private rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    for (const { reject } of this.turnWaiters) reject(err);
    this.turnWaiters = [];
  }

  private onMessage(msg: Json): void {
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    // Response to one of our requests.
    if (id != null && method == null) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve((msg.result as Json) ?? {});
      return;
    }

    // Server -> client request (e.g. an approval). With approvalPolicy "never"
    // we don't expect these, but answer defensively so we never deadlock.
    if (id != null && method != null) {
      this.send({ id, result: {} });
      return;
    }

    if (method) this.onNotification(method, (msg.params as Json) ?? {});
  }

  private onNotification(method: string, params: Json): void {
    switch (method) {
      case "item/agentMessage/delta":
        this.agentText += String(params.delta ?? "");
        break;
      case "turn/completed": {
        const turn = (params.turn as Json) ?? {};
        const waiter = this.turnWaiters.shift();
        if (waiter) waiter.resolve({ turn, text: this.agentText });
        break;
      }
      default:
        break;
    }
  }

  private send(msg: Json): void {
    this.transport.send(JSON.stringify(msg));
  }

  /** Send a request and await its response. */
  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /**
   * Register interest in the next `turn/completed` BEFORE sending `turn/start`,
   * then await the returned promise. Resets the per-turn delta buffer.
   */
  expectTurn(): Promise<CompletedTurn> {
    this.agentText = "";
    return new Promise((resolve, reject) =>
      this.turnWaiters.push({ resolve, reject }),
    );
  }

  close(): void {
    this.transport.close();
  }
}

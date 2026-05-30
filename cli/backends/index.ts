/**
 * Backend selection and the fallback runner.
 *
 * A ChatSession prefers a primary backend (Codex on the user's subscription)
 * and latches to the OpenAI API for the rest of the session the first time the
 * subscription reports a usage limit — printing a one-line notice. A single
 * provider-agnostic transcript is the source of conversational truth, so the
 * OpenAI backend has full context after a mid-session switch.
 */
import { spawn } from "node:child_process";

import type OpenAI from "openai";

import { CodexBackend } from "./codex.js";
import { OpenAIBackend } from "./openai.js";
import { type ChatBackend, type TranscriptEntry, type TurnResult, UsageLimitExceededError } from "./types.js";

export type { ChatBackend } from "./types.js";

export type BackendPreference = "auto" | "codex" | "openai";

export class ChatSession {
  private active: ChatBackend;
  private transcript: TranscriptEntry[] = [];

  constructor(
    private primary: ChatBackend,
    private fallback: ChatBackend | null,
  ) {
    this.active = primary;
  }

  /** The backend currently serving turns. */
  get activeName(): ChatBackend["name"] {
    return this.active.name;
  }

  async turn(userInput: string, systemPrompt: string): Promise<TurnResult> {
    const input = { userInput, systemPrompt, transcript: [...this.transcript] };

    let result: TurnResult;
    try {
      result = await this.active.runTurn(input);
    } catch (err) {
      if (!(err instanceof UsageLimitExceededError)) throw err;
      if (!this.fallback || this.active === this.fallback) {
        throw new Error(
          "Subscription usage limit reached. Set OPENAI_API_KEY to continue, or wait for the limit to reset.",
        );
      }
      console.log("\nSubscription limit reached — continuing on API key.\n");
      this.active = this.fallback;
      result = await this.active.runTurn(input);
    }

    this.transcript.push({ role: "user", text: userInput }, { role: "assistant", text: result.question });
    return result;
  }

  close(): void {
    void this.primary.close();
    if (this.fallback && this.fallback !== this.primary) void this.fallback.close();
  }
}

/** True if the Codex CLI is installed and signed in. */
export function detectCodexLogin(command = "codex"): Promise<boolean> {
  return new Promise((resolve) => {
    let out = "";
    // `codex login status` prints "Logged in …" to stderr, so capture both streams.
    const child = spawn(command, ["login", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(false)); // not installed / not on PATH
    child.on("exit", (code) => resolve(code === 0 && /logged in/i.test(out)));
  });
}

export interface SessionResult {
  session: ChatSession;
  primaryName: ChatBackend["name"];
}

/**
 * Build a ChatSession honoring the preference and available credentials.
 * `openai` is null when no API key is set (subscription-only mode).
 */
export async function createSession(opts: {
  preference: BackendPreference;
  openai: OpenAI | null;
}): Promise<SessionResult> {
  const { preference, openai } = opts;
  const fallback = openai ? new OpenAIBackend(openai) : null;

  let useCodex: boolean;
  if (preference === "openai") useCodex = false;
  else if (preference === "codex") useCodex = true;
  else useCodex = await detectCodexLogin();

  if (useCodex) {
    return { session: new ChatSession(CodexBackend.create(), fallback), primaryName: "codex" };
  }
  if (!fallback) {
    throw new Error(
      "No chat backend available. Run `codex login` for subscription auth, or set OPENAI_API_KEY.",
    );
  }
  return { session: new ChatSession(fallback, null), primaryName: "openai" };
}

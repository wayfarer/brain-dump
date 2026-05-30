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
import {
  type ChatBackend,
  type TranscriptEntry,
  type TurnResult,
  UsageLimitExceededError,
} from "./types.js";

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

  async turn(
    userInput: string,
    systemPrompt: string,
    onFirstOutput?: () => void,
  ): Promise<TurnResult> {
    const input = {
      userInput,
      systemPrompt,
      transcript: [...this.transcript],
      onFirstOutput,
    };

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

    this.transcript.push(
      { role: "user", text: userInput },
      { role: "assistant", text: result.question },
    );
    return result;
  }

  close(): void {
    void this.primary.close();
    if (this.fallback && this.fallback !== this.primary)
      void this.fallback.close();
  }
}

/** True if the Codex CLI is installed and signed in. */
export function detectCodexLogin(
  command = "codex",
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let out = "";
    function finish(value: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    // `codex login status` prints "Logged in …" to stderr, so capture both streams.
    const child = spawn(command, ["login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => finish(false)); // not installed / not on PATH
    child.on("exit", (code) => finish(code === 0 && /logged in/i.test(out)));
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
  codexCommand?: string;
}): Promise<SessionResult> {
  const { preference, openai, codexCommand = "codex" } = opts;
  const fallback = openai ? new OpenAIBackend(openai) : null;

  let useCodex: boolean;
  if (preference === "openai") useCodex = false;
  else {
    useCodex = await detectCodexLogin(codexCommand);
    if (preference === "codex" && !useCodex) {
      throw new Error(
        "Codex backend requested, but `codex login status` did not report a logged-in account.",
      );
    }
  }

  if (useCodex) {
    return {
      session: new ChatSession(CodexBackend.create(codexCommand), fallback),
      primaryName: "codex",
    };
  }
  if (!fallback) {
    throw new Error(
      "No chat backend available. Run `codex login` for subscription auth, or set OPENAI_API_KEY.",
    );
  }
  return { session: new ChatSession(fallback, null), primaryName: "openai" };
}

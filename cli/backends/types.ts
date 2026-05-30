/**
 * The chat-backend seam. A backend turns one user message into the
 * interviewer's next question plus any memories worth preserving, while
 * embeddings, retrieval, and persistence stay shared in interview.ts.
 */

import type { MemoryDateGranularity } from "../types.js";

/** A memory candidate surfaced by a backend, before DB-side resolution. */
export interface ExtractedNode {
  tag: string;
  content: string;
  /** Parent DumpNode id, or "" for a root memory. */
  parentId: string;
  memoryDate?: string;
  memoryDateGranularity?: MemoryDateGranularity | string;
}

export interface TurnResult {
  /** The interviewer's complete next question text. */
  question: string;
  /** Zero or more memories to persist (Codex yields 0–1; OpenAI may yield more). */
  nodes: ExtractedNode[];
}

/** One entry of the provider-agnostic conversation transcript. */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface TurnEvents {
  /** Fired once immediately before the first visible assistant text. */
  onFirstText?: () => void;
  /** Fired for each assistant text chunk. */
  onText?: (text: string) => void;
}

export interface RunTurnInput {
  userInput: string;
  /** Shared interviewer prompt + retrieval context; each backend appends its own extraction tail. */
  systemPrompt: string;
  /** Conversation so far (excludes the current userInput). */
  transcript: readonly TranscriptEntry[];
  /** Presentation events for assistant text. Backends must not write to stdout. */
  events?: TurnEvents;
}

export interface ChatBackend {
  readonly name: "codex" | "openai";
  /** Run one turn and return extracted data; implementations do not write to stdout. */
  runTurn(input: RunTurnInput): Promise<TurnResult>;
  close(): void | Promise<void>;
}

/** Thrown by a backend when the account's usage limit is hit (triggers fallback). */
export class UsageLimitExceededError extends Error {
  constructor(message = "usage limit exceeded") {
    super(message);
    this.name = "UsageLimitExceededError";
  }
}

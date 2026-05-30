import { randomUUID } from "node:crypto";

import OpenAI from "openai";

import type { ChatSession } from "./backends/index.js";
import type { ExtractedNode } from "./backends/types.js";
import {
  type Db,
  getNodeById,
  getNodeCount,
  getRecentNodes,
  insertEmbeddingByRowid,
  insertNode,
  searchNodes,
  searchNodesByVector,
} from "./store.js";
import type { DumpNode, MemoryDateGranularity } from "./types.js";

export interface SegmentConfig {
  id: string;
  openingQuestion: string;
  returnGreeting: string;
}

export const SEGMENTS: Record<string, SegmentConfig> = {
  life_story: {
    id: "life_story",
    openingQuestion: "What is your first memory?",
    returnGreeting: "Welcome back. Where would you like to go today?",
  },
  dream_journal: {
    id: "dream_journal",
    openingQuestion: "Tell me about a dream you remember.",
    returnGreeting: "Welcome back. What have you been dreaming about?",
  },
};

/**
 * Shared interviewer rules, free of any extraction-mechanism wording. Each
 * backend appends its own tail (OpenAI: a function tool; Codex: a JSON contract).
 */
const BASE_SYSTEM_PROMPT = `You are a warm, patient interviewer conducting a gentle memory archaeology session.
Your only job is to ask one focused follow-up question per turn.

Rules:
- Ask exactly one question. Never two.
- Keep questions short — one sentence, ideally under 15 words.
- Do not interpret, analyze, or reflect emotions back. Just ask.
- No filler phrases ("That's interesting", "Thank you for sharing").
- Vary your approach: zoom in on a detail, ask about a person, ask what came just before or after, ask how old they were.
- Never break character. Never explain yourself.`;

const VALID_GRANULARITIES = new Set<string>([
  "decade",
  "year",
  "season",
  "month",
  "date",
  "datetime",
]);

export interface InterviewState {
  db: Db;
  lastParentId: string | null;
  segment: string;
}

export async function buildSystemPrompt(
  db: Db,
  openai: OpenAI | null,
  segment: string,
  recentInput?: string,
  recentEmbedding?: number[],
): Promise<string> {
  if (getNodeCount(db, segment) === 0) {
    return BASE_SYSTEM_PROMPT;
  }

  let contextNodes: DumpNode[];

  if (recentInput) {
    let searchResults: DumpNode[] = [];

    // Try vector search first; fall back to FTS5.
    try {
      let embedding: number[] | undefined = recentEmbedding;
      if (!embedding && openai) {
        const response = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: recentInput,
        });
        embedding = response.data[0].embedding;
      }
      if (embedding) {
        searchResults = searchNodesByVector(db, embedding, 5, segment);
      }
    } catch {
      // ignore — fall through to FTS5
    }

    if (searchResults.length === 0) {
      searchResults = searchNodes(db, recentInput, 5).filter(
        (n) => n.segment === segment,
      );
    }

    if (searchResults.length > 0) {
      const searchedIds = new Set(searchResults.map((n) => n.id));
      const filler = getRecentNodes(db, 10, segment).filter(
        (n) => !searchedIds.has(n.id),
      );
      contextNodes = [...searchResults, ...filler].slice(0, 10).reverse();
    } else {
      contextNodes = getRecentNodes(db, 10, segment).reverse();
    }
  } else {
    contextNodes = getRecentNodes(db, 10, segment).reverse();
  }

  const summary = contextNodes
    .map((n) => `"${n.tag}" — depth ${n.depth}`)
    .join("\n");

  return `${BASE_SYSTEM_PROMPT}

Context from previous sessions (do not reference this list directly in your questions):
${summary}

Pick up naturally: continue an open thread or open a new area of their life not yet explored.`;
}

export function buildOpeningMessage(db: Db, segment: string): string {
  const config = SEGMENTS[segment];
  if (getNodeCount(db, segment) === 0) {
    return config.openingQuestion;
  }
  return config.returnGreeting;
}

/** Persist memory candidates surfaced by a backend, with the user input's embedding. */
export function persistNodes(
  db: Db,
  state: InterviewState,
  nodes: ExtractedNode[],
  embedding: number[] | null,
): void {
  for (const n of nodes) {
    const explicitParent = n.parentId ? getNodeById(db, n.parentId) : null;
    const fallbackParent =
      !explicitParent && state.lastParentId
        ? getNodeById(db, state.lastParentId)
        : null;
    const parentNode = explicitParent ?? fallbackParent;
    const granularity =
      n.memoryDateGranularity &&
      VALID_GRANULARITIES.has(n.memoryDateGranularity)
        ? (n.memoryDateGranularity as MemoryDateGranularity)
        : null;
    const node: DumpNode = {
      id: randomUUID(),
      tag: n.tag,
      content: n.content,
      parentId: parentNode?.id ?? null,
      capturedAt: Date.now(),
      memoryDate: n.memoryDate || null,
      memoryDateGranularity: granularity,
      segment: state.segment,
      depth: parentNode ? parentNode.depth + 1 : 0,
    };

    const rowid = insertNode(db, node);
    if (embedding !== null) {
      insertEmbeddingByRowid(db, rowid, embedding);
    }
    state.lastParentId = node.id;
  }
}

/**
 * Run one interview turn: embed the input (for retrieval + storage), build the
 * system prompt, ask the active chat backend (which streams/prints its own
 * question and handles subscription→API fallback), then persist any memories.
 */
export async function runTurn(
  session: ChatSession,
  openai: OpenAI | null,
  state: InterviewState,
  userInput: string,
): Promise<void> {
  let embedding: number[] | null = null;
  if (openai) {
    try {
      const r = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: userInput,
      });
      embedding = r.data[0].embedding;
    } catch {
      /* retrieval degrades to FTS5, storage skipped */
    }
  }

  const systemPrompt = await buildSystemPrompt(
    state.db,
    openai,
    state.segment,
    userInput,
    embedding ?? undefined,
  );
  const result = await session.turn(userInput, systemPrompt);
  persistNodes(state.db, state, result.nodes, embedding);
}

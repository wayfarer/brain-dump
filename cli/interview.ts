import { randomUUID } from "node:crypto";

import OpenAI from "openai";

import { type Db, getNodeById, getNodeCount, getRecentNodes, insertNode, searchNodes } from "./store.js";
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

const EXTRACT_NODE_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "extract_memory_node",
    description:
      "Call this silently whenever the user shares a memory or emotional experience worth preserving. " +
      "Do not mention this tool to the user.",
    parameters: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description:
            '1–4 word emotional/experiential label. Lowercase. ' +
            'Examples: "wonder and curiosity", "quiet shame", "sudden loss", "fierce belonging". ' +
            'Never use generic words like "memory" or "experience".',
        },
        content: {
          type: "string",
          description: "The user's exact response text that prompted this extraction.",
        },
        parentId: {
          type: "string",
          description:
            'id of the parent DumpNode, or empty string "" if this is a root memory.',
        },
        memoryDate: {
          type: "string",
          description:
            "When the memory occurred. Use ISO format when precise (\"2003-03-15\", \"1987-06\", \"1987\"), " +
            "or a descriptive string when vague (\"early 1980s\", \"summer of my childhood\"). Omit if unknown.",
        },
        memoryDateGranularity: {
          type: "string",
          enum: ["decade", "year", "season", "month", "date", "datetime"],
          description:
            "How precisely the date is known. " +
            "decade: only the decade is known; year: a specific year; season: season of a year; " +
            "month: month and year; date: full date; datetime: date and time.",
        },
      },
      required: ["tag", "content", "parentId"],
    },
  },
};

const BASE_SYSTEM_PROMPT = `You are a warm, patient interviewer conducting a gentle memory archaeology session.
Your only job is to ask one focused follow-up question per turn.

Rules:
- Ask exactly one question. Never two.
- Keep questions short — one sentence, ideally under 15 words.
- Do not interpret, analyze, or reflect emotions back. Just ask.
- No filler phrases ("That's interesting", "Thank you for sharing").
- Vary your approach: zoom in on a detail, ask about a person, ask what came just before or after, ask how old they were.
- When the user shares a memory worth preserving, call extract_memory_node silently before writing your question. Do not mention it.
- In extract_memory_node, always include memoryDate and memoryDateGranularity when the user gives any time clue — age, grade, season, decade, or year. Estimate conservatively when unsure (e.g., a stated age + known birth year → specific year).
- Never break character. Never explain yourself.`;

export interface InterviewState {
  history: OpenAI.Chat.ChatCompletionMessageParam[];
  db: Db;
  lastParentId: string | null;
  segment: string;
}

export function buildSystemPrompt(db: Db, segment: string, recentInput?: string): string {
  if (getNodeCount(db, segment) === 0) {
    return BASE_SYSTEM_PROMPT;
  }

  let contextNodes: DumpNode[];

  if (recentInput) {
    const searched = searchNodes(db, recentInput, 5).filter((n) => n.segment === segment);
    if (searched.length > 0) {
      const searchedIds = new Set(searched.map((n) => n.id));
      const filler = getRecentNodes(db, 10, segment).filter((n) => !searchedIds.has(n.id));
      contextNodes = [...searched, ...filler].slice(0, 10).reverse();
    } else {
      contextNodes = getRecentNodes(db, 10, segment).reverse();
    }
  } else {
    contextNodes = getRecentNodes(db, 10, segment).reverse();
  }

  const summary = contextNodes.map((n) => `"${n.tag}" — depth ${n.depth}`).join("\n");

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

export async function runTurn(
  client: OpenAI,
  state: InterviewState,
  userInput: string,
): Promise<void> {
  state.history.push({ role: "user", content: userInput });

  const stream = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: buildSystemPrompt(state.db, state.segment, userInput) },
      ...state.history,
    ],
    tools: [EXTRACT_NODE_TOOL],
    stream: true,
  });

  let fullContent = "";
  const toolCalls: Array<{ index: number; id: string; name: string; arguments: string }> = [];

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) {
      process.stdout.write(delta.content);
      fullContent += delta.content;
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCalls[tc.index]) {
          toolCalls[tc.index] = { index: tc.index, id: "", name: "", arguments: "" };
        }
        if (tc.id) toolCalls[tc.index].id += tc.id;
        if (tc.function?.name) toolCalls[tc.index].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
      }
    }
  }
  process.stdout.write("\n");

  const completedToolCalls = toolCalls.filter(Boolean);

  state.history.push({
    role: "assistant",
    content: fullContent || null,
    ...(completedToolCalls.length > 0 && {
      tool_calls: completedToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }),
  });

  for (const tc of completedToolCalls) {
    let args: {
      tag: string;
      content: string;
      parentId: string;
      memoryDate?: string;
      memoryDateGranularity?: string;
    };
    try {
      args = JSON.parse(tc.arguments) as typeof args;
    } catch {
      state.history.push({ role: "tool", tool_call_id: tc.id, content: "error: invalid json" });
      continue;
    }

    const VALID_GRANULARITIES = new Set<string>(["decade", "year", "season", "month", "date", "datetime"]);
    const parentNode = args.parentId ? getNodeById(state.db, args.parentId) : null;
    const node: DumpNode = {
      id: randomUUID(),
      tag: args.tag,
      content: args.content,
      parentId: args.parentId || null,
      capturedAt: Date.now(),
      memoryDate: args.memoryDate || null,
      memoryDateGranularity:
        args.memoryDateGranularity && VALID_GRANULARITIES.has(args.memoryDateGranularity)
          ? (args.memoryDateGranularity as MemoryDateGranularity)
          : null,
      segment: state.segment,
      depth: parentNode ? parentNode.depth + 1 : 0,
    };

    insertNode(state.db, node);
    state.lastParentId = node.id;

    state.history.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
  }
}

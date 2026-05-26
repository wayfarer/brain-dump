import { randomUUID } from "node:crypto";

import OpenAI from "openai";

import { saveRecord } from "./store.js";
import type { DumpNode, DumpRecord } from "./types.js";

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
- Never break character. Never explain yourself.`;

export interface InterviewState {
  history: OpenAI.Chat.ChatCompletionMessageParam[];
  record: DumpRecord;
  lastParentId: string | null;
}

export function buildSystemPrompt(record: DumpRecord): string {
  if (record.nodes.length === 0) {
    return BASE_SYSTEM_PROMPT;
  }

  const recent = record.nodes.slice(-10);
  const summary = recent
    .map((n) => `"${n.tag}" — depth ${n.depth}`)
    .join("\n");

  return `${BASE_SYSTEM_PROMPT}

Context from previous sessions (do not reference this list directly in your questions):
${summary}

Pick up naturally: continue an open thread or open a new area of their life not yet explored.`;
}

export function buildOpeningMessage(record: DumpRecord): string {
  if (record.nodes.length === 0) {
    return "What is your first memory?";
  }
  return "Welcome back. Where would you like to go today?";
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
      { role: "system", content: buildSystemPrompt(state.record) },
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
    let args: { tag: string; content: string; parentId: string };
    try {
      args = JSON.parse(tc.arguments) as typeof args;
    } catch {
      state.history.push({ role: "tool", tool_call_id: tc.id, content: "error: invalid json" });
      continue;
    }

    const parentNode = state.record.nodes.find((n) => n.id === args.parentId);
    const node: DumpNode = {
      id: randomUUID(),
      timestamp: Date.now(),
      tag: args.tag,
      content: args.content,
      depth: parentNode ? parentNode.depth + 1 : 0,
      parentId: args.parentId || null,
    };

    state.record.nodes.push(node);
    saveRecord(state.record);
    state.lastParentId = node.id;

    state.history.push({ role: "tool", tool_call_id: tc.id, content: "ok" });
  }
}

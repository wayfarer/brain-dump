/**
 * OpenAIBackend — the direct OpenAI API chat path (today's behavior, refactored
 * behind the ChatBackend seam). Streams the question token-by-token and uses the
 * `extract_memory_node` function tool to surface memories. Stateless across
 * turns: it rebuilds messages from the shared transcript each call, so it can
 * take over seamlessly when Codex falls back mid-session.
 */
import OpenAI from "openai";

import { type ChatBackend, type ExtractedNode, type RunTurnInput, type TurnResult } from "./types.js";

const OPENAI_EXTRACTION_TAIL = `

When the user shares a memory worth preserving, call extract_memory_node silently before writing your question. Do not mention the tool. Always include memoryDate and memoryDateGranularity when the user gives any time clue — age, grade, season, decade, or year.`;

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
          description: 'id of the parent DumpNode, or empty string "" if this is a root memory.',
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
          description: "How precisely the date is known.",
        },
      },
      required: ["tag", "content", "parentId"],
    },
  },
};

export class OpenAIBackend implements ChatBackend {
  readonly name = "openai" as const;

  constructor(
    private client: OpenAI,
    private model = "gpt-4o",
  ) {}

  async runTurn({
    userInput,
    systemPrompt,
    transcript,
    onFirstOutput,
  }: RunTurnInput): Promise<TurnResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt + OPENAI_EXTRACTION_TAIL },
      ...transcript.map((e) => ({ role: e.role, content: e.text }) as OpenAI.Chat.ChatCompletionMessageParam),
      { role: "user", content: userInput },
    ];

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: [EXTRACT_NODE_TOOL],
      stream: true,
    });

    let fullContent = "";
    let firstOutputFired = false;
    const toolCalls: Array<{ index: number; arguments: string }> = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        if (!firstOutputFired) {
          firstOutputFired = true;
          onFirstOutput?.();
        }
        process.stdout.write(delta.content);
        fullContent += delta.content;
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCalls[tc.index]) toolCalls[tc.index] = { index: tc.index, arguments: "" };
          if (tc.function?.arguments) toolCalls[tc.index].arguments += tc.function.arguments;
        }
      }
    }
    if (!firstOutputFired) onFirstOutput?.();
    process.stdout.write("\n");

    const nodes: ExtractedNode[] = [];
    for (const tc of toolCalls.filter(Boolean)) {
      let args: { tag?: string; content?: string; parentId?: string; memoryDate?: string; memoryDateGranularity?: string };
      try {
        args = JSON.parse(tc.arguments) as typeof args;
      } catch {
        continue; // skip malformed tool call
      }
      if (!args.tag || !args.content) continue;
      nodes.push({
        tag: args.tag,
        content: args.content,
        parentId: args.parentId ?? "",
        memoryDate: args.memoryDate,
        memoryDateGranularity: args.memoryDateGranularity,
      });
    }

    return { question: fullContent, nodes };
  }

  close(): void {
    /* nothing to clean up */
  }
}

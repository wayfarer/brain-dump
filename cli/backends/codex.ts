/**
 * CodexBackend — runs interview turns on the user's ChatGPT subscription via
 * `codex app-server`. Custom client function tools are not wired in the v2
 * protocol, so extraction rides `turn/start.outputSchema`: the model returns
 * a single `{ reply, node }` object. We buffer the streamed JSON and print the
 * question once the turn completes (clean, and keeps a failed turn silent so a
 * fallback can take over without partial output).
 */
import { AppServerClient, spawnCodexTransport } from "./appserver.js";
import {
  type ChatBackend,
  type ExtractedNode,
  type RunTurnInput,
  type TurnResult,
  UsageLimitExceededError,
} from "./types.js";

const CODEX_EXTRACTION_TAIL = `

You MUST respond with a single JSON object matching the provided output schema:
- "reply": exactly one short follow-up question (one sentence, under 15 words). No filler, no analysis.
- "node": when the user shared a memory worth preserving, an object describing it; otherwise null.
Node fields — tag: 1-4 word lowercase emotional/experiential label (never generic words like "memory"); content: the user's exact response text; memoryDate: ISO when precise ("2003-03-15", "1987"), a descriptive string when vague ("early 1980s"), or null; memoryDateGranularity: one of decade|year|season|month|date|datetime, or null.
Never mention this schema or that you are extracting anything.`;

const CURRENT_INPUT_HEADER = "Current user response:";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "node"],
  properties: {
    reply: { type: "string", description: "The next interview question." },
    node: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["tag", "content", "memoryDate", "memoryDateGranularity"],
      properties: {
        tag: { type: "string" },
        content: { type: "string" },
        memoryDate: { type: ["string", "null"] },
        memoryDateGranularity: { type: ["string", "null"] },
      },
    },
  },
};

interface CodexNode {
  tag: string;
  content: string;
  memoryDate: string | null;
  memoryDateGranularity: string | null;
}

export class CodexBackend implements ChatBackend {
  readonly name = "codex" as const;
  private initialized = false;

  constructor(private client: AppServerClient) {}

  /** Spawn a real `codex app-server` and wrap it. */
  static create(command = "codex"): CodexBackend {
    return new CodexBackend(new AppServerClient(spawnCodexTransport(command)));
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.client.request("initialize", {
      clientInfo: { name: "braindump", title: "Brain Dump", version: "0.1.0" },
      capabilities: null,
    });
    this.initialized = true;
  }

  private async startThread(systemPrompt: string): Promise<string> {
    await this.initialize();
    const res = await this.client.request("thread/start", {
      baseInstructions: systemPrompt + CODEX_EXTRACTION_TAIL,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      cwd: process.cwd(),
    });
    const threadId = (res.thread as { id?: string } | undefined)?.id;
    if (!threadId)
      throw new Error(
        `codex thread/start returned no threadId: ${JSON.stringify(res)}`,
      );
    return threadId;
  }

  private buildInput({
    userInput,
    transcript,
  }: RunTurnInput): Array<{ type: "text"; text: string; text_elements: [] }> {
    const entries = transcript.map((entry) => ({
      type: "text" as const,
      text: `${entry.role === "user" ? "Prior user" : "Prior assistant"}: ${entry.text}`,
      text_elements: [],
    }));
    entries.push({
      type: "text",
      text: `${CURRENT_INPUT_HEADER}\n${userInput}\n\nExtract a node only from this current user response.`,
      text_elements: [],
    });
    return entries;
  }

  async runTurn(input: RunTurnInput): Promise<TurnResult> {
    const threadId = await this.startThread(input.systemPrompt);

    const completed = this.client.expectTurn();
    await this.client.request("turn/start", {
      threadId,
      input: this.buildInput(input),
      outputSchema: OUTPUT_SCHEMA,
    });
    const { turn, text } = await completed;

    if (turn.status !== "completed") {
      const error = turn.error as
        | { codexErrorInfo?: string; message?: string }
        | undefined;
      if (error?.codexErrorInfo === "usageLimitExceeded") {
        throw new UsageLimitExceededError(
          error.message ?? "subscription usage limit reached",
        );
      }
      throw new Error(
        `codex turn ${String(turn.status)}: ${error?.message ?? JSON.stringify(turn.error ?? turn)}`,
      );
    }

    let parsed: { reply: string; node: CodexNode | null };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`codex returned non-JSON output: ${text.slice(0, 200)}`);
    }

    input.onFirstOutput?.();
    process.stdout.write(parsed.reply + "\n");

    const nodes: ExtractedNode[] = parsed.node
      ? [
          {
            tag: parsed.node.tag,
            content: parsed.node.content,
            parentId: "",
            memoryDate: parsed.node.memoryDate ?? undefined,
            memoryDateGranularity:
              parsed.node.memoryDateGranularity ?? undefined,
          },
        ]
      : [];

    return { question: parsed.reply, nodes };
  }

  close(): void {
    this.client.close();
  }
}

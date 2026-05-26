import "dotenv/config";
import * as readline from "node:readline";

import OpenAI from "openai";

import { buildOpeningMessage, runTurn } from "./interview.js";
import { createFreshRecord, loadRecord, saveRecord } from "./store.js";
import type { InterviewState } from "./interview.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "Error: OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
    process.exit(1);
  }

  const record = loadRecord() ?? createFreshRecord();
  const client = new OpenAI();

  const state: InterviewState = {
    history: [],
    record,
    lastParentId: record.nodes.at(-1)?.id ?? null,
  };

  console.log("\nBrain Dump\n");
  console.log(buildOpeningMessage(record));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    rl.pause();
    console.log();
    await runTurn(client, state, input);
    console.log();
    rl.resume();
    rl.prompt();
  });

  const exit = () => {
    saveRecord(state.record);
    console.log("\n\nSession saved. See you next time.\n");
    process.exit(0);
  };

  rl.on("close", exit);
  process.on("SIGINT", () => rl.close());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

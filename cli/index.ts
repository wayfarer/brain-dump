import "dotenv/config";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";

import OpenAI from "openai";

import { buildOpeningMessage, runTurn } from "./interview.js";
import type { InterviewState } from "./interview.js";
import { getNodeCount, getRecentNodes, importFromJson, openDb } from "./store.js";
import type { LegacyDumpRecord } from "./store.js";
import type { DumpRecord } from "./types.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "Error: OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
    process.exit(1);
  }

  const db = openDb();

  const jsonPath = resolve(process.cwd(), "dump.json");
  if (existsSync(jsonPath) && getNodeCount(db) === 0) {
    const record = JSON.parse(readFileSync(jsonPath, "utf-8")) as DumpRecord | LegacyDumpRecord;
    const count = importFromJson(db, record);
    renameSync(jsonPath, jsonPath + ".migrated");
    console.log(`Migrated ${count} node${count !== 1 ? "s" : ""} from dump.json.\n`);
  }

  const client = new OpenAI();
  const lastNode = getRecentNodes(db, 1)[0];

  const state: InterviewState = {
    history: [],
    db,
    lastParentId: lastNode?.id ?? null,
  };

  console.log("\nBrain Dump\n");
  console.log(buildOpeningMessage(db));
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
    db.close();
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

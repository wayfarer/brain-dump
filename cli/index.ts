import "dotenv/config";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";

import OpenAI from "openai";

import { buildOpeningMessage, runTurn, SEGMENTS } from "./interview.js";
import type { InterviewState } from "./interview.js";
import { getNodeCount, getRecentNodes, getTagCounts, importFromJson, openDb, searchNodes } from "./store.js";
import type { LegacyDumpRecord } from "./store.js";
import type { DumpRecord } from "./types.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "Error: OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
    process.exit(1);
  }

  const segmentFlagIdx = process.argv.indexOf("--segment");
  const segmentArg = segmentFlagIdx !== -1 ? (process.argv[segmentFlagIdx + 1] ?? "") : "life_story";
  if (!SEGMENTS[segmentArg]) {
    console.error(`Unknown segment "${segmentArg}". Available: ${Object.keys(SEGMENTS).join(", ")}`);
    process.exit(1);
  }
  const segment = segmentArg;

  const db = openDb();

  const jsonPath = resolve(process.cwd(), "dump.json");
  if (existsSync(jsonPath) && getNodeCount(db) === 0) {
    const record = JSON.parse(readFileSync(jsonPath, "utf-8")) as DumpRecord | LegacyDumpRecord;
    const count = importFromJson(db, record);
    renameSync(jsonPath, jsonPath + ".migrated");
    console.log(`Migrated ${count} node${count !== 1 ? "s" : ""} from dump.json.\n`);
  }

  const client = new OpenAI();
  const lastNode = getRecentNodes(db, 1, segment)[0];

  const state: InterviewState = {
    history: [],
    db,
    lastParentId: lastNode?.id ?? null,
    segment,
  };

  console.log(`\nBrain Dump${segment !== "life_story" ? `  [${segment}]` : ""}\n`);
  console.log(buildOpeningMessage(db, segment));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  let turnLock: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    turnLock = turnLock.then(async () => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }

      if (input === "/exit") {
        rl.close();
        return;
      }

      if (input === "/list" || input.startsWith("/list ")) {
        const arg = input.slice(5).trim();
        const limit = Math.max(1, parseInt(arg, 10) || 10);
        console.log();
        const nodes = getRecentNodes(db, limit);
        if (nodes.length === 0) {
          console.log("No nodes captured yet.");
        } else {
          for (const node of nodes) {
            const date = node.memoryDate ? ` [${node.memoryDate}]` : "";
            const preview = node.content.length > 80 ? node.content.slice(0, 77) + "..." : node.content;
            console.log(`  "${node.tag}"${date} — ${preview}`);
          }
        }
        console.log();
        rl.prompt();
        return;
      }

      if (input === "/tags") {
        console.log();
        const counts = getTagCounts(db);
        if (counts.length === 0) {
          console.log("No tags yet.");
        } else {
          for (const { tag, count } of counts) {
            console.log(`  "${tag}" × ${count}`);
          }
        }
        console.log();
        rl.prompt();
        return;
      }

      if (input.startsWith("/search ")) {
        const query = input.slice(8).trim();
        console.log();
        if (query) {
          const results = searchNodes(db, query, 10);
          if (results.length === 0) {
            console.log("No matches found.");
          } else {
            for (const node of results) {
              const date = node.memoryDate ? ` [${node.memoryDate}]` : "";
              const preview = node.content.length > 80 ? node.content.slice(0, 77) + "..." : node.content;
              console.log(`  "${node.tag}"${date} — ${preview}`);
            }
          }
        }
        console.log();
        rl.prompt();
        return;
      }

      rl.pause();
      console.log();
      try {
        await runTurn(client, state, input);
      } finally {
        console.log();
        rl.resume();
        rl.prompt();
      }
    }).catch((err: unknown) => {
      console.error("\nError:", err instanceof Error ? err.message : String(err));
      rl.resume();
      rl.prompt();
    });
  });

  rl.on("close", () => {
    void turnLock.then(() => {
      db.close();
      console.log("\n\nSession saved. See you next time.\n");
      process.exit(0);
    });
  });

  process.on("SIGINT", () => rl.close());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

import "dotenv/config";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";

import OpenAI from "openai";

import {
  createSession,
  type BackendPreference,
  type ChatSession,
} from "./backends/index.js";
import { buildOpeningMessage, runTurn, SEGMENTS } from "./interview.js";
import type { InterviewState, TurnPresenter } from "./interview.js";
import {
  exportToJson,
  getNodeCount,
  getRecentNodes,
  getTagCounts,
  importFromJson,
  openDb,
  searchNodes,
} from "./store.js";
import type { LegacyDumpRecord } from "./store.js";
import {
  banner,
  c,
  formatNodeLine,
  savedErrorLine,
  savedLine,
  Spinner,
} from "./ui.js";
import type { DumpRecord } from "./types.js";

const HELP = `  ${c.cyan("/list")} ${c.dim("[n]")}        recent memories (default 10)
  ${c.cyan("/tags")}            tags with counts
  ${c.cyan("/search")} ${c.dim("<query>")}  full-text search
  ${c.cyan("/help")}            show this help
  ${c.cyan("/exit")}            save and quit`;

function runExport(outPath: string): void {
  const db = openDb();
  const record = exportToJson(db);
  writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n", "utf-8");
  db.close();
  console.log(
    `Exported ${record.nodes.length} node${record.nodes.length !== 1 ? "s" : ""} to ${outPath}`,
  );
}

async function main(): Promise<void> {
  const exportFlagIdx = process.argv.indexOf("--export");
  if (exportFlagIdx !== -1) {
    const nextArg = process.argv[exportFlagIdx + 1];
    const outPath = resolve(
      process.cwd(),
      nextArg && !nextArg.startsWith("-") ? nextArg : "dump-export.json",
    );
    runExport(outPath);
    return;
  }

  const segmentFlagIdx = process.argv.indexOf("--segment");
  const segmentArg =
    segmentFlagIdx !== -1
      ? (process.argv[segmentFlagIdx + 1] ?? "")
      : "life_story";
  if (!SEGMENTS[segmentArg]) {
    console.error(
      `Unknown segment "${segmentArg}". Available: ${Object.keys(SEGMENTS).join(", ")}`,
    );
    process.exit(1);
  }
  const segment = segmentArg;

  const backendFlagIdx = process.argv.indexOf("--backend");
  const backendArg =
    (backendFlagIdx !== -1
      ? process.argv[backendFlagIdx + 1]
      : process.env.BRAINDUMP_BACKEND) ?? "auto";
  if (!["auto", "codex", "openai"].includes(backendArg)) {
    console.error(
      `Unknown backend "${backendArg}". Available: auto, codex, openai`,
    );
    process.exit(1);
  }
  const preference = backendArg as BackendPreference;

  const db = openDb();

  const jsonPath = resolve(process.cwd(), "dump.json");
  if (existsSync(jsonPath) && getNodeCount(db) === 0) {
    const record = JSON.parse(readFileSync(jsonPath, "utf-8")) as
      | DumpRecord
      | LegacyDumpRecord;
    const count = importFromJson(db, record);
    renameSync(jsonPath, jsonPath + ".migrated");
    console.log(
      `Migrated ${count} node${count !== 1 ? "s" : ""} from dump.json.\n`,
    );
  }

  const client = process.env.OPENAI_API_KEY ? new OpenAI() : null;

  let session: ChatSession;
  let primaryName: "codex" | "openai";
  try {
    ({ session, primaryName } = await createSession({
      preference,
      openai: client,
    }));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    db.close();
    process.exit(1);
  }

  const lastNode = getRecentNodes(db, 1, segment)[0];
  const state: InterviewState = {
    db,
    lastParentId: lastNode?.id ?? null,
    segment,
  };

  const authLine =
    primaryName === "codex"
      ? client
        ? "Codex subscription · API-key fallback"
        : "Codex subscription"
      : "OpenAI API key";
  console.log(banner(segment));
  console.log(c.dim(`· ${authLine}`));
  console.log();
  console.log(buildOpeningMessage(db, segment));
  console.log(c.dim("Type /help for commands."));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan("> "),
  });

  rl.prompt();

  let turnLock: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    turnLock = turnLock
      .then(async () => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }

        if (input === "/exit") {
          rl.close();
          return;
        }

        if (input === "/help") {
          console.log();
          console.log(HELP);
          console.log();
          rl.prompt();
          return;
        }

        if (input === "/list" || input.startsWith("/list ")) {
          const arg = input.slice(5).trim();
          const limit = Math.max(1, parseInt(arg, 10) || 10);
          console.log();
          const nodes = getRecentNodes(db, limit, segment);
          if (nodes.length === 0) {
            console.log(c.dim("No nodes captured yet."));
          } else {
            for (const node of nodes) {
              console.log(formatNodeLine(node));
            }
          }
          console.log();
          rl.prompt();
          return;
        }

        if (input === "/tags") {
          console.log();
          const counts = getTagCounts(db, segment);
          if (counts.length === 0) {
            console.log(c.dim("No tags yet."));
          } else {
            for (const { tag, count } of counts) {
              console.log(`  ${c.cyan(`"${tag}"`)} ${c.dim(`× ${count}`)}`);
            }
          }
          console.log();
          rl.prompt();
          return;
        }

        if (input === "/search" || input.startsWith("/search ")) {
          const query = input.slice(7).trim();
          console.log();
          if (!query) {
            console.log(c.dim("Usage: /search <query>"));
          } else {
            const results = searchNodes(db, query, 10, segment);
            if (results.length === 0) {
              console.log(c.dim("No matches found."));
            } else {
              for (const node of results) {
                console.log(formatNodeLine(node));
              }
            }
          }
          console.log();
          rl.prompt();
          return;
        }

        if (input.startsWith("/")) {
          console.log();
          console.log(c.dim("Unknown command. Type /help for the list."));
          console.log();
          rl.prompt();
          return;
        }

        rl.pause();
        console.log();
        const spinner = new Spinner();
        const presenter: TurnPresenter = {
          onFirstToken: () => spinner.stop(),
          onContent: (text) => process.stdout.write(text),
          onNodeSaved: (tag) => console.log(savedLine(tag)),
          onNodeError: () => console.log(savedErrorLine()),
        };
        spinner.start("thinking…");
        try {
          await runTurn(session, client, state, input, presenter);
        } finally {
          spinner.stop();
          console.log();
          rl.resume();
          rl.prompt();
        }
      })
      .catch((err: unknown) => {
        console.error(
          "\nError:",
          err instanceof Error ? err.message : String(err),
        );
        rl.resume();
        rl.prompt();
      });
  });

  rl.on("close", () => {
    void turnLock.then(() => {
      session.close();
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

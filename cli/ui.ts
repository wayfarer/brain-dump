import pc from "picocolors";

import type { DumpNode } from "./types.js";

/** Re-exported color helpers so callers do `c.dim(...)`, `c.cyan(...)`. */
export const c = pc;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A minimal single-line spinner. `start` and `stop` are idempotent, so it is
 * safe to `stop()` one that was never started (e.g. in a `finally` safety net).
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private label = "";
  private frame = 0;

  start(label: string): void {
    if (this.timer) return;
    this.label = label;
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
    // Don't keep the event loop alive just for the spinner.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    // Carriage return + clear-to-end-of-line erases the spinner line.
    process.stdout.write("\r\x1b[2K");
  }

  private render(): void {
    process.stdout.write(`\r${pc.cyan(SPINNER_FRAMES[this.frame])} ${pc.dim(this.label)}`);
  }
}

/** Opening banner: bold title with a dim segment suffix. */
export function banner(segment: string): string {
  return `\n${pc.bold("Brain Dump")} ${pc.dim(`· ${segment}`)}\n`;
}

/**
 * The shared `/list` + `/search` line, terminal-width-aware so long content
 * doesn't wrap. Colors: dim quotes/date/dash, cyan tag.
 */
export function formatNodeLine(node: DumpNode): string {
  const datePlain = node.memoryDate ? ` [${node.memoryDate}]` : "";
  const prefixPlain = `  "${node.tag}"${datePlain} — `;
  const columns = process.stdout.columns ?? 80;
  const available = Math.max(20, columns - prefixPlain.length);
  const content =
    node.content.length > available ? node.content.slice(0, available - 3) + "..." : node.content;

  const date = node.memoryDate ? pc.dim(` [${node.memoryDate}]`) : "";
  return `  ${pc.dim('"')}${pc.cyan(node.tag)}${pc.dim('"')}${date} ${pc.dim("—")} ${content}`;
}

/** Confirmation that a memory node was captured. */
export function savedLine(tag: string): string {
  return `  ${pc.green("✓")} ${pc.dim("saved")} ${pc.green(`"${tag}"`)}`;
}

/** Shown when a tool call produced unparseable arguments. */
export function savedErrorLine(): string {
  return `  ${pc.yellow("⚠")} ${pc.dim("could not save a memory (bad data)")}`;
}

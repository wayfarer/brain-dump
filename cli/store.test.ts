// @vitest-environment node
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createFreshRecord, loadRecord, saveRecord } from "./store.js";
import type { DumpRecord } from "./types.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("createFreshRecord", () => {
  it("returns a version-1 record with empty nodes and matching timestamps", () => {
    const record = createFreshRecord();
    expect(record.version).toBe(1);
    expect(record.nodes).toEqual([]);
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it("timestamps are recent numbers", () => {
    const before = Date.now();
    const record = createFreshRecord();
    const after = Date.now();
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("loadRecord", () => {
  it("returns null when the file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(loadRecord()).toBeNull();
  });

  it("returns the parsed record when the file contains valid JSON", () => {
    const sample: DumpRecord = {
      version: 1,
      createdAt: 1000,
      updatedAt: 2000,
      nodes: [
        { id: "abc", timestamp: 1000, tag: "quiet joy", content: "test", depth: 0, parentId: null },
      ],
    };
    mockedExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedReadFileSync as any).mockReturnValue(JSON.stringify(sample));
    expect(loadRecord()).toEqual(sample);
  });

  it("calls process.exit(1) when the file contains invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockedReadFileSync as any).mockReturnValue("not-json{{{");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    expect(() => loadRecord()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("saveRecord", () => {
  it("calls writeFileSync with formatted JSON", () => {
    const record = createFreshRecord();
    saveRecord(record);
    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [, writtenContent, encoding] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    expect(encoding).toBe("utf-8");
    const parsed = JSON.parse(writtenContent);
    expect(parsed.version).toBe(1);
    expect(parsed.nodes).toEqual([]);
  });

  it("mutates record.updatedAt to a new value", () => {
    const record = createFreshRecord();
    const originalUpdatedAt = record.updatedAt;
    vi.useFakeTimers();
    vi.advanceTimersByTime(10);
    saveRecord(record);
    vi.useRealTimers();
    expect(record.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  it("written JSON round-trips to the same record shape", () => {
    const record = createFreshRecord();
    record.nodes.push({
      id: "x1",
      timestamp: 999,
      tag: "fierce belonging",
      content: "the kitchen table",
      depth: 0,
      parentId: null,
    });
    saveRecord(record);
    const [, writtenContent] = mockedWriteFileSync.mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(writtenContent) as DumpRecord;
    expect(parsed.nodes[0].tag).toBe("fierce belonging");
    expect(parsed.nodes[0].content).toBe("the kitchen table");
  });
});

export type MemoryDateGranularity =
  | "decade"
  | "year"
  | "season"
  | "month"
  | "date"
  | "datetime";

export interface DumpNode {
  id: string;
  tag: string;
  content: string;
  parentId: string | null;
  capturedAt: number;
  memoryDate: string | null;
  memoryDateGranularity: MemoryDateGranularity | null;
  segment: string;
  depth: number;
}

export interface DumpRecord {
  version: 2;
  exportedAt: number;
  nodes: DumpNode[];
}

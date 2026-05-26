export interface DumpNode {
  id: string;
  timestamp: number;
  tag: string;
  content: string;
  depth: number;
  parentId: string | null;
}

export interface DumpRecord {
  version: 1;
  createdAt: number;
  updatedAt: number;
  nodes: DumpNode[];
}

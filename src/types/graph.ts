export interface ExperienceNode {
  id: string;
  timestamp: number;
  tag: string;
  magnitude: number;
  depth: number;
  parentId: string | null;
}

export interface ExperienceLink {
  source: string;
  target: string;
}

import { useCallback, useState } from "react";

import type { ExperienceLink, ExperienceNode } from "@/types/graph";

type GraphState = {
  nodes: ExperienceNode[];
  links: ExperienceLink[];
  activeNodeId: string | null;
};

const initialNode: ExperienceNode = {
  id: "root",
  timestamp: Date.now(),
  tag: "Brain Dump",
  magnitude: 100,
  depth: 0,
  parentId: null,
};

function createChildNode(parent: ExperienceNode, index: number): ExperienceNode {
  const magnitude = Math.max(12, Math.round(parent.magnitude * 0.72));

  return {
    id: `${parent.id}-${parent.depth + 1}-${index}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    timestamp: Date.now() + index,
    tag: `Child ${index + 1}`,
    magnitude,
    depth: parent.depth + 1,
    parentId: parent.id,
  };
}

export function useGraphState() {
  const [nodes, setNodes] = useState<ExperienceNode[]>([initialNode]);
  const [links, setLinks] = useState<ExperienceLink[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(initialNode.id);

  const expandNode = useCallback((nodeId: string) => {
    setActiveNodeId(nodeId);

    window.setTimeout(() => {
      setNodes((currentNodes) => {
        const parent = currentNodes.find((node) => node.id === nodeId);

        if (!parent) {
          return currentNodes;
        }

        const childNodes = [0, 1, 2].map((index) => createChildNode(parent, index));

        setLinks((currentLinks) => [
          ...currentLinks,
          ...childNodes.map((child) => ({
            source: parent.id,
            target: child.id,
          })),
        ]);

        return [...currentNodes, ...childNodes];
      });
    }, 150);
  }, []);

  return {
    nodes,
    links,
    activeNodeId,
    expandNode,
  } as const satisfies GraphState & {
    expandNode: (nodeId: string) => void;
  };
}

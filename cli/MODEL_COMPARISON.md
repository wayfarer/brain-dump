# Data Model Comparison: Legacy vs. Proposed

This report compares the existing `ExperienceNode` graph model with the proposed `DumpNode` CLI model, informed by patterns found in comparable tools in the personal knowledge graph and life-logging space.

---

## Reference Landscape

### Tools surveyed

**Obsidian / Roam Research (PKG pattern)**
Nodes are markdown documents; edges are implicit `[[wikilinks]]`. Metadata lives in YAML frontmatter. There is no concept of emotional tagging, no causal directionality on edges, and no first-class notion of "this experience led to that one." The graph is navigational, not narrative.

**Day One / Journey (journaling)**
Entries are timestamped rich-text blobs. No graph structure at all — entries are isolated and retrieved by date or tag. Tags are user-assigned labels, not AI-extracted emotional signatures. There is no edge model.

**Mem.ai (AI-augmented notes)**
Notes are semantically indexed for search and "connection" suggestions, but the underlying model is still flat. The AI surfaces related notes but does not model causality or emotional arc.

**Personal Knowledge Graph (RDF / linked data pattern)**
Nodes are typed entities; edges are typed predicates (e.g., `person:knows`, `event:causedBy`). This is the most structurally expressive model, but it requires the user to explicitly type every relationship — which is incompatible with a conversational capture tool where the user just *talks*.

**Common gap across all of the above:** None of these tools model the *emotional quality* of an experience as a first-class property of the node, and none model causal chains between emotional states as a primary concern. Brain Dump's `tag` field and directed `links` (future) are genuinely novel in this space.

---

## Side-by-Side Comparison

| Dimension | Legacy: `ExperienceNode` (`src/types/graph.ts`) | Proposed: `DumpNode` (`cli/types.ts`) |
|---|---|---|
| **Edge model** | `parentId` only — strict tree, single parent | `parentId` for now; future `links[]` opens to true directed graph (multiple parents, typed edges) |
| **Magnitude / weight** | `magnitude: number` baked into the node | Absent — UI-layer concern, derived by canvas, not stored in the record |
| **Raw content** | Not stored — nodes are purely structural/visual | `content: string` — the actual memory text lives on the node |
| **Session context** | No persistence concept — stateless UI data | `createdAt`/`updatedAt` on the record; `timestamp` per node |
| **Portability** | Tied to React/canvas rendering concerns | Plain JSON — portable across CLI → REST API → web UI |
| **Tag semantics** | `tag: string` — a label for display | `tag: string` — an AI-extracted emotional/experiential signature |
| **Depth tracking** | `depth: number` — for visual layout (radial spacing) | `depth: number` — for interview threading (how deep into a follow-up chain) |

---

## Recommendation

### What the legacy structure should keep

`ExperienceNode` should be **preserved as-is** for the graph canvas UI (`src/components/GraphCanvas.tsx`). Its `magnitude` and `depth` fields serve a visual layout purpose that the interview record has no use for. Changing it would break the canvas rendering logic.

### What should be replaced

`ExperienceNode` should **not** be used as the interview data model. It lacks `content` (the memory text), has no session metadata, and carries rendering concerns that do not belong in a persistent data store. `DumpRecord` + `DumpNode` is the correct model for what the AI captures in conversation.

### The future bridge

When the canvas UI is ready to visualize a real dump, a transform function should convert the interview record into canvas nodes:

```typescript
function toExperienceNode(node: DumpNode, allNodes: DumpNode[]): ExperienceNode {
  const siblingCount = allNodes.filter(n => n.parentId === node.parentId).length;
  return {
    id: node.id,
    timestamp: node.timestamp,
    tag: node.tag,
    magnitude: Math.max(12, Math.round(100 * Math.pow(0.72, node.depth))),
    depth: node.depth,
    parentId: node.parentId,
  };
}
```

`magnitude` is computed from `depth` — matching the decay formula already in `useGraphState.ts` (`parent.magnitude * 0.72`). This keeps the canvas code unchanged while the interview data model evolves independently.

The `links` array in a future `DumpRecord` (for causal/joiner edges between experience tags) will map cleanly to `ExperienceLink[]` in the canvas, since both use `{ source: string; target: string }` shape.

# Thoughts on the Brain Dump schema

The schema is understandable at a conceptual level: one node per captured
response, with a split between interview order (`captured_at`) and life
chronology (`memory_date`). That distinction is the strongest part of the model
because it matches how memory actually works.

What feels clear:

- `tag` gives the record a thematic index without forcing free-text search to do all the work.
- `content` stays as the raw user response, which preserves fidelity.
- `parent_id` and `depth` suggest a branchable interview tree, which fits a guided conversation well.
- `segment` cleanly separates interview contexts like life story, medical history, or project retrospectives.

Items that were previously unclear but are now addressed in the README:

- `depth` is stored at insert time by the caller.
- `memory_date` and `memory_date_granularity` are always null together when no date information was captured.
- `segment` is the interview domain, while `tag` is the per-node thematic lens.
- `datetime` granularity is reserved for imported synthetic data, not interview-created nodes.

Remaining documentation questions:

- The branching policy is still implicit: `parent_id` models follow-up chains, but the README does not yet define how the interviewer chooses whether to continue a branch or begin another.
- The README describes CLI and storage behavior outside `src`, but this note has not verified those implementation files.

My read is that the model is now fairly well specified. The next useful pass is
probably to document interview flow semantics rather than add more schema fields.

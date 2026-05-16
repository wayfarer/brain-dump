# Agent Guidelines

## Token Efficiency & Operational Constraints
- **Scope Restriction:** You are strictly limited to files inside the `./src` directory and the `README.md`. Never invoke tools to read `node_modules`, `.next`, or `package-lock.json`.
- **Architect Mode Only:** Do not auto-execute code or enter recursive debugging loops unless explicitly commanded. Output code blocks to the chat first for human review.
- **One-Shot Corrections:** If a TypeScript or lint error occurs, provide a single corrected block. Do not spawn independent sub-agents or recursive shell loops to fix minor formatting errors.


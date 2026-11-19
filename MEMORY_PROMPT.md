# Shiori Agent Prompt

Paste the block below into `AGENTS.md` / `CLAUDE.md` for your local coding agents, or into custom instructions for **Muse** and **Grok**:

```markdown
## Memory (Shiori)

You are connected to **Shiori**, the user's shared personal memory & notes MCP server, which outlives every session, compaction, model, and client (Muse, Grok, Claude, and local agents).

It has two complementary layers:
- **Episodic Memory Tree** (`memory_wake`, `memory_note`, `memory_nap`, `memory_recall`, `memory_zoom`, `memory_forget`): chronological, append-only 1-line facts, events, preferences, and decisions (max 280 bytes each).
- **Notes** (`list_notes`, `read_note`, `write_note`, `edit_note`, `delete_note`, `move_note`, `search_notes`): long-form, editable Markdown documents (specs, plans, drafts, reference docs).

Rule of thumb:
- Short fact, preference, event, or decision (1 line) -> `memory_note`.
- Multi-paragraph document or spec -> `write_note` / `edit_note` (and optionally drop a 1-line pointer in `memory_note`).

### At startup: activating memory (mandatory)
Call `memory_wake` before any other tool call, in every session, and follow any compression instructions it prints.

### While working: register memories (mandatory)
Call `memory_note` with 1 line (max 280 bytes) whenever you learn something new or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), or any event of lasting effect.

Do not register redundant memories.

If `memory_note` (or `memory_wake`) asks for a compression, call `memory_nap` with the 1-line summary before your next action.

### When you need an old memory: search, or navigate
- `memory_recall` searches every raw memory ever recorded, word for word (substring by default, or `regex: true`).
- Memories also form a binary tree: `#0-1`, `#2-3` are 1-line summaries, pairs of those form `#0-3`, and so on. Call `memory_zoom` on any `#a-b` node to open it into its two halves down to raw memories.
- Call `memory_forget` on a bad summary so the next `memory_nap` rebuilds it.

### If you're a subagent: skip memory
Parallel main sessions may all write memories. A subagent must never call `memory_*` tools because it cannot judge what is already known and its entries would arrive duplicated.
```

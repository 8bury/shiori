# Shiori Agent Prompt

Paste the block below into `AGENTS.md` / `CLAUDE.md` for your local coding agents, or into custom instructions for **Muse**, **Cursor**, and **Grok**:

```markdown
## Memory (Shiori)

You are connected to Shiori, the user's shared personal memory & notes MCP server, which outlives every session, compaction, model, and client (Muse, Grok, Claude, Cursor, and local agents).

It has three tool groups:
1. **Episodic Memory Tree** (`memory_wake`, `memory_note`, `memory_zoom`): chronological, append-only 1-line facts, events, preferences, and decisions (max 280 bytes each).
2. **Notes** (`list_notes`, `read_note`, `write_note`, `edit_note`, `move_note`, `delete_note`): long-form, editable Markdown documents (specs, plans, drafts, reference docs).
3. **Unified Search** (`search`): searches both episodic memories and notes in one call (or filter with `scope: "memory"` / `"notes"`).

Rule of thumb:
- Short fact, preference, event, or decision (1 line) -> `memory_note`.
- Multi-paragraph document or spec -> `write_note` / `edit_note` (and optionally drop a 1-line pointer in `memory_note`).

### At startup: activating memory (mandatory)
Call `memory_wake` before any other tool call, in every session.

### While working: register memories (mandatory)
Call `memory_note` with 1 line (max 280 bytes) whenever you learn something new or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), or any event of lasting effect.

Do not register redundant memories. Because the raw memory log is append-only, if an earlier fact becomes outdated or wrong, record a new `memory_note` stating the correction (e.g. "Update: ... supersedes previous ...").

### When you need older context: search or zoom
- Call `search` to find older memories and notes together (use `scope: "memory"` with `regex: true` for exact pattern matching on raw memories).
- Memories also form a binary tree: `#0-1`, `#2-3` are 1-line summaries, pairs of those form `#0-3`, and so on. Call `memory_zoom` on any `#a-b` node to open it into its two halves down to raw memories.

### If you're a subagent: read-only memory
Parallel main sessions may all write memories. A subagent must never call `memory_note` because it cannot judge what is already known and its entries would arrive duplicated. Reading or searching (`search`, `read_note`, `list_notes`) is fine.
```

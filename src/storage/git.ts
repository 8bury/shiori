import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { NotesSource } from "../indexer/types.js";
import { ZERO_SHA } from "../indexer/types.js";
import type { NoteSha, ReconcileDeps } from "../reconcile/types.js";
import type { Change, PushOutcome, WorkingCopy } from "../writer/types.js";

const execFile = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function ensureGitRepo(notesDir: string, authorName: string, authorEmail: string, remoteUrl?: string): Promise<void> {
  fs.mkdirSync(notesDir, { recursive: true });
  if (!fs.existsSync(path.join(notesDir, ".git"))) {
    await git(notesDir, ["init", "-b", "main"]);
  }
  await git(notesDir, ["config", "user.name", authorName]);
  await git(notesDir, ["config", "user.email", authorEmail]);
  if (remoteUrl) {
    const existing = await gitOk(notesDir, ["remote", "get-url", "origin"]);
    if (existing === null) {
      await git(notesDir, ["remote", "add", "origin", remoteUrl]);
    } else if (existing.trim() !== remoteUrl) {
      await git(notesDir, ["remote", "set-url", "origin", remoteUrl]);
    }
  }
}

export class LocalGitWorkingCopy implements WorkingCopy {
  private initialized = false;

  constructor(
    private readonly dir: string,
    private readonly authorName = "Second Brain",
    private readonly authorEmail = "brain@localhost",
    private readonly remoteUrl = "",
  ) {}

  ready(): boolean {
    return this.initialized;
  }

  drop(): void {
    this.initialized = false;
  }

  async sync(): Promise<string> {
    await ensureGitRepo(this.dir, this.authorName, this.authorEmail, this.remoteUrl);
    if (this.remoteUrl) {
      const fetched = await gitOk(this.dir, ["fetch", "origin", "main"]);
      if (fetched !== null) {
        const remoteTip = await gitOk(this.dir, ["rev-parse", "--verify", "origin/main"]);
        if (remoteTip) {
          await git(this.dir, ["checkout", "-B", "main", "origin/main"]);
        }
      }
    }
    this.initialized = true;
    const head = await gitOk(this.dir, ["rev-parse", "--verify", "refs/heads/main"]);
    return head ? head.trim() : ZERO_SHA;
  }

  async read(notePath: string): Promise<string | null> {
    const full = path.join(this.dir, notePath);
    try {
      return await fs.promises.readFile(full, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async caseTwin(notePath: string): Promise<string | null> {
    const lower = notePath.toLowerCase();
    const files = await this.listFiles();
    for (const f of files) {
      if (f !== notePath && f.toLowerCase() === lower) return f;
    }
    return null;
  }

  async commit(changes: Change[], message: string): Promise<string> {
    for (const c of changes) {
      const full = path.join(this.dir, c.path);
      if (c.content === null) {
        await fs.promises.rm(full, { force: true });
        await this.pruneEmptyParents(path.dirname(full));
      } else {
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, c.content, "utf8");
      }
    }
    await git(this.dir, ["add", "-A", "--", ...changes.map((c) => c.path)]);
    const status = await git(this.dir, ["status", "--porcelain"]);
    if (!status.trim()) {
      const head = await gitOk(this.dir, ["rev-parse", "--verify", "refs/heads/main"]);
      if (head) return head.trim();
    }
    await git(this.dir, ["commit", "--allow-empty", "-m", message]);
    return (await git(this.dir, ["rev-parse", "HEAD"])).trim();
  }

  async push(): Promise<PushOutcome> {
    if (!this.remoteUrl) return "ok";
    try {
      await git(this.dir, ["push", "origin", "main"]);
      return "ok";
    } catch (e: any) {
      const stderr = String(e?.stderr ?? e?.message ?? "");
      if (/non-fast-forward|fetch first|rejected/i.test(stderr)) return "rejected";
      throw e;
    }
  }

  async contains(commit: string): Promise<boolean> {
    const res = await gitOk(this.dir, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return res !== null;
  }

  private async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      const abs = rel ? path.join(this.dir, rel) : this.dir;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(childRel);
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push(childRel);
      }
    };
    await walk("");
    return out.sort();
  }

  private async pruneEmptyParents(dir: string) {
    let cur = dir;
    while (cur !== this.dir && cur.startsWith(this.dir)) {
      try {
        const entries = await fs.promises.readdir(cur);
        if (entries.length > 0) break;
        await fs.promises.rmdir(cur);
        cur = path.dirname(cur);
      } catch {
        break;
      }
    }
  }
}

export class LocalGitNotesSource implements NotesSource {
  constructor(private readonly dir: string) {}

  async head(): Promise<string | null> {
    const out = await gitOk(this.dir, ["rev-parse", "--verify", "refs/heads/main"]);
    return out ? out.trim() : null;
  }

  async shaAt(notePath: string, commit: string): Promise<string | null> {
    const out = await gitOk(this.dir, ["ls-tree", commit, "--", notePath]);
    if (!out) return null;
    const line = out.trim().split("\n")[0];
    if (!line) return null;
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t/);
    return match ? match[1] : null;
  }

  async noteAt(notePath: string, commit: string): Promise<{ sha: string; content: string } | null> {
    const sha = await this.shaAt(notePath, commit);
    if (!sha) return null;
    const content = await gitOk(this.dir, ["cat-file", "-p", sha]);
    if (content === null) return null;
    return { sha, content };
  }

  async changedPaths(before: string, after: string): Promise<string[]> {
    if (before === ZERO_SHA) {
      const notes = await this.allNotes(after);
      return notes.map((n) => n.path);
    }
    const out = await gitOk(this.dir, ["diff", "--name-only", before, after]);
    if (!out) return [];
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.endsWith(".md"))
      .sort();
  }

  async allNotes(commit: string): Promise<NoteSha[]> {
    const out = await gitOk(this.dir, ["ls-tree", "-r", "--full-tree", commit]);
    if (!out) return [];
    const results: NoteSha[] = [];
    for (const line of out.split("\n")) {
      const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
      if (match && match[2].endsWith(".md")) {
        results.push({ path: match[2], sha: match[1] });
      }
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listNotes(prefix = ""): Promise<string[]> {
    const head = await this.head();
    if (!head) return [];
    const all = await this.allNotes(head);
    const paths = all.map((n) => n.path);
    return prefix ? paths.filter((p) => p.startsWith(prefix)) : paths;
  }

  async readNote(notePath: string): Promise<string | null> {
    const head = await this.head();
    if (!head) return null;
    const note = await this.noteAt(notePath, head);
    return note ? note.content : null;
  }
}

export function createReconcileSource(source: LocalGitNotesSource): ReconcileDeps["source"] {
  return {
    head: () => source.head(),
    allNotes: (commit) => source.allNotes(commit),
    changedPaths: (before, after) => source.changedPaths(before, after),
  };
}

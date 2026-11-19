import path from "node:path";

export type EmbeddingProvider = "openai" | "gemini" | "none";

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  notesDir: string;
  dbPath: string;
  publicUrl: string;
  brainName: string;
  ideasDir: string;
  timezone: string;
  memoryWakeLines: number;
  githubClientId: string;
  githubClientSecret: string;
  ownerGithubId: string;
  adminSecret: string;
  allowedRedirectPrefixes: string[];
  allowAllHttpsRedirects: boolean;
  embeddingProvider: EmbeddingProvider;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  gitRemoteUrl: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export const DEFAULT_ALLOWED_REDIRECT_PREFIXES = [
  "https://claude.ai/api/mcp/",
  "https://claude.com/api/mcp/",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chat.openai.com/connector_platform_oauth_redirect",
];

function detectEmbeddingProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  const explicit = env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (explicit === "openai" || explicit === "gemini" || explicit === "none") return explicit;
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  if (env.GEMINI_API_KEY?.trim()) return "gemini";
  return "none";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR?.trim() || "./data");
  const embeddingProvider = detectEmbeddingProvider(env);
  const embeddingApiKey =
    env.EMBEDDING_API_KEY?.trim() ||
    (embeddingProvider === "openai" ? env.OPENAI_API_KEY?.trim() : embeddingProvider === "gemini" ? env.GEMINI_API_KEY?.trim() : "") ||
    "";
  const defaultModel = embeddingProvider === "gemini" ? "gemini-embedding-001" : "text-embedding-3-small";

  const extraRedirects = (env.ALLOWED_REDIRECT_PREFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: Number(env.PORT || 3000),
    host: env.HOST?.trim() || "0.0.0.0",
    dataDir,
    notesDir: path.join(dataDir, "notes"),
    dbPath: path.join(dataDir, "brain.db"),
    publicUrl: (env.PUBLIC_URL?.trim() || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ""),
    brainName: env.BRAIN_NAME?.trim() || "second-brain",
    ideasDir: (env.IDEAS_DIR?.trim() || "ideas").replace(/^\/+|\/+$/g, ""),
    timezone: env.TIMEZONE?.trim() || "America/Sao_Paulo",
    memoryWakeLines: Math.max(8, Number(env.MEMORY_WAKE_LINES || 96) || 96),
    githubClientId: env.GITHUB_CLIENT_ID?.trim() || "",
    githubClientSecret: env.GITHUB_CLIENT_SECRET?.trim() || "",
    ownerGithubId: env.OWNER_GITHUB_ID?.trim() || "",
    adminSecret: env.ADMIN_SECRET?.trim() || "",
    allowedRedirectPrefixes: [...new Set([...DEFAULT_ALLOWED_REDIRECT_PREFIXES, ...extraRedirects])],
    allowAllHttpsRedirects: env.ALLOW_ALL_HTTPS_REDIRECTS?.trim().toLowerCase() === "true",
    embeddingProvider,
    embeddingApiKey,
    embeddingModel: env.EMBEDDING_MODEL?.trim() || defaultModel,
    embeddingBaseUrl: (env.EMBEDDING_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    gitRemoteUrl: env.GIT_REMOTE_URL?.trim() || "",
    gitAuthorName: env.GIT_AUTHOR_NAME?.trim() || "Second Brain",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL?.trim() || "brain@localhost",
  };
}

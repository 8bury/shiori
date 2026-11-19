import type { AppConfig } from "../config.js";
import type { Embedder } from "../indexer/types.js";

export class OpenAiEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.fetcher(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI embeddings failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`OpenAI embeddings returned ${data.length} vectors for ${texts.length} inputs`);
    }
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export class GeminiEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents`;
    const res = await this.fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini embeddings failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings?: { values: number[] }[] };
    const embeddings = json.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(`Gemini embeddings returned ${embeddings.length} vectors for ${texts.length} inputs`);
    }
    return embeddings.map((e) => e.values);
  }
}

export class DisabledEmbedder implements Embedder {
  readonly disabled = true;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

export function createEmbedder(config: Pick<AppConfig, "embeddingProvider" | "embeddingApiKey" | "embeddingModel" | "embeddingBaseUrl">): Embedder & { disabled?: boolean } {
  if (config.embeddingProvider === "none" || !config.embeddingApiKey) {
    return new DisabledEmbedder();
  }
  if (config.embeddingProvider === "gemini") {
    return new GeminiEmbedder(config.embeddingApiKey, config.embeddingModel);
  }
  return new OpenAiEmbedder(config.embeddingApiKey, config.embeddingModel, config.embeddingBaseUrl);
}

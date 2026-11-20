import type { AppConfig } from "../config.js";
import { byteLength, cleanOneLine, MAX_MEMORY_BYTES } from "./tree.js";

export interface MemorySummarizer {
  readonly disabled?: boolean;
  summarize(left: string, right: string): Promise<string>;
}

const SYSTEM_PROMPT = [
  "You compress two episodic memory entries into ONE concise single-line summary.",
  `Strict limit: at most ${MAX_MEMORY_BYTES} UTF-8 bytes (aim for <= 240 bytes).`,
  "Preserve key facts, names, dates, decisions, and preferences.",
  "Use the same language as the inputs. Output plain text only: no quotes, no bullet points, no markdown, no prefixes like '#0-1'.",
].join(" ");

function buildUserPrompt(left: string, right: string): string {
  return `Combine these two memories into one concise line (<= ${MAX_MEMORY_BYTES} bytes):\nleft: ${left}\nright: ${right}`;
}

/** Cleans and safely truncates a summary to fit within MAX_MEMORY_BYTES UTF-8 bytes. */
export function fitSummary(raw: string): string {
  let cleaned = cleanOneLine(raw).replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!cleaned) return "";
  if (byteLength(cleaned) <= MAX_MEMORY_BYTES) return cleaned;
  const suffix = "...";
  const maxContentBytes = MAX_MEMORY_BYTES - byteLength(suffix);
  let out = "";
  for (const ch of cleaned) {
    if (byteLength(out + ch) > maxContentBytes) break;
    out += ch;
  }
  return out.trimEnd() + suffix;
}

export class GeminiSummarizer implements MemorySummarizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async summarize(left: string, right: string): Promise<string> {
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;
    const res = await this.fetcher(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: buildUserPrompt(left, right) }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 120,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini summary failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(" ") ?? "";
    const fitted = fitSummary(text);
    if (!fitted) throw new Error("Gemini summary returned empty text");
    return fitted;
  }
}

export class OpenAiSummarizer implements MemorySummarizer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async summarize(left: string, right: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(left, right) },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI-compatible summary failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    const fitted = fitSummary(text);
    if (!fitted) throw new Error("OpenAI-compatible summary returned empty text");
    return fitted;
  }
}

export class DisabledSummarizer implements MemorySummarizer {
  readonly disabled = true;
  async summarize(): Promise<string> {
    throw new Error("Memory summarizer is disabled");
  }
}

export function createSummarizer(
  config: Pick<AppConfig, "memorySummaryProvider" | "memorySummaryApiKey" | "memorySummaryModel" | "memorySummaryBaseUrl">,
  fetcher: typeof fetch = fetch,
): MemorySummarizer {
  if (config.memorySummaryProvider === "none") {
    return new DisabledSummarizer();
  }
  if (config.memorySummaryProvider === "gemini") {
    if (!config.memorySummaryApiKey) return new DisabledSummarizer();
    return new GeminiSummarizer(config.memorySummaryApiKey, config.memorySummaryModel, fetcher);
  }
  // OpenAI-compatible: allow missing API key only when a custom base URL (e.g. Ollama) is used
  const isDefaultOpenAi = config.memorySummaryBaseUrl === "https://api.openai.com/v1";
  if (isDefaultOpenAi && !config.memorySummaryApiKey) {
    return new DisabledSummarizer();
  }
  return new OpenAiSummarizer(config.memorySummaryApiKey, config.memorySummaryModel, config.memorySummaryBaseUrl, fetcher);
}

import http from "node:http";
import { Readable } from "node:stream";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const DAILY_MS = 24 * 60 * 60 * 1000;

function toWebRequest(req: http.IncomingMessage, publicUrl: string): Request {
  const base = new URL(publicUrl);
  const url = new URL(req.url ?? "/", `${base.protocol}//${req.headers.host ?? base.host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as unknown as RequestInit["body"], duplex: "half" } : {}),
  };
  return new Request(url, init);
}

async function sendWebResponse(res: http.ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length) res.setHeader("set-cookie", setCookies);

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } finally {
    res.end();
  }
}

async function main() {
  const config = loadConfig();
  const app = await createApp(config);

  const server = http.createServer(async (req, res) => {
    try {
      const webReq = toWebRequest(req, config.publicUrl);
      const webRes = await app.fetch(webReq);
      await sendWebResponse(res, webRes);
    } catch (e) {
      console.error(JSON.stringify({ httpError: String(e) }));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end("Internal server error");
    }
  });

  // Daily maintenance: reconcile index + purge expired OAuth grants/tokens
  const dailyTimer = setInterval(async () => {
    try {
      const purged = app.purgeExpired();
      const report = await app.reconcile("daily");
      console.log(JSON.stringify({ dailyMaintenance: { purged, report } }));
    } catch (e) {
      console.error(JSON.stringify({ dailyMaintenanceFailed: String(e) }));
    }
  }, DAILY_MS);
  dailyTimer.unref?.();

  const shutdown = async () => {
    clearInterval(dailyTimer);
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        started: true,
        host: config.host,
        port: config.port,
        publicUrl: config.publicUrl,
        dataDir: config.dataDir,
        embeddingProvider: config.embeddingProvider,
      }),
    );
  });
}

void main();

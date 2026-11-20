import http from "node:http";
import { Readable } from "node:stream";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const DAILY_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 8_000;

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
  const onClose = () => {
    void reader.cancel().catch(() => {});
  };
  res.on("close", onClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || res.destroyed || res.writableEnded) break;
      if (value) {
        const ok = res.write(value);
        if (!ok) {
          await new Promise<void>((resolve) => {
            res.once("drain", resolve);
            res.once("close", resolve);
          });
        }
      }
    }
  } catch {
    // Client disconnected or stream aborted
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
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
      if (!res.writableEnded) res.end("Internal server error");
    }
  });

  // Daily maintenance: reconcile index + purge expired OAuth grants/tokens/clients + compact any pending memory merges
  const dailyTimer = setInterval(async () => {
    try {
      const purged = app.purgeExpired();
      const report = await app.reconcile("daily");
      app.compactor.trigger();
      console.log(JSON.stringify({ dailyMaintenance: { purged, report } }));
    } catch (e) {
      console.error(JSON.stringify({ dailyMaintenanceFailed: String(e) }));
    }
  }, DAILY_MS);
  dailyTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(dailyTimer);

    const forceExit = setTimeout(() => {
      console.error(JSON.stringify({ shutdown: "timed out, forcing exit" }));
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref?.();

    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (e) {
      console.error(JSON.stringify({ shutdownError: String(e) }));
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        started: true,
        host: config.host,
        port: config.port,
        publicUrl: config.publicUrl,
        dataDir: config.dataDir,
        embeddingProvider: config.embeddingProvider,
        memorySummaryProvider: config.memorySummaryProvider,
      }),
    );
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ startupFatal: String(e) }));
  process.exit(1);
});

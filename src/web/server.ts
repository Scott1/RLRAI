import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuestion } from "../chat";
import { getConfig } from "../config";
import { createOpenAIClient } from "../openai";
import type { ChatMessage } from "../types";

interface ChatRequest {
  sessionId?: string;
  question?: string;
}

const config = getConfig();
const client = createOpenAIClient(config.apiKey);
const histories = new Map<string, ChatMessage[]>();
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = parsePort(process.env.PORT ?? process.env.RLR_WEB_PORT);
const host = process.env.RLR_WEB_HOST ?? "127.0.0.1";

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { error: "Missing request URL." });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, {
        model: config.model,
        vectorStoreIds: config.vectorStoreIds,
        retrievalMaxResults: config.retrievalMaxResults
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reset") {
      const body = await readJson<ChatRequest>(request);
      if (body.sessionId) {
        histories.delete(body.sessionId);
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[web] ${request.method ?? "UNKNOWN"} ${request.url ?? ""} failed: ${message}`);
    if (error instanceof Error) {
      console.error(error.stack);
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause) {
        console.error("[web] cause:", cause);
      }
    }
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Real Love Ready Companion web UI running at http://${host}:${port}`);
});

async function handleChat(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const body = await readJson<ChatRequest>(request);
  const sessionId = body.sessionId?.trim() || crypto.randomUUID();
  const question = body.question?.trim();

  if (!question) {
    sendJson(response, 400, { error: "Question is required." });
    return;
  }

  const history = histories.get(sessionId) ?? [];
  const answer = await answerQuestion({ client, config, history, question });

  history.push({ role: "user", content: question });
  history.push({ role: "assistant", content: answer.answer });
  histories.set(sessionId, history.slice(-12));

  sendJson(response, 200, {
    sessionId,
    answer: answer.answer,
    insufficientEvidence: answer.insufficientEvidence,
    safetyCategory: answer.safetyCategory,
    sources: answer.sources.map((source) => ({
      key: source.key,
      id: source.metadata.id,
      title: source.metadata.title,
      type: source.metadata.type,
      sourceUrl: source.metadata.source_url,
      score: source.score
    }))
  });
}

async function serveStatic(urlPath: string, response: http.ServerResponse): Promise<void> {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  return "text/html; charset=utf-8";
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

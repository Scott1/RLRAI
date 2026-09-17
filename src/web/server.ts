import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_COOKIE_NAME,
  authenticatePreviewAccount,
  createSessionCookie,
  getAuthenticatedUsername,
  getPreviewAuthConfig,
  normalizeUsername
} from "./auth";
import { answerQuestion } from "../chat";
import { getConfig } from "../config";
import { createOpenAIClient } from "../openai";
import type { ChatMessage } from "../types";

interface ChatRequest {
  sessionId?: string;
  question?: string;
}

const config = getConfig();
const authConfig = getPreviewAuthConfig();
const client = createOpenAIClient(config.apiKey);
const histories = new Map<string, ChatMessage[]>();
const passwordLoginAttempts = new Map<string, number[]>();
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

    if (request.method === "GET" && url.pathname === "/login") {
      sendHtml(response, 200, loginPage());
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      await handlePasswordLogin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      response.writeHead(303, {
        "Cache-Control": "no-store",
        Location: "/login",
        "Set-Cookie": `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;`
      });
      response.end();
      return;
    }

    if (!getAuthenticatedUsername(request.headers.cookie, authConfig)) {
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 401, { error: "Sign in is required." });
      } else {
        redirect(response, "/login");
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, {
        authMode: authConfig.mode,
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
    const httpError = error instanceof HttpError ? error : undefined;
    if (!httpError) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[web] ${request.method ?? "UNKNOWN"} ${request.url ?? ""} failed: ${message}`);
      if (error instanceof Error) {
        console.error(error.stack);
      }
    }
    sendJson(response, httpError?.status ?? 500, { error: httpError?.message ?? "The companion could not complete that request." });
  }
});

server.listen(port, host, () => {
  console.log(`Real Love Ready Companion web UI running at http://${host}:${port}`);
});

async function handlePasswordLogin(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (authConfig.mode === "off") {
    redirect(response, "/");
    return;
  }

  const form = await readForm(request);
  const username = normalizeUsername(form.username) ?? "unknown";
  const account = canAttemptPasswordLogin(request, username)
    ? authenticatePreviewAccount(authConfig, form.username, form.password)
    : undefined;

  if (!account) {
    sendHtml(response, 401, loginPage("That username or password did not match. Please try again."));
    return;
  }

  response.writeHead(303, {
    "Cache-Control": "no-store",
    Location: "/",
    "Set-Cookie": createSessionCookie(authConfig, account)
  });
  response.end();
}

function canAttemptPasswordLogin(request: http.IncomingMessage, username: string): boolean {
  const key = `${request.socket.remoteAddress ?? "unknown"}:${username}`;
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const attempts = (passwordLoginAttempts.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
  if (attempts.length >= 5) {
    passwordLoginAttempts.set(key, attempts);
    return false;
  }
  attempts.push(now);
  passwordLoginAttempts.set(key, attempts);
  return true;
}

async function handleChat(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const body = await readJson<ChatRequest>(request);
  const sessionId = body.sessionId?.trim() || crypto.randomUUID();
  const question = body.question?.trim();

  if (!question) {
    throw new HttpError(400, "Question is required.");
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
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "X-Content-Type-Options": "nosniff"
    });
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
  const raw = await readBody(request);
  if (!raw) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

async function readForm(request: http.IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(request, 8 * 1024);
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readBody(request: http.IncomingMessage, maximumBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(303, { "Cache-Control": "no-store", Location: location });
  response.end();
}

function sendHtml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function loginPage(message?: string): string {
  if (authConfig.mode === "off") {
    return page("Preview access is not enabled", "This local companion does not require a sign-in.", "Open companion", "/");
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in | Real Love Ready Companion</title><style>${authStyles()}</style></head>
<body><main><p class="eyebrow">Real Love Ready</p><h1>Companion preview</h1><p class="intro">Sign in with the reviewer account you were given.</p>${message ? `<p class="form-message" role="alert">${message}</p>` : ""}<form method="post" action="/auth/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form><p class="fine-print">This preview is for invited reviewers only.</p></main></body></html>`;
}

function page(title: string, body: string, action: string, href: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Real Love Ready Companion</title><style>${authStyles()}</style></head>
<body><main><p class="eyebrow">Real Love Ready</p><h1>${title}</h1><p class="intro">${body}</p><a class="button" href="${href}">${action}</a></main></body></html>`;
}

function authStyles(): string {
  return `:root{color-scheme:light}*{box-sizing:border-box}body{min-width:320px;margin:0;background:#fcf8f2;color:#302824;font-family:Inter,ui-sans-serif,system-ui,sans-serif}main{width:min(100% - 40px,480px);margin:12vh auto;padding:32px;border:1px solid #e7dbcf;border-radius:8px;background:#fffdfa;box-shadow:0 12px 28px rgba(67,46,34,.06)}.eyebrow{margin:0 0 10px;color:#934f48;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:32px;font-weight:600;line-height:1.15}.intro{margin:16px 0 24px;color:#756961;line-height:1.55}label{display:block;margin:16px 0 7px;font-size:14px;font-weight:700}input{width:100%;padding:11px;border:1px solid #d8c9bd;border-radius:6px;background:#fff;color:#302824;font:inherit}input:focus{outline:2px solid #934f48;outline-offset:2px}button,.button{display:inline-block;margin-top:20px;padding:10px 14px;border:1px solid #934f48;border-radius:6px;background:#934f48;color:#fff;font:inherit;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer}.form-message{margin:0 0 16px;padding:10px;border-left:2px solid #9d4e45;background:#fff5f2;color:#9d4e45;font-size:14px;line-height:1.45}.fine-print{margin:20px 0 0;color:#756961;font-size:12px;line-height:1.45}@media(max-width:500px){main{margin:40px auto;padding:24px}h1{font-size:28px}}`;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

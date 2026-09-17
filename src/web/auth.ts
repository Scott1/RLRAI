import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "rlr-preview-session";

const sessionDurationSeconds = 60 * 60 * 24 * 7;

interface AuthTokenPayload {
  accountFingerprint: string;
  exp: number;
  purpose: "session";
  username: string;
}

export interface PreviewAccount {
  password: string;
  username: string;
}

export interface PreviewAuthConfig {
  accounts: Map<string, PreviewAccount>;
  mode: "off" | "password";
  secret?: string;
  secureCookies: boolean;
}

export function getPreviewAuthConfig(environment = process.env): PreviewAuthConfig {
  const rawMode = environment.RLR_AUTH_MODE ?? (environment.NODE_ENV === "production" ? "password" : "off");
  if (rawMode !== "off" && rawMode !== "password") {
    throw new Error("RLR_AUTH_MODE must be either 'off' or 'password'.");
  }

  const secureCookies = environment.RLR_AUTH_SECURE_COOKIES === "true";
  if (rawMode === "off") {
    return { accounts: new Map(), mode: "off", secureCookies };
  }

  const accounts = parsePreviewAccounts(environment.RLR_PREVIEW_ACCOUNTS);
  const secret = environment.RLR_AUTH_SECRET;
  if (accounts.size === 0 || !secret) {
    throw new Error("Password preview access requires RLR_PREVIEW_ACCOUNTS and RLR_AUTH_SECRET.");
  }

  return { accounts, mode: "password", secret, secureCookies };
}

export function normalizeUsername(value: string | undefined): string | undefined {
  const username = value?.trim().toLowerCase();
  return username && /^[^\s;|]{3,128}$/.test(username) ? username : undefined;
}

export function authenticatePreviewAccount(config: PreviewAuthConfig, usernameValue: string | undefined, password: string | undefined): PreviewAccount | undefined {
  if (config.mode === "off") {
    return undefined;
  }
  const username = normalizeUsername(usernameValue);
  const account = username ? config.accounts.get(username) : undefined;
  if (!account || !password || !safeEqual(password, account.password)) {
    return undefined;
  }
  return account;
}

export function createSessionCookie(config: PreviewAuthConfig, account: PreviewAccount): string {
  if (!config.secret) {
    throw new Error("Password preview access is not configured.");
  }

  const token = createSignedToken({
    accountFingerprint: fingerprint(config.secret, account),
    exp: expiresIn(sessionDurationSeconds),
    purpose: "session",
    username: account.username
  }, config.secret);
  const secure = config.secureCookies ? " Secure;" : "";
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationSeconds};${secure}`;
}

export function getAuthenticatedUsername(cookieHeader: string | undefined, config: PreviewAuthConfig): string | undefined {
  if (config.mode === "off") {
    return "local";
  }
  if (!config.secret) {
    return undefined;
  }

  const token = readCookie(cookieHeader, AUTH_COOKIE_NAME);
  const payload = token ? verifySignedToken(token, config.secret) : undefined;
  const account = payload ? config.accounts.get(payload.username) : undefined;
  if (!payload || !account || !safeEqual(payload.accountFingerprint, fingerprint(config.secret, account))) {
    return undefined;
  }
  return payload.username;
}

export function createSignedToken(payload: AuthTokenPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifySignedToken(token: string, secret: string): AuthTokenPayload | undefined {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature || !safeEqual(signature, sign(encodedPayload, secret))) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AuthTokenPayload;
    if (!normalizeUsername(payload.username) || !Number.isInteger(payload.exp) || payload.exp <= currentTime() || payload.purpose !== "session" || !payload.accountFingerprint) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function parsePreviewAccounts(value: string | undefined): Map<string, PreviewAccount> {
  const accounts = new Map<string, PreviewAccount>();
  for (const entry of (value ?? "").split(";")) {
    const separator = entry.indexOf("|");
    if (separator < 0) {
      continue;
    }
    const username = normalizeUsername(entry.slice(0, separator));
    const password = entry.slice(separator + 1);
    if (!username || password.length < 12 || accounts.has(username)) {
      throw new Error("Each RLR_PREVIEW_ACCOUNTS entry must be a unique username and a password of at least 12 characters.");
    }
    accounts.set(username, { username, password });
  }
  return accounts;
}

function fingerprint(secret: string, account: PreviewAccount): string {
  return createHmac("sha256", secret).update(`${account.username}:${account.password}`).digest("base64url");
}

function expiresIn(seconds: number): number {
  return currentTime() + seconds;
}

function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

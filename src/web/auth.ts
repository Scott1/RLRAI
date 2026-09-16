import { createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "rlr-preview-session";

const sessionDurationSeconds = 60 * 60 * 24 * 7;
const magicLinkDurationSeconds = 60 * 15;

interface AuthTokenPayload {
  email: string;
  exp: number;
  purpose: "magic-link" | "session";
}

export interface PreviewAuthConfig {
  allowedEmails: Set<string>;
  mode: "off" | "email";
  publicBaseUrl?: string;
  resendApiKey?: string;
  resendFrom?: string;
  secret?: string;
}

export function getPreviewAuthConfig(environment = process.env): PreviewAuthConfig {
  const rawMode = environment.RLR_AUTH_MODE ?? (environment.NODE_ENV === "production" ? "email" : "off");
  if (rawMode !== "off" && rawMode !== "email") {
    throw new Error("RLR_AUTH_MODE must be either 'off' or 'email'.");
  }

  if (rawMode === "off") {
    return { allowedEmails: new Set(), mode: "off" };
  }

  const allowedEmails = new Set(
    (environment.RLR_ALLOWED_EMAILS ?? "")
      .split(/[;,]/)
      .map(normalizeEmail)
      .filter((email): email is string => Boolean(email))
  );
  const secret = environment.RLR_AUTH_SECRET;
  const publicBaseUrl = normalizePublicBaseUrl(environment.RLR_PUBLIC_BASE_URL);
  const resendApiKey = environment.RESEND_API_KEY;
  const resendFrom = environment.RLR_EMAIL_FROM;

  if (allowedEmails.size === 0 || !secret || !publicBaseUrl || !resendApiKey || !resendFrom) {
    throw new Error("Email preview access requires RLR_ALLOWED_EMAILS, RLR_AUTH_SECRET, RLR_PUBLIC_BASE_URL, RESEND_API_KEY, and RLR_EMAIL_FROM.");
  }

  return { allowedEmails, mode: "email", publicBaseUrl, resendApiKey, resendFrom, secret };
}

export function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export function createMagicLink(config: PreviewAuthConfig, email: string): string {
  if (!config.secret || !config.publicBaseUrl) {
    throw new Error("Email preview access is not configured.");
  }

  const token = createSignedToken({ email, exp: expiresIn(magicLinkDurationSeconds), purpose: "magic-link" }, config.secret);
  const url = new URL("/auth/verify", config.publicBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function createSessionCookie(config: PreviewAuthConfig, email: string): string {
  if (!config.secret) {
    throw new Error("Email preview access is not configured.");
  }

  const token = createSignedToken({ email, exp: expiresIn(sessionDurationSeconds), purpose: "session" }, config.secret);
  const secure = config.publicBaseUrl?.startsWith("https://") ? " Secure;" : "";
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationSeconds};${secure}`;
}

export function getAuthenticatedEmail(cookieHeader: string | undefined, config: PreviewAuthConfig): string | undefined {
  if (config.mode === "off") {
    return "local";
  }
  if (!config.secret) {
    return undefined;
  }

  const token = readCookie(cookieHeader, AUTH_COOKIE_NAME);
  const payload = token ? verifySignedToken(token, config.secret) : undefined;
  if (!payload || payload.purpose !== "session" || !config.allowedEmails.has(payload.email)) {
    return undefined;
  }
  return payload.email;
}

export async function sendMagicLink(config: PreviewAuthConfig, email: string): Promise<void> {
  if (!config.resendApiKey || !config.resendFrom) {
    throw new Error("Resend is not configured.");
  }

  const magicLink = createMagicLink(config, email);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.resendFrom,
      to: [email],
      subject: "Your Real Love Ready Companion sign-in link",
      html: magicLinkEmail(magicLink)
    })
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}.`);
  }
}

export function verifyMagicLink(token: string | null, config: PreviewAuthConfig): string | undefined {
  if (!token || !config.secret) {
    return undefined;
  }
  const payload = verifySignedToken(token, config.secret);
  if (!payload || payload.purpose !== "magic-link" || !config.allowedEmails.has(payload.email)) {
    return undefined;
  }
  return payload.email;
}

export function createSignedToken(payload: AuthTokenPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifySignedToken(token: string, secret: string): AuthTokenPayload | undefined {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature || !safeEqual(signature, sign(encodedPayload, secret))) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as AuthTokenPayload;
    if (!normalizeEmail(payload.email) || !Number.isInteger(payload.exp) || payload.exp <= currentTime() || (payload.purpose !== "magic-link" && payload.purpose !== "session")) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function magicLinkEmail(magicLink: string): string {
  const safeLink = escapeHtml(magicLink);
  return `<p>Here is your sign-in link for the Real Love Ready Companion preview.</p><p><a href="${safeLink}">Open the companion</a></p><p>This link expires in 15 minutes. If you did not request it, you can ignore this email.</p>`;
}

function normalizePublicBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

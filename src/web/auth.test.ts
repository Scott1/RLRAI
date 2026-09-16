import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCookie,
  createSignedToken,
  getAuthenticatedEmail,
  normalizeEmail,
  verifyMagicLink,
  verifySignedToken,
  type PreviewAuthConfig
} from "./auth";

const config: PreviewAuthConfig = {
  allowedEmails: new Set(["reviewer@example.com"]),
  mode: "email",
  publicBaseUrl: "https://preview.example.com",
  resendApiKey: "test-key",
  resendFrom: "Preview <preview@example.com>",
  secret: "test-secret"
};

test("normalizes reviewer emails", () => {
  assert.equal(normalizeEmail(" Reviewer@Example.com "), "reviewer@example.com");
  assert.equal(normalizeEmail("not an email"), undefined);
});

test("accepts a signed session for an approved reviewer", () => {
  const cookie = createSessionCookie(config, "reviewer@example.com");
  assert.equal(getAuthenticatedEmail(cookie, config), "reviewer@example.com");
});

test("rejects a session for a reviewer removed from the allowlist", () => {
  const cookie = createSessionCookie(config, "reviewer@example.com");
  const revokedConfig = { ...config, allowedEmails: new Set<string>() };
  assert.equal(getAuthenticatedEmail(cookie, revokedConfig), undefined);
});

test("rejects altered and expired signed tokens", () => {
  const valid = createSignedToken({ email: "reviewer@example.com", exp: 2_000_000_000, purpose: "session" }, "test-secret");
  assert.ok(verifySignedToken(valid, "test-secret"));
  assert.equal(verifySignedToken(`${valid}x`, "test-secret"), undefined);

  const expired = createSignedToken({ email: "reviewer@example.com", exp: 1, purpose: "session" }, "test-secret");
  assert.equal(verifySignedToken(expired, "test-secret"), undefined);
});

test("requires an approved email for a magic link", () => {
  const approvedToken = createSignedToken({ email: "reviewer@example.com", exp: 2_000_000_000, purpose: "magic-link" }, "test-secret");
  const otherToken = createSignedToken({ email: "other@example.com", exp: 2_000_000_000, purpose: "magic-link" }, "test-secret");
  assert.equal(verifyMagicLink(approvedToken, config), "reviewer@example.com");
  assert.equal(verifyMagicLink(otherToken, config), undefined);
});

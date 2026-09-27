import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticatePreviewAccount,
  createSessionCookie,
  createSignedToken,
  getAuthenticatedUsername,
  getPreviewAuthConfig,
  isPreviewAdmin,
  normalizeUsername,
  verifySignedToken,
  type PreviewAuthConfig
} from "./auth";

const account = { username: "reviewer-01", password: "correct-horse-battery" };
const config: PreviewAuthConfig = {
  accounts: new Map([[account.username, account]]),
  mode: "password",
  secret: "test-secret",
  secureCookies: true
};

test("normalizes preview usernames", () => {
  assert.equal(normalizeUsername(" Reviewer-01 "), "reviewer-01");
  assert.equal(normalizeUsername("not valid"), undefined);
});

test("accepts configured reviewer credentials", () => {
  assert.equal(authenticatePreviewAccount(config, "reviewer-01", "correct-horse-battery"), account);
  assert.equal(authenticatePreviewAccount(config, "reviewer-01", "incorrect-password"), undefined);
  assert.equal(authenticatePreviewAccount(config, "unknown-reviewer", "correct-horse-battery"), undefined);
});

test("accepts a signed session for a configured reviewer", () => {
  const cookie = createSessionCookie(config, account);
  assert.equal(getAuthenticatedUsername(cookie, config), "reviewer-01");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test("rejects a session when the reviewer is removed or their password changes", () => {
  const cookie = createSessionCookie(config, account);
  assert.equal(getAuthenticatedUsername(cookie, { ...config, accounts: new Map() }), undefined);
  const changedAccount = { ...account, password: "a-new-long-password" };
  assert.equal(getAuthenticatedUsername(cookie, { ...config, accounts: new Map([[account.username, changedAccount]]) }), undefined);
});

test("rejects altered and expired signed tokens", () => {
  const valid = createSignedToken({ accountFingerprint: "fingerprint", exp: 2_000_000_000, purpose: "session", username: "reviewer-01" }, "test-secret");
  assert.ok(verifySignedToken(valid, "test-secret"));
  assert.equal(verifySignedToken(`${valid}x`, "test-secret"), undefined);

  const expired = createSignedToken({ accountFingerprint: "fingerprint", exp: 1, purpose: "session", username: "reviewer-01" }, "test-secret");
  assert.equal(verifySignedToken(expired, "test-secret"), undefined);
});

test("reads configured accounts from environment-style settings", () => {
  const parsed = getPreviewAuthConfig({
    RLR_AUTH_MODE: "password",
    RLR_AUTH_SECRET: "test-secret",
    RLR_PREVIEW_ACCOUNTS: "reviewer-01|correct-horse-battery;reviewer-02|another-long-password"
  });
  assert.equal(parsed.accounts.size, 2);
  assert.equal(parsed.accounts.get("reviewer-02")?.password, "another-long-password");
});

test("keeps admin access separate from reviewer access", () => {
  const parsed = getPreviewAuthConfig({
    RLR_AUTH_MODE: "password",
    RLR_AUTH_SECRET: "test-secret",
    RLR_PREVIEW_ACCOUNTS: "reviewer-01|correct-horse-battery",
    RLR_ADMIN_ACCOUNT: "scott|an-admin-password-longer-than-twenty"
  });
  assert.equal(isPreviewAdmin(parsed, "scott", "0.0.0.0"), true);
  assert.equal(isPreviewAdmin(parsed, "reviewer-01", "0.0.0.0"), false);
  assert.ok(authenticatePreviewAccount(parsed, "scott", "an-admin-password-longer-than-twenty"));
  assert.equal(isPreviewAdmin({ accounts: new Map(), mode: "off", secureCookies: false }, "local", "127.0.0.1"), true);
  assert.equal(isPreviewAdmin({ accounts: new Map(), mode: "off", secureCookies: false }, "local", "0.0.0.0"), false);
});

test("rejects a duplicate admin username", () => {
  assert.throws(() => getPreviewAuthConfig({
    RLR_AUTH_MODE: "password",
    RLR_AUTH_SECRET: "test-secret",
    RLR_PREVIEW_ACCOUNTS: "scott|correct-horse-battery",
    RLR_ADMIN_ACCOUNT: "scott|an-admin-password-longer-than-twenty"
  }));
});

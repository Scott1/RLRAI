import assert from "node:assert/strict";
import test from "node:test";
import { renderLoginPage } from "./login";

test("login page includes artwork, accessible reviewer fields, and the existing login action", () => {
  const html = renderLoginPage({ requiresSignIn: true });
  assert.match(html, /src="\/assets\/compass-login.png"/);
  assert.match(html, /href="\/login.css"/);
  assert.match(html, /method="post" action="\/auth\/login"/);
  assert.match(html, /for="username"/);
  assert.match(html, /autocomplete="current-password" required/);
  assert.match(html, /not therapy, crisis support, diagnosis/);
});

test("local preview preserves access without a misleading sign-in form", () => {
  const html = renderLoginPage({ requiresSignIn: false });
  assert.match(html, /href="\/">Open Compass/);
  assert.doesNotMatch(html, /action="\/auth\/login"/);
});

test("login error is announced and escaped without echoing credentials", () => {
  const html = renderLoginPage({ requiresSignIn: true, message: '<script>"bad" & \'unsafe\'</script>' });
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;script&gt;&quot;bad&quot; &amp; &#39;unsafe&#39;&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /value=/);
});

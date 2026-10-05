export function renderLoginPage(options: { message?: string; requiresSignIn: boolean }): string {
  const message = options.message?.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#fffdf9">
    <title>Sign in | Real Love Ready Compass</title>
    <link rel="icon" href="/assets/rlr-heart.ico" type="image/x-icon">
    <link rel="stylesheet" href="/login.css">
  </head>
  <body>
    <main class="login-shell">
      <header class="login-brand">
        <img src="/assets/real-love-ready-logo.webp" width="232" height="42" alt="Real Love Ready">
        <h1>The RLR <span>Compass</span></h1>
        <p>A thoughtful place to explore and reflect</p>
      </header>
      <img class="login-art" src="/assets/compass-login.png" width="1536" height="1024" alt="" fetchpriority="high">
      <section class="sign-in" aria-labelledby="signInTitle">
        <h2 id="signInTitle">${options.requiresSignIn ? "Welcome back" : "Explore the preview"}</h2>
        <p class="intro">${options.requiresSignIn ? "Sign in with your invited reviewer account." : "No sign-in is needed for this local preview."}</p>
        ${message ? `<p class="form-message" role="alert">${message}</p>` : ""}
        ${options.requiresSignIn ? `<form method="post" action="/auth/login">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button class="sign-in-button" type="submit">Sign in</button>
        </form>` : `<a class="sign-in-button" href="/">Open Compass</a>`}
        <p class="reviewer-note">Private prototype &middot; For invited reviewers</p>
      </section>
      <p class="scope-note">For education and reflection, not therapy, crisis support, diagnosis, or making relationship decisions.</p>
    </main>
  </body>
</html>`;
}

const form = document.querySelector("#chatForm");
const input = document.querySelector("#questionInput");
const messages = document.querySelector("#messages");
const statusEl = document.querySelector("#status");
const sendButton = document.querySelector("#sendButton");
const resetButton = document.querySelector("#resetButton");

let sessionId = localStorage.getItem("rlr-session-id") || crypto.randomUUID();
localStorage.setItem("rlr-session-id", sessionId);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = input.value.trim();
  if (!question) {
    return;
  }

  input.value = "";
  appendMessage("user", "You", question);
  setBusy(true, "Searching Real Love Ready...");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Request failed.");
    }

    sessionId = payload.sessionId;
    localStorage.setItem("rlr-session-id", sessionId);
    appendMessage("assistant", "Companion", payload.answer, payload.sources);
    setBusy(false, "Ready");
  } catch (error) {
    appendMessage("assistant", "Companion", error instanceof Error ? error.message : String(error));
    setBusy(false, "Ready");
  }
});

resetButton.addEventListener("click", async () => {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId })
  });

  sessionId = crypto.randomUUID();
  localStorage.setItem("rlr-session-id", sessionId);
  messages.innerHTML = "";
  appendMessage(
    "assistant",
    "Companion",
    "Conversation reset. Ask a question and I’ll search the approved RLR corpus."
  );
});

function appendMessage(role, label, text, sources = []) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const labelEl = document.createElement("div");
  labelEl.className = "message-label";
  labelEl.textContent = label;
  article.append(labelEl);

  const body = document.createElement("p");
  body.textContent = text;
  article.append(body);

  if (sources?.length) {
    const sourceList = document.createElement("div");
    sourceList.className = "sources";

    for (const source of sources) {
      const item = document.createElement("div");
      item.className = "source";

      const title = document.createElement(source.sourceUrl ? "a" : "div");
      title.textContent = `[${source.key}] ${source.title}`;
      if (source.sourceUrl) {
        title.href = source.sourceUrl;
        title.target = "_blank";
        title.rel = "noreferrer";
      }

      const meta = document.createElement("div");
      meta.className = "source-meta";
      const score = typeof source.score === "number" ? ` · score ${source.score.toFixed(3)}` : "";
      meta.textContent = `${source.type}${score}`;

      item.append(title, meta);
      sourceList.append(item);
    }

    article.append(sourceList);
  }

  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function setBusy(isBusy, text) {
  sendButton.disabled = isBusy;
  input.disabled = isBusy;
  statusEl.textContent = text;
}

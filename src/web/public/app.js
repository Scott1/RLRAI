const form = document.querySelector("#chatForm");
const input = document.querySelector("#questionInput");
const messages = document.querySelector("#messages");
const statusEl = document.querySelector("#status");
const sendButton = document.querySelector("#sendButton");
const resetButton = document.querySelector("#resetButton");
const connectionStatus = document.querySelector("#connectionStatus");
const connectionText = document.querySelector("#connectionText");
const modelDetail = document.querySelector("#modelDetail");
const logoutForm = document.querySelector("#logoutForm");

let sessionId = localStorage.getItem("rlr-session-id") || crypto.randomUUID();
localStorage.setItem("rlr-session-id", sessionId);

void loadStatus();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendQuestion(input.value);
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    const question = button.dataset.question;
    if (question) {
      input.value = question;
      input.focus();
    }
  });
});

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;
  try {
    await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
  } catch {
    // A new local session still gives the user a fresh conversation.
  }

  sessionId = crypto.randomUUID();
  localStorage.setItem("rlr-session-id", sessionId);
  messages.innerHTML = "";
  appendWelcome();
  input.focus();
  resetButton.disabled = false;
});

async function sendQuestion(questionText) {
  const question = questionText.trim();
  if (!question) {
    input.focus();
    return;
  }

  input.value = "";
  appendMessage("user", "You", question);
  const pending = appendPendingMessage();
  setBusy(true, "Searching the RLR library...");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, question })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "The companion could not complete that response.");
    }

    sessionId = payload.sessionId;
    localStorage.setItem("rlr-session-id", sessionId);
    pending.remove();
    appendMessage("assistant", "Real Love Ready Companion", payload.answer, payload.sources, payload);
    setBusy(false, "Ready to reflect");
  } catch (error) {
    pending.remove();
    appendErrorMessage(error instanceof Error ? error.message : "Something interrupted that response.");
    setBusy(false, "Ready to try again");
  }
}

function appendWelcome() {
  const article = document.createElement("article");
  article.className = "message assistant welcome-message";
  article.innerHTML = `
    <div class="message-heading">
      <div class="message-label">Real Love Ready Companion</div>
      <span class="message-context">Grounded in the RLR library</span>
    </div>
    <p>What is feeling present in your relationships? We can make room to explore it together, with ideas from Real Love Ready material as a guide.</p>
    <div class="suggestions" aria-label="Suggested questions">
      <button class="suggestion" type="button" data-question="Why do I feel guilty when I set boundaries?">Setting boundaries without guilt</button>
      <button class="suggestion" type="button" data-question="How can I have a difficult conversation with more care?">Navigating a difficult conversation</button>
      <button class="suggestion" type="button" data-question="What does secure connection look like in a relationship?">Understanding secure connection</button>
    </div>`;
  article.querySelectorAll(".suggestion").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.question || "";
      input.focus();
    });
  });
  messages.append(article);
}

function appendPendingMessage() {
  const article = document.createElement("article");
  article.className = "message assistant pending-message";
  article.setAttribute("aria-label", "Preparing a response");
  article.innerHTML = `
    <div class="message-heading">
      <div class="message-label">Real Love Ready Companion</div>
      <span class="message-context">Looking through approved material</span>
    </div>
    <div class="thinking" aria-hidden="true"><span></span><span></span><span></span></div>`;
  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
  return article;
}

function appendErrorMessage(text) {
  const article = document.createElement("article");
  article.className = "message assistant error-message";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "Connection interrupted";
  const body = document.createElement("p");
  body.textContent = text;
  const retry = document.createElement("button");
  retry.className = "retry-button";
  retry.type = "button";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    article.remove();
    input.focus();
  });
  article.append(label, body, retry);
  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function appendMessage(role, label, text, sources = [], details = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const heading = document.createElement("div");
  heading.className = "message-heading";
  const labelEl = document.createElement("div");
  labelEl.className = "message-label";
  labelEl.textContent = label;
  heading.append(labelEl);

  if (role === "assistant") {
    const context = document.createElement("span");
    context.className = "message-context";
    context.textContent = details.insufficientEvidence ? "Limited RLR material found" : "RLR-informed reflection";
    heading.append(context);
  }

  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = text;
  article.append(heading, body);

  if (role === "assistant") {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.type = "button";
    copy.textContent = "Copy response";
    copy.addEventListener("click", async () => {
      try {
        await globalThis.navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        globalThis.setTimeout(() => { copy.textContent = "Copy response"; }, 1800);
      } catch {
        copy.textContent = "Unable to copy";
      }
    });
    actions.append(copy);
    article.append(actions);
  }

  if (sources?.length) {
    const sourceGroup = document.createElement("details");
    sourceGroup.className = "sources";
    const summary = document.createElement("summary");
    summary.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"} from the RLR library`;
    sourceGroup.append(summary);
    const sourceList = document.createElement("div");
    sourceList.className = "source-list";

    for (const source of sources) {
      const item = document.createElement("div");
      item.className = "source";
      const type = document.createElement("span");
      type.className = "source-type";
      type.textContent = source.type === "book" ? "Book" : "Podcast";
      const title = document.createElement(source.sourceUrl ? "a" : "div");
      title.className = "source-title";
      title.textContent = source.title;
      if (source.sourceUrl) {
        title.href = source.sourceUrl;
        title.target = "_blank";
        title.rel = "noreferrer";
      }
      item.append(type, title);
      sourceList.append(item);
    }

    sourceGroup.append(sourceList);
    article.append(sourceGroup);
  }

  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function setBusy(isBusy, text) {
  sendButton.disabled = isBusy;
  input.disabled = isBusy;
  statusEl.textContent = text;
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) {
      throw new Error("Unable to reach the RLR library.");
    }
    const status = await response.json();
    const stores = status.vectorStoreIds?.length || 0;
    logoutForm.hidden = status.authMode !== "password";
    connectionStatus.classList.add("connected");
    connectionText.textContent = "RLR library connected";
    modelDetail.textContent = `${stores} library ${stores === 1 ? "collection" : "collections"} connected`;
  } catch {
    connectionStatus.classList.add("offline");
    connectionText.textContent = "Library connection unavailable";
    modelDetail.textContent = "Check that the local companion server is running";
  }
}

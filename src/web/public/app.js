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
const mainMenu = document.querySelector("#mainMenu");
const menuButton = document.querySelector("#menuButton");
const menuPanel = document.querySelector("#menuPanel");
const shareIdeaButton = document.querySelector("#shareIdeaButton");
const adminDashboardLink = document.querySelector("#adminDashboardLink");
const feedbackDialog = document.querySelector("#feedbackDialog");
const feedbackForm = document.querySelector("#feedbackForm");
const feedbackTitle = document.querySelector("#feedbackTitle");
const feedbackContext = document.querySelector("#feedbackContext");
const feedbackCategory = document.querySelector("#feedbackCategory");
const feedbackComment = document.querySelector("#feedbackComment");
const feedbackOptional = document.querySelector("#feedbackOptional");
const feedbackQuestionOption = document.querySelector("#feedbackQuestionOption");
const feedbackIncludeQuestion = document.querySelector("#feedbackIncludeQuestion");
const feedbackError = document.querySelector("#feedbackError");
const feedbackSubmit = document.querySelector("#feedbackSubmit");
const feedbackNotice = document.querySelector("#feedbackNotice");

let sessionId = localStorage.getItem("rlr-session-id") || crypto.randomUUID();
let feedbackEnabled = false;
let feedbackKind = "idea";
let feedbackResponseId;
let nextMessageId = 0;
let noticeTimer;
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

menuButton.addEventListener("click", () => setMenuOpen(menuPanel.hidden));
document.addEventListener("pointerdown", (event) => {
  if (!mainMenu.contains(event.target)) {
    setMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setMenuOpen(false);
  }
});

shareIdeaButton.addEventListener("click", () => {
  setMenuOpen(false);
  openFeedback("idea");
});
document.querySelector("#feedbackClose").addEventListener("click", () => feedbackDialog.close());
document.querySelector("#feedbackCancel").addEventListener("click", () => feedbackDialog.close());

feedbackForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedbackError.hidden = true;
  feedbackSubmit.disabled = true;
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: feedbackKind,
        category: feedbackCategory.value,
        comment: feedbackComment.value,
        ...(feedbackKind === "report" ? { responseId: feedbackResponseId, includeQuestion: feedbackIncludeQuestion.checked } : {})
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Your feedback could not be sent.");
    }
    feedbackDialog.close();
    showNotice("Feedback sent. Thank you.");
  } catch (error) {
    feedbackError.textContent = error instanceof Error ? error.message : "Your feedback could not be sent.";
    feedbackError.hidden = false;
  } finally {
    feedbackSubmit.disabled = false;
  }
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
  const { sourceGroup, citationTargets } = createSourceGroup(sources, ++nextMessageId);
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

  const body = document.createElement(role === "assistant" ? "div" : "p");
  body.className = "message-body";
  if (role === "assistant") {
    appendFormattedAssistantText(body, text, citationTargets, sourceGroup);
  } else {
    body.textContent = text;
  }
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
        await globalThis.navigator.clipboard.writeText(formatResponseForCopy(text, sources));
        copy.textContent = "Copied";
        globalThis.setTimeout(() => { copy.textContent = "Copy response"; }, 1800);
      } catch {
        copy.textContent = "Unable to copy";
      }
    });
    actions.append(copy);
    if (details.responseId) {
      const report = document.createElement("button");
      report.className = "report-button";
      report.type = "button";
      report.textContent = "Rate this response";
      report.hidden = !feedbackEnabled;
      report.addEventListener("click", () => openFeedback("report", details.responseId));
      actions.append(report);
    }
    article.append(actions);
  }

  if (sourceGroup) {
    article.append(sourceGroup);
  }

  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function createSourceGroup(sources, messageId) {
  const citationTargets = new Map();
  if (!sources?.length) {
    return { sourceGroup: null, citationTargets };
  }

  const sourceGroup = document.createElement("details");
  sourceGroup.className = "sources";
  const summary = document.createElement("summary");
  summary.textContent = `Sources from the RLR library (${sources.length})`;
  sourceGroup.append(summary);
  const sourceList = document.createElement("div");
  sourceList.className = "source-list";

  for (const [index, source] of sources.entries()) {
    const number = index + 1;
    const item = document.createElement("div");
    item.className = "source";
    item.id = `source-${messageId}-${number}`;
    item.tabIndex = -1;
    citationTargets.set(source.key, { number, item, title: source.title });

    const numberEl = document.createElement("span");
    numberEl.className = "source-number";
    numberEl.textContent = String(number);
    const sourceDetails = document.createElement("div");
    sourceDetails.className = "source-details";
    if (source.workTitle) {
      const work = document.createElement("div");
      work.className = "source-work";
      work.textContent = source.workTitle;
      sourceDetails.append(work);
    }

    const url = safeSourceUrl(source.sourceUrl);
    const title = document.createElement(url ? "a" : "div");
    title.className = "source-title";
    title.textContent = source.title;
    if (url) {
      title.href = url;
      title.target = "_blank";
      title.rel = "noreferrer";
    }
    sourceDetails.append(title);
    item.append(numberEl, sourceDetails);

    if (url) {
      const share = document.createElement("button");
      share.className = "source-share";
      share.type = "button";
      share.textContent = "Share";
      share.title = `Share ${source.title}`;
      share.setAttribute("aria-label", `Share source ${number}: ${source.title}`);
      share.addEventListener("click", () => { void shareSource(source.title, url, share); });
      item.append(share);
    }
    sourceList.append(item);
  }

  sourceGroup.append(sourceList);
  return { sourceGroup, citationTargets };
}

function appendFormattedAssistantText(container, text, citationTargets, sourceGroup) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraphLines = [];
  let list;

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }

    const paragraph = document.createElement("p");
    appendInlineFormatting(paragraph, paragraphLines.join(" "), citationTargets, sourceGroup);
    container.append(paragraph);
    paragraphLines = [];
  };

  const flushList = () => {
    if (list) {
      container.append(list);
      list = undefined;
    }
  };

  for (const line of lines) {
    const listItem = line.match(/^\s*[-*+]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      list ??= document.createElement("ul");
      const item = document.createElement("li");
      appendInlineFormatting(item, listItem[1], citationTargets, sourceGroup);
      list.append(item);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushList();
}

function appendInlineFormatting(container, text, citationTargets, sourceGroup) {
  const boldPattern = /(\*\*|__)(.+?)\1/g;
  let lastIndex = 0;

  for (const match of text.matchAll(boldPattern)) {
    const matchStart = match.index ?? 0;
    appendCitationText(container, text.slice(lastIndex, matchStart), citationTargets, sourceGroup);

    const strong = document.createElement("strong");
    appendCitationText(strong, match[2], citationTargets, sourceGroup);
    container.append(strong);
    lastIndex = matchStart + match[0].length;
  }

  appendCitationText(container, text.slice(lastIndex), citationTargets, sourceGroup);
}

function appendCitationText(container, text, citationTargets, sourceGroup) {
  let lastIndex = 0;
  for (const match of text.matchAll(/\[S\d+\]/g)) {
    const matchStart = match.index ?? 0;
    container.append(document.createTextNode(text.slice(lastIndex, matchStart)));
    const target = citationTargets.get(match[0].slice(1, -1));
    if (target) {
      const link = document.createElement("a");
      link.className = "citation-ref";
      link.href = `#${target.item.id}`;
      link.textContent = String(target.number);
      link.title = `View source ${target.number}: ${target.title}`;
      link.setAttribute("aria-label", `View source ${target.number}: ${target.title}`);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        sourceGroup.open = true;
        globalThis.requestAnimationFrame(() => {
          target.item.focus({ preventScroll: true });
          target.item.scrollIntoView({ behavior: "smooth", block: "nearest" });
          target.item.classList.add("source-highlight");
          globalThis.setTimeout(() => target.item.classList.remove("source-highlight"), 2000);
        });
      });
      container.append(link);
    } else {
      const missing = document.createElement("span");
      missing.className = "citation-missing";
      missing.textContent = "[source unavailable]";
      container.append(missing);
    }
    lastIndex = matchStart + match[0].length;
  }
  container.append(document.createTextNode(text.slice(lastIndex)));
}

function safeSourceUrl(value) {
  try {
    const url = new globalThis.URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatResponseForCopy(text, sources) {
  const sourceNumbers = new Map(sources.map((source, index) => [source.key, index + 1]));
  const answer = text.replace(/\[S\d+\]/g, (marker) => {
    const number = sourceNumbers.get(marker.slice(1, -1));
    return number ? `[${number}]` : "[source unavailable]";
  });
  if (!sources.length) {
    return answer;
  }
  const sourceLines = sources.map((source, index) => {
    const name = source.workTitle ? `${source.workTitle} - ${source.title}` : source.title;
    const url = safeSourceUrl(source.sourceUrl);
    return `${index + 1}. ${name}${url ? ` - ${url}` : ""}`;
  });
  return `${answer}\n\nSources:\n${sourceLines.join("\n")}`;
}

async function shareSource(title, url, button) {
  try {
    await globalThis.navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    showNotice(`Link to ${title} copied.`);
    globalThis.setTimeout(() => { button.textContent = "Share"; }, 1800);
  } catch {
    showNotice("Unable to share this link from this browser.");
  }
}

function openFeedback(kind, responseId) {
  if (!feedbackEnabled) {
    return;
  }
  feedbackKind = kind;
  feedbackResponseId = responseId;
  feedbackForm.reset();
  feedbackError.hidden = true;
  feedbackCategory.replaceChildren();
  const choices = kind === "idea"
    ? [["feature_request", "Feature request"], ["general_idea", "General idea"], ["other_feedback", "Other feedback"]]
    : [["good_response", "Good response"], ["inaccurate_source", "Inaccurate source"], ["overconfident_advice", "Overconfident advice"], ["safety_concern", "Safety concern"], ["not_rlr", "Doesn't feel like RLR"], ["other", "Something else"]];
  const placeholder = new globalThis.Option("Choose one", "", true, true);
  placeholder.disabled = true;
  feedbackCategory.add(placeholder);
  for (const [value, label] of choices) {
    feedbackCategory.add(new globalThis.Option(label, value));
  }
  feedbackTitle.textContent = kind === "idea" ? "Share an idea" : "Rate this response";
  feedbackContext.textContent = "This feedback includes this answer and its source references. Your question is only included if you choose the option below.";
  feedbackContext.hidden = kind !== "report";
  feedbackQuestionOption.hidden = kind !== "report";
  feedbackOptional.hidden = kind !== "report";
  feedbackComment.required = kind === "idea";
  feedbackDialog.showModal();
  feedbackCategory.focus();
}

function showNotice(text) {
  feedbackNotice.textContent = text;
  feedbackNotice.hidden = false;
  globalThis.clearTimeout(noticeTimer);
  noticeTimer = globalThis.setTimeout(() => { feedbackNotice.hidden = true; }, 3500);
}

function setMenuOpen(isOpen) {
  menuPanel.hidden = !isOpen;
  menuButton.setAttribute("aria-expanded", String(isOpen));
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
    feedbackEnabled = status.feedbackEnabled === true;
    shareIdeaButton.hidden = !feedbackEnabled;
    adminDashboardLink.hidden = status.admin !== true;
    mainMenu.hidden = !feedbackEnabled && logoutForm.hidden && adminDashboardLink.hidden;
    document.querySelectorAll(".report-button").forEach((button) => { button.hidden = !feedbackEnabled; });
    connectionStatus.classList.add("connected");
    connectionText.textContent = "RLR library connected";
    modelDetail.textContent = `${stores} library ${stores === 1 ? "collection" : "collections"} connected`;
  } catch {
    connectionStatus.classList.add("offline");
    connectionText.textContent = "Library connection unavailable";
    modelDetail.textContent = "Check that the local companion server is running";
  }
}

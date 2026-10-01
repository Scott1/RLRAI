const state = { feedback: [], selectedId: null };
const byId = (id) => document.getElementById(id);
const labels = { feature_request: "Feature request", general_idea: "General idea", other_feedback: "Other feedback", good_response: "Good response", inaccurate_source: "Inaccurate source", overconfident_advice: "Overconfident advice", safety_concern: "Safety concern", not_rlr: "Doesn't feel like RLR", other: "Other" };
const statuses = { new: "New", in_review: "In review", resolved: "Resolved" };

byId("searchInput").addEventListener("input", renderList);
byId("kindFilter").addEventListener("change", renderList);
byId("statusFilter").addEventListener("change", renderList);
byId("reviewForm").addEventListener("submit", saveReview);
loadFeedback();

async function loadFeedback() {
  try {
    const response = await fetch("/api/admin/feedback", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load feedback.");
    state.feedback = data.feedback;
    if (!state.feedback.some((item) => item.id === state.selectedId)) state.selectedId = state.feedback[0]?.id || null;
    byId("pageStatus").textContent = state.feedback.length ? "" : "No feedback has been submitted yet.";
    renderCounts();
    renderList();
    renderDetail();
  } catch (error) {
    byId("pageStatus").textContent = error.message;
  }
}

function renderCounts() {
  byId("totalCount").textContent = state.feedback.length;
  byId("newCount").textContent = state.feedback.filter((item) => item.review.status === "new").length;
  byId("reportCount").textContent = state.feedback.filter((item) => item.kind === "report").length;
  byId("evalCount").textContent = state.feedback.filter((item) => item.review.evalCandidate && item.review.evalQuestion && item.review.requirements).length;
}

function renderList() {
  const query = byId("searchInput").value.trim().toLowerCase();
  const kind = byId("kindFilter").value;
  const status = byId("statusFilter").value;
  const shown = state.feedback.filter((item) => (kind === "all" || item.kind === kind || (kind === "good_response" && item.kind === "report" && item.category === "good_response")) && (status === "all" || item.review.status === status) && (!query || [item.comment, item.username, labels[item.category], item.category, item.question].filter(Boolean).join(" ").toLowerCase().includes(query)));
  byId("listCount").textContent = `${shown.length} ${shown.length === 1 ? "item" : "items"}`;
  const list = byId("feedbackList");
  list.replaceChildren();
  for (const item of shown) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "feedback-row";
    button.classList.toggle("selected", item.id === state.selectedId);
    button.setAttribute("aria-pressed", String(item.id === state.selectedId));
    const top = document.createElement("span");
    top.className = "row-top";
    const type = document.createElement("span");
    type.textContent = item.kind === "report" ? "Response feedback" : "Idea";
    const date = document.createElement("time");
    date.dateTime = item.createdAt;
    date.textContent = formatDate(item.createdAt);
    top.append(type, date);
    const title = document.createElement("strong");
    title.textContent = labels[item.category] || item.category;
    const excerpt = document.createElement("span");
    excerpt.className = "row-excerpt";
    excerpt.textContent = item.comment || "No additional comment";
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = `${item.username} · ${statuses[item.review.status] || "New"}${item.review.evalCandidate ? " · Eval candidate" : ""}`;
    button.append(top, title, excerpt, meta);
    button.addEventListener("click", () => { state.selectedId = item.id; renderList(); renderDetail(); });
    list.append(button);
  }
}

function renderDetail() {
  const item = state.feedback.find((entry) => entry.id === state.selectedId);
  byId("emptyDetail").hidden = Boolean(item);
  byId("detailContent").hidden = !item;
  if (!item) return;
  byId("detailKind").textContent = item.kind === "report" ? "Response feedback" : "Shared idea";
  byId("detailTitle").textContent = labels[item.category] || item.category;
  byId("detailMeta").textContent = `${item.username} · ${formatDateTime(item.createdAt)}${item.model ? ` · ${item.model}` : ""}`;
  byId("detailStatus").textContent = statuses[item.review.status] || "New";
  byId("detailComment").textContent = item.comment || "No additional comment.";
  byId("responseSection").hidden = item.kind !== "report";
  byId("detailQuestion").hidden = !item.question;
  byId("detailQuestion").textContent = item.question ? `Question shared: ${item.question}` : "";
  byId("detailResponse").textContent = item.response || "Response text unavailable.";
  const sources = byId("detailSources");
  sources.replaceChildren();
  if (Array.isArray(item.sources) && item.sources.length) {
    const heading = document.createElement("h4");
    heading.textContent = "Sources shown";
    const list = document.createElement("ul");
    for (const source of item.sources) {
      const li = document.createElement("li");
      let url;
      try { url = new URL(source.sourceUrl); } catch { /* No public link. */ }
      if (url && ["http:", "https:"].includes(url.protocol)) {
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = source.title;
        li.append(link);
      } else li.textContent = source.title;
      list.append(li);
    }
    sources.append(heading, list);
  }
  byId("reviewStatus").value = item.review.status;
  byId("evalCandidate").checked = item.review.evalCandidate;
  byId("adminNote").value = item.review.adminNote;
  byId("evalQuestion").value = item.review.evalQuestion;
  byId("requirements").value = item.review.requirements;
  byId("reviewMessage").textContent = item.review.updatedAt ? `Last saved ${formatDateTime(item.review.updatedAt)}` : "";
}

async function saveReview(event) {
  event.preventDefault();
  const item = state.feedback.find((entry) => entry.id === state.selectedId);
  if (!item) return;
  const button = byId("saveReview");
  button.disabled = true;
  byId("reviewMessage").textContent = "Saving...";
  try {
    const response = await fetch(`/api/admin/feedback/${item.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: byId("reviewStatus").value, evalCandidate: byId("evalCandidate").checked, adminNote: byId("adminNote").value, evalQuestion: byId("evalQuestion").value, requirements: byId("requirements").value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save review.");
    state.feedback = state.feedback.map((entry) => entry.id === item.id ? data.feedback : entry);
    renderCounts(); renderList(); renderDetail();
    byId("reviewMessage").textContent = "Saved.";
  } catch (error) {
    byId("reviewMessage").textContent = error.message;
  } finally { button.disabled = false; }
}

function formatDate(value) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function formatDateTime(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

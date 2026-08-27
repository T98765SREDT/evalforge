import {
  DEFAULT_RUBRIC,
  RATING_LABELS,
  calculateWeightedScore,
  determineWinner,
  scoreTone
} from "./scoring.js";
import { downloadTextFile, evaluationsToCsv, evaluationsToJson } from "./export.js";
import { createImportPlan, parseEvaluationImport } from "./import.js";
import { createBlankEvaluation, normalizeEvaluation } from "./model.js";
import { quickPrompts, sampleEvaluations } from "./data.js";
import { commitEvaluations, loadEvaluationState } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const form = $("#evaluation-form");
const fields = {
  title: $("#evaluation-title"),
  prompt: $("#prompt"),
  responseA: $("#response-a"),
  responseB: $("#response-b"),
  notes: $("#notes"),
  tags: $("#tags"),
  confidence: $("#confidence")
};

const initialState = loadEvaluationState(sampleEvaluations);
let evaluations = initialState.evaluations;
let current = createBlankEvaluation();
let pendingImport = null;
let formIsDirty = false;
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleFromPrompt(prompt) {
  const firstLine = prompt.trim().split("\n")[0] || "Untitled evaluation";
  return firstLine.length > 58 ? `${firstLine.slice(0, 55).trim()}…` : firstLine;
}

function wordCount(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function formatDate(iso) {
  if (!iso) return "Not saved";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(iso));
}

function scoreLabel(result) {
  if (!result.completedDimensions) return "Not scored";
  const labels = {
    excellent: "Excellent",
    strong: "Strong",
    mixed: "Needs review",
    weak: "Weak"
  };
  return labels[scoreTone(result.score)];
}

function renderRubric() {
  $("#rubric-rows").innerHTML = DEFAULT_RUBRIC.map((dimension) => `
    <div class="rubric-row" role="row" data-dimension="${dimension.id}">
      <div role="rowheader">
        <div class="dimension-title">
          <span class="weight-badge">${dimension.weight}%</span>
          <div>
            <strong>${dimension.label}</strong>
            <p>${dimension.description}</p>
          </div>
        </div>
      </div>
      <div role="cell">
        <div class="rating-group" data-response="A" data-label="Response A" aria-label="${dimension.label} rating for Response A">
          ${ratingButtons(dimension.id, "A")}
        </div>
      </div>
      <div role="cell">
        <div class="rating-group" data-response="B" data-label="Response B" aria-label="${dimension.label} rating for Response B">
          ${ratingButtons(dimension.id, "B")}
        </div>
      </div>
    </div>
  `).join("");
}

function ratingButtons(dimensionId, response) {
  return [1, 2, 3, 4, 5].map((rating) => `
    <button
      class="rating-button"
      type="button"
      data-dimension="${dimensionId}"
      data-response="${response}"
      data-rating="${rating}"
      aria-label="${rating}: ${RATING_LABELS[rating]}"
      aria-pressed="false"
      title="${RATING_LABELS[rating]}"
    >${rating}</button>
  `).join("");
}

function renderQuickPrompts() {
  $("#quick-prompt-buttons").innerHTML = quickPrompts.map((item, index) => (
    `<button class="quick-prompt" type="button" data-quick-prompt="${index}">${item.label}</button>`
  )).join("");
}

function renderMethodology() {
  $("#methodology-list").innerHTML = DEFAULT_RUBRIC.map((dimension, index) => `
    <div class="methodology-item">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div><strong>${dimension.label}</strong><small>${dimension.description}</small></div>
      <b>${dimension.weight}%</b>
    </div>
  `).join("");
}

function syncCurrentFromForm() {
  current.title = fields.title.value.trim();
  current.prompt = fields.prompt.value;
  current.responseA = fields.responseA.value;
  current.responseB = fields.responseB.value;
  current.notes = fields.notes.value;
  current.confidence = Number(fields.confidence.value);
  current.tags = fields.tags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, tags) => tags.indexOf(tag) === index)
    .slice(0, 8);
  recalculateCurrent();
}

function recalculateCurrent() {
  current.scores = {
    A: calculateWeightedScore(current.ratings.A),
    B: calculateWeightedScore(current.ratings.B)
  };
  current.winner = current.scores.A.isComplete && current.scores.B.isComplete
    ? determineWinner(current.scores.A.score, current.scores.B.score)
    : "pending";
}

function populateForm(evaluation) {
  current = normalizeEvaluation(evaluation);
  fields.title.value = current.title;
  fields.prompt.value = current.prompt;
  fields.responseA.value = current.responseA;
  fields.responseB.value = current.responseB;
  fields.notes.value = current.notes;
  fields.tags.value = current.tags.join(", ");
  fields.confidence.value = current.confidence;
  renderCurrent();
}

function renderCurrent() {
  recalculateCurrent();

  $$(".rating-button").forEach((button) => {
    const { dimension, response, rating } = button.dataset;
    const selected = Number(rating) === Number(current.ratings[response][dimension]);
    button.classList.toggle("selected-a", selected && response === "A");
    button.classList.toggle("selected-b", selected && response === "B");
    button.setAttribute("aria-pressed", String(selected));
  });

  updateScoreUi("A", current.scores.A);
  updateScoreUi("B", current.scores.B);
  updateVerdictUi();
  updateInputMeta();
  updateReadiness();

  const status = $("#current-status");
  status.className = `status-pill ${current.status}`;
  status.innerHTML = `<i></i> ${current.status === "complete" ? "Complete" : "Draft"}`;
}

function updateScoreUi(response, result) {
  const lower = response.toLowerCase();
  $(`#score-${lower}`).textContent = result.score;
  $(`#score-label-${lower}`).textContent = scoreLabel(result);
  $(`#completion-${lower}`).textContent = `${result.completedDimensions} of ${result.totalDimensions} dimensions`;
  $(`#score-ring-${lower}`).style.setProperty("--score", result.score);
}

function updateVerdictUi() {
  const winner = current.winner;
  const mark = $("#winner-mark");
  mark.className = `winner-mark ${winner === "A" ? "a" : winner === "B" ? "b" : winner}`;

  if (winner === "pending") {
    mark.textContent = "—";
    $("#winner-title").textContent = "Score both responses";
    $("#winner-detail").textContent = "Complete the rubric to calculate a transparent winner.";
    return;
  }

  if (winner === "tie") {
    mark.textContent = "=";
    $("#winner-title").textContent = "Responses are effectively tied";
    $("#winner-detail").textContent = `${current.scores.A.score} vs ${current.scores.B.score} · within the ${current.rubricSnapshot.tieThreshold}-point tie threshold`;
    return;
  }

  const margin = Math.abs(current.scores.A.score - current.scores.B.score);
  mark.textContent = winner;
  $("#winner-title").textContent = `Response ${winner} is stronger`;
  $("#winner-detail").textContent = `${margin}-point advantage · ${current.confidence}% evaluator confidence`;
}

function updateInputMeta() {
  $("#prompt-count").textContent = `${fields.prompt.value.length} characters`;
  $("#notes-count").textContent = `${fields.notes.value.length} characters`;
  $("#a-word-count").textContent = `${wordCount(fields.responseA.value)} words`;
  $("#b-word-count").textContent = `${wordCount(fields.responseB.value)} words`;
  $("#confidence-value").textContent = `${fields.confidence.value}%`;
  fields.confidence.style.setProperty("--range-value", `${fields.confidence.value}%`);
}

function updateReadiness() {
  const contentReady = current.prompt.trim() && current.responseA.trim() && current.responseB.trim();
  const rubricReady = current.scores.A.isComplete && current.scores.B.isComplete;
  const notesReady = current.notes.trim().length >= 20;
  $("#check-prompt").classList.toggle("done", Boolean(contentReady));
  $("#check-rubric").classList.toggle("done", rubricReady);
  $("#check-notes").classList.toggle("done", notesReady);
}

function setDirty() {
  formIsDirty = true;
  $("#save-state").className = "save-state";
  $("#save-state").innerHTML = "<i></i> Unsaved changes";
  if (current.status === "complete") current.status = "draft";
}

function setSaved() {
  formIsDirty = false;
  $("#save-state").className = "save-state saved";
  $("#save-state").innerHTML = "<i></i> Saved locally";
}

function setReady() {
  formIsDirty = false;
  $("#save-state").className = "save-state";
  $("#save-state").innerHTML = "<i></i> Ready";
}

function setSaveError() {
  formIsDirty = true;
  $("#save-state").className = "save-state error";
  $("#save-state").innerHTML = "<i></i> Not saved";
  showDataNotice(
    "error",
    "Local save failed. Your changes are still in this form. Free browser storage or export your saved evaluations, then try again."
  );
}

function showDataNotice(kind, message) {
  const notice = $("#data-notice");
  notice.hidden = false;
  notice.dataset.kind = kind;
  notice.className = `data-notice ${kind}`;
  notice.setAttribute("role", kind === "error" ? "alert" : "status");
  $("#data-notice-message").textContent = message;
}

function clearErrorNotice() {
  const notice = $("#data-notice");
  if (notice.dataset.kind === "error") {
    notice.hidden = true;
    notice.dataset.kind = "";
  }
}

function saveCurrent(status) {
  syncCurrentFromForm();

  if (status === "complete") {
    const missing = completionError();
    if (missing) {
      showToast(missing.message);
      missing.element.focus();
      return false;
    }
  }

  const now = new Date().toISOString();
  const candidate = normalizeEvaluation({
    ...structuredClone(current),
    title: current.title || titleFromPrompt(current.prompt),
    createdAt: current.createdAt || now,
    updatedAt: now,
    status
  });
  const candidateEvaluations = structuredClone(evaluations);
  const index = candidateEvaluations.findIndex(({ id }) => id === candidate.id);
  if (index >= 0) candidateEvaluations[index] = candidate;
  else candidateEvaluations.unshift(candidate);

  const transaction = commitEvaluations(candidateEvaluations, evaluations);
  if (!transaction.ok) {
    setSaveError();
    showToast("Could not save locally. Your form has not been cleared.");
    return false;
  }

  evaluations = transaction.evaluations;
  current = candidate;
  fields.title.value = current.title;
  clearErrorNotice();
  setSaved();
  renderCurrent();
  renderMetrics();
  renderHistory();
  showToast(status === "complete" ? "Evaluation completed and saved" : "Draft saved locally");
  return true;
}

function completionError() {
  if (!current.prompt.trim()) return { message: "Add the user prompt before completing the review", element: fields.prompt };
  if (!current.responseA.trim()) return { message: "Add Response A before completing the review", element: fields.responseA };
  if (!current.responseB.trim()) return { message: "Add Response B before completing the review", element: fields.responseB };
  if (!current.scores.A.isComplete || !current.scores.B.isComplete) {
    return { message: "Score every rubric dimension for both responses", element: $(".rating-button[aria-pressed='false']") };
  }
  if (current.notes.trim().length < 20) return { message: "Add evidence-based evaluator notes", element: fields.notes };
  return null;
}

function renderMetrics() {
  const complete = evaluations.filter(({ status }) => status === "complete");
  const confidence = complete.length
    ? Math.round(complete.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / complete.length)
    : null;
  const allScores = evaluations.flatMap((item) => [item.scores?.A, item.scores?.B]).filter(Boolean);
  const coverage = allScores.length
    ? Math.round(allScores.reduce((sum, score) => sum + Number(score.completion || 0), 0) / allScores.length)
    : null;
  const outcomes = complete.reduce((counts, item) => {
    counts[item.winner] = (counts[item.winner] || 0) + 1;
    return counts;
  }, {});
  const topOutcome = Object.entries(outcomes).sort((a, b) => b[1] - a[1])[0]?.[0];

  $("#metric-total").textContent = evaluations.length;
  $("#metric-complete").textContent = `${complete.length} complete`;
  $("#metric-confidence").textContent = confidence === null ? "—" : `${confidence}%`;
  $("#metric-coverage").textContent = coverage === null ? "—" : `${coverage}%`;
  $("#metric-winner").textContent = topOutcome ? (topOutcome === "tie" ? "Tie" : `Response ${topOutcome}`) : "—";
  $("#nav-count").textContent = evaluations.length;
}

function renderHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const filter = $("#history-filter").value;
  const filtered = evaluations
    .filter((evaluation) => filter === "all" || evaluation.status === filter)
    .filter((evaluation) => {
      const haystack = [evaluation.title, evaluation.prompt, evaluation.notes, ...evaluation.tags].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

  if (!filtered.length) {
    $("#history-list").innerHTML = `
      <div class="empty-state"><strong>No matching evaluations</strong>Try a different search or create a new evaluation.</div>
    `;
    return;
  }

  $("#history-list").innerHTML = filtered.map((evaluation) => {
    const verdict = evaluation.winner === "pending" ? "—" : evaluation.winner === "tie" ? "=" : evaluation.winner;
    const verdictLabel = evaluation.winner === "pending" ? "In progress" : evaluation.winner === "tie" ? "Effective tie" : `Response ${evaluation.winner}`;
    return `
      <article class="history-item">
        <div class="history-main">
          <span>${escapeHtml(formatDate(evaluation.updatedAt || evaluation.createdAt))} · ${escapeHtml(evaluation.status)}</span>
          <strong title="${escapeHtml(evaluation.title)}">${escapeHtml(evaluation.title || titleFromPrompt(evaluation.prompt))}</strong>
          <p>${escapeHtml(evaluation.prompt)}</p>
          <div class="tag-row">${evaluation.tags.slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
        </div>
        <div class="history-scores">
          <div class="mini-score a"><span>Score A</span><strong>${evaluation.scores.A.score}</strong></div>
          <div class="mini-score b"><span>Score B</span><strong>${evaluation.scores.B.score}</strong></div>
        </div>
        <div class="history-verdict">
          <span>${verdict}</span>
          <span><strong>${escapeHtml(verdictLabel)}</strong><small>${evaluation.confidence}% confidence</small></span>
        </div>
        <div class="history-controls">
          <button type="button" data-edit="${escapeHtml(evaluation.id)}" title="Open evaluation" aria-label="Open ${escapeHtml(evaluation.title)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 15.5 10-10 3.5 3.5-10 10H5zm11.4-11.4 1.5-1.5 3.5 3.5-1.5 1.5zM4 20h16v2H4z" /></svg>
          </button>
          <button class="delete" type="button" data-delete="${escapeHtml(evaluation.id)}" title="Delete evaluation" aria-label="Delete ${escapeHtml(evaluation.title)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6V4h10v2h3v2h-1l-1 13H6L5 8H4V6zm1 2 .8 11h6.4L16 8z" /></svg>
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast span").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function resetCurrent({ scroll = true } = {}) {
  populateForm(createBlankEvaluation());
  setReady();
  if (scroll) $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateImportPreview() {
  if (!pendingImport) return;
  const mode = $("#import-mode").value;
  const plan = createImportPlan(evaluations, pendingImport.evaluations, mode);
  const report = pendingImport.report;
  const parts = [`${report.accepted} ready`];
  if (report.repaired) parts.push(`${report.repaired} repaired`);
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  $("#import-summary").textContent = parts.join(" · ");
  const planDetail = mode === "merge"
    ? `${plan.added} new and ${plan.updated} matching evaluation${plan.updated === 1 ? "" : "s"} will be restored. Matching IDs use the imported version.`
    : `${plan.evaluations.length} evaluation${plan.evaluations.length === 1 ? "" : "s"} will replace the ${evaluations.length} currently stored.`;
  $("#import-detail").textContent = `${planDetail}${formIsDirty ? " Your unsaved form will be cleared after a successful restore." : ""}`;
}

async function previewImportFile(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;

  pendingImport = null;
  $("#apply-import").disabled = true;
  $("#import-filename").textContent = file.name;

  try {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("This file is larger than the 5 MB import limit.");
    }
    pendingImport = parseEvaluationImport(await file.text());
    $("#import-mode").value = "merge";
    $("#apply-import").disabled = false;
    updateImportPreview();
  } catch (error) {
    $("#import-summary").textContent = "Import unavailable";
    $("#import-detail").textContent = error.message || "EvalForge could not read this file.";
  }

  $("#import-dialog").showModal();
}

function applyPendingImport() {
  if (!pendingImport) return;
  const plan = createImportPlan(evaluations, pendingImport.evaluations, $("#import-mode").value);
  const transaction = commitEvaluations(plan.evaluations, evaluations);
  if (!transaction.ok) {
    setSaveError();
    showToast("Import could not be saved. No evaluations were changed.");
    return;
  }

  evaluations = transaction.evaluations;
  resetCurrent({ scroll: false });
  renderMetrics();
  renderHistory();
  $("#import-dialog").close();
  clearErrorNotice();

  const recovery = pendingImport.report;
  if (recovery.repaired || recovery.skipped) {
    showDataNotice("info", `Import finished: ${recovery.accepted} restored, ${recovery.repaired} repaired, and ${recovery.skipped} skipped.`);
  }
  showToast(`${evaluations.length} evaluations are now stored locally`);
  pendingImport = null;
}

function copyVerdict() {
  syncCurrentFromForm();
  if (current.winner === "pending") {
    showToast("Complete the rubric before copying a verdict");
    return;
  }
  const outcome = current.winner === "tie" ? "The responses are effectively tied" : `Response ${current.winner} is stronger`;
  const summary = `${outcome}. Response A: ${current.scores.A.score}/100. Response B: ${current.scores.B.score}/100. Confidence: ${current.confidence}%.${current.notes.trim() ? `\n\nNotes: ${current.notes.trim()}` : ""}`;
  navigator.clipboard.writeText(summary).then(
    () => showToast("Verdict copied to clipboard"),
    () => showToast("Clipboard access is unavailable")
  );
}

function bindEvents() {
  $("#rubric-rows").addEventListener("click", (event) => {
    const button = event.target.closest(".rating-button");
    if (!button) return;
    const { dimension, response, rating } = button.dataset;
    current.ratings[response][dimension] = Number(rating);
    syncCurrentFromForm();
    setDirty();
    renderCurrent();
  });

  form.addEventListener("input", () => {
    syncCurrentFromForm();
    setDirty();
    renderCurrent();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCurrent("complete");
  });

  $("#save-draft").addEventListener("click", () => saveCurrent("draft"));
  $("#new-evaluation").addEventListener("click", () => resetCurrent());
  $("#clear-form").addEventListener("click", () => resetCurrent({ scroll: false }));
  $("#copy-verdict").addEventListener("click", copyVerdict);

  $("#quick-prompt-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-quick-prompt]");
    if (!button) return;
    const template = quickPrompts[Number(button.dataset.quickPrompt)];
    fields.prompt.value = template.prompt;
    const currentTags = fields.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!currentTags.includes(template.tag)) currentTags.push(template.tag);
    fields.tags.value = currentTags.join(", ");
    syncCurrentFromForm();
    setDirty();
    renderCurrent();
    fields.prompt.focus();
  });

  $("#history-search").addEventListener("input", renderHistory);
  $("#history-filter").addEventListener("change", renderHistory);

  $("#history-list").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");

    if (editButton) {
      const evaluation = evaluations.find(({ id }) => id === editButton.dataset.edit);
      if (!evaluation) return;
      populateForm(evaluation);
      setSaved();
      $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if (deleteButton) {
      const evaluation = evaluations.find(({ id }) => id === deleteButton.dataset.delete);
      if (!evaluation || !confirm(`Delete “${evaluation.title || "Untitled evaluation"}”? This cannot be undone.`)) return;
      const candidateEvaluations = evaluations.filter(({ id }) => id !== evaluation.id);
      const transaction = commitEvaluations(candidateEvaluations, evaluations);
      if (!transaction.ok) {
        setSaveError();
        showToast("Could not delete locally. No evaluations were changed.");
        return;
      }
      evaluations = transaction.evaluations;
      clearErrorNotice();
      if (current.id === evaluation.id) resetCurrent({ scroll: false });
      renderMetrics();
      renderHistory();
      showToast("Evaluation deleted");
    }
  });

  $("#export-json").addEventListener("click", () => {
    downloadTextFile("evalforge-evaluations.json", evaluationsToJson(evaluations), "application/json");
    showToast(`Exported ${evaluations.length} evaluations as JSON`);
  });

  $("#export-csv").addEventListener("click", () => {
    downloadTextFile("evalforge-evaluations.csv", evaluationsToCsv(evaluations), "text/csv");
    showToast(`Exported ${evaluations.length} evaluations as CSV`);
  });

  $("#import-json").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", previewImportFile);
  $("#import-mode").addEventListener("change", updateImportPreview);
  $("#apply-import").addEventListener("click", applyPendingImport);
  $("#close-import").addEventListener("click", () => $("#import-dialog").close());
  $("#cancel-import").addEventListener("click", () => $("#import-dialog").close());
  $("#dismiss-data-notice").addEventListener("click", () => {
    $("#data-notice").hidden = true;
    $("#data-notice").dataset.kind = "";
  });

  const dialog = $("#methodology-dialog");
  $("#open-methodology").addEventListener("click", () => dialog.showModal());
  $("#close-methodology").addEventListener("click", () => dialog.close());
  $("#dialog-done").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  });

  $("#mobile-menu").addEventListener("click", () => {
    const open = document.body.classList.toggle("menu-open");
    $("#mobile-menu").setAttribute("aria-expanded", String(open));
  });

  $$(".side-nav a").forEach((link) => link.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    $("#mobile-menu").setAttribute("aria-expanded", "false");
  }));
}

function initialize() {
  renderRubric();
  renderQuickPrompts();
  renderMethodology();
  bindEvents();
  populateForm(current);
  renderMetrics();
  renderHistory();
  setReady();

  if (initialState.error) {
    showDataNotice("error", "Local data could not be read. EvalForge opened with sample evaluations; your browser data was not overwritten.");
  } else if (initialState.report.source === "storage" && (initialState.report.repaired || initialState.report.skipped)) {
    showDataNotice(
      "info",
      `Local data recovered: ${initialState.report.accepted} loaded, ${initialState.report.repaired} repaired, and ${initialState.report.skipped} skipped.`
    );
  }
}

initialize();

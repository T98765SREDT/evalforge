import {
  RUBRIC_PRESETS,
  RATING_LABELS,
  calculateWeightedScore,
  determineWinner,
  getRubric,
  getRubricProfile,
  scoreTone
} from "./scoring.js";
import { downloadTextFile, evaluationsToCsv, evaluationsToJson } from "./export.js";
import { createImportPlan, parseEvaluationImport } from "./import.js";
import { createBlankEvaluation, createRubricSnapshot, normalizeEvaluation } from "./model.js";
import { quickPrompts, sampleEvaluations } from "./data.js";
import { completeCase, createBatch, enqueueCase, queueProgress, skipCase, startCase } from "./queue.js";
import { commitEvaluations, commitQueue, loadEvaluationState, loadQueueState } from "./storage.js";
import { parseDatasetImport } from "./domain/dataset-import.js";
import {
  commitDatasetCollection,
  createDatasetApplyPlan,
  datasetCaseCount,
  datasetLibrarySummary,
  loadDatasetState
} from "./ui/datasets.js";
import {
  beginDatasetImport,
  canApplyDatasetImport,
  createDatasetImportDialogState,
  datasetImportIssueRows,
  datasetImportPreview,
  failDatasetImport,
  finishDatasetImportApply,
  rejectedRowsAsJsonl,
  startDatasetImportApply
} from "./ui/import-dataset-dialog.js";
import {
  DATASET_TEMPLATE_CSV,
  DATASET_TEMPLATE_JSONL,
  hasDemoEvaluations,
  hasUserEvaluations,
  matchesHistoryFilter,
  metricsInput,
  onboardingCopy,
  removeDemoEvaluations,
  seedDemoEvaluations
} from "./ui/onboarding.js";
import {
  beginWorkstationSave,
  createAutosaveController,
  createReviewWorkstationState,
  markWorkstationDirty,
  workstationSaveFailed,
  workstationSaveSucceeded
} from "./ui/review-workstation.js";
import { createSessionHeaderModel, saveStateTone, sessionProgress } from "./ui/session-header.js";
import { createBrowserAuditExports } from "./ui/audit-actions.js";
import { createAnalyticsFilters, createAnalyticsView, formatAnalyticsNumber, formatAnalyticsRate } from "./ui/analytics.js";
import { readV3Document, summarizeV3Read } from "./persistence/read-v3-document.js";
import { bootstrapV3 } from "./persistence/bootstrap.js";
import { IndexedDbRepository } from "./persistence/indexeddb-repository.js";
import {
  completeIndexedDbReview,
  completeIndexedDbSession,
  revealIndexedDbSession,
  saveIndexedDbDraft,
  startIndexedDbAssignment
} from "./domain/indexeddb-review-usecases.js";
import {
  createV3AssignmentView,
  createV3SessionPlan,
  nextV3AssignmentIndex,
  restoreV3SessionState,
  v3DatasetOptions
} from "./ui/v3-session.js";
import {
  buildV3ReviewInput,
  createEmptyV3Draft,
  reviewDraftFromPersisted
} from "./ui/v3-review.js";

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

const initialState = loadEvaluationState([]);
let evaluations = initialState.evaluations;
const initialQueueState = loadQueueState(createBatch({ name: "Review queue" }));
let reviewQueue = initialQueueState.batch;
const initialDatasetState = loadDatasetState([]);
let datasets = initialDatasetState.datasets;
const WORKSTATION_STORAGE_KEY = "evalforge.workstation.v1";

function readWorkstationMeta() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(WORKSTATION_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function readAnalyticsFilters() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || "");
    return {
      datasetId: params.get("analytics_dataset") || "all",
      rubricId: params.get("analytics_rubric") || "all",
      tag: params.get("analytics_tag") || "all",
      reviewerId: params.get("analytics_reviewer") || "all",
      from: params.get("analytics_from") || "",
      to: params.get("analytics_to") || "",
      includeSamples: params.get("analytics_samples") === "1"
    };
  } catch {
    return {};
  }
}

function persistAnalyticsFilters() {
  try {
    const url = new URL(globalThis.location.href);
    const keys = ["analytics_dataset", "analytics_rubric", "analytics_tag", "analytics_reviewer", "analytics_from", "analytics_to", "analytics_samples"];
    keys.forEach((key) => url.searchParams.delete(key));
    const values = {
      analytics_dataset: analyticsFilters.datasetId,
      analytics_rubric: analyticsFilters.rubricId,
      analytics_tag: analyticsFilters.tag,
      analytics_reviewer: analyticsFilters.reviewerId,
      analytics_from: analyticsFilters.from,
      analytics_to: analyticsFilters.to
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value && value !== "all") url.searchParams.set(key, value);
    });
    if (analyticsFilters.includeSamples) url.searchParams.set("analytics_samples", "1");
    globalThis.history?.replaceState(null, "", url);
  } catch {
    // URL state is an enhancement; analytics remains usable when history is unavailable.
  }
}

const workstationMeta = readWorkstationMeta();
let current = createBlankEvaluation();
let pendingImport = null;
let pendingDatasetImport = createDatasetImportDialogState();
let formIsDirty = false;
let toastTimer;
let pendingUnsavedAction = null;
let unsavedReturnFocus = null;
let pendingConfirmation = null;
let confirmationReturnFocus = null;
let activeQueueCaseId = typeof workstationMeta.activeQueueCaseId === "string"
  && reviewQueue.cases.some((item) => item.id === workstationMeta.activeQueueCaseId)
  ? workstationMeta.activeQueueCaseId
  : null;
let pendingSkipCaseId = null;
let skipReturnFocus = null;
let workstationState = createReviewWorkstationState();
let completedQueueSession = workstationMeta.queueId === reviewQueue.id && workstationMeta.completed === true;
let analyticsFilters = readAnalyticsFilters();
let v3ReadState = null;
let useV3Workspace = false;
let v3BootstrapState = null;
let v3SessionState = null;
// IndexedDB transactions opened by separate user actions can overlap. Keep
// the browser workflow single-flight so a fast "Start" followed by "Save
// draft" cannot publish an older assignment snapshot over the new state.
let v3MutationInFlight = false;
let runtimeIdCounter = 0;
const autosave = createAutosaveController({
  delayMs: 900,
  onSave: () => {
    if (formIsDirty) saveCurrent("draft", { silent: true });
  }
});

function persistWorkstationMeta() {
  try {
    globalThis.localStorage?.setItem(WORKSTATION_STORAGE_KEY, JSON.stringify({
      queueId: reviewQueue.id,
      activeQueueCaseId,
      completed: completedQueueSession
    }));
  } catch {
    // The review form remains usable when browser storage is unavailable.
  }
}

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
  const rubric = getRubric(current.rubricId);
  $("#rubric-select").value = current.rubricId;
  $("#rubric-description").textContent = getRubricProfile(current.rubricId).description;
  $("#rubric-rows").innerHTML = rubric.map((dimension) => `
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
  const rubric = getRubric(current.rubricId);
  $("#methodology-list").innerHTML = rubric.map((dimension, index) => `
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
  const rubric = getRubric(current.rubricId);
  current.scores = {
    A: calculateWeightedScore(current.ratings.A, rubric),
    B: calculateWeightedScore(current.ratings.B, rubric)
  };
  current.winner = current.scores.A.isComplete && current.scores.B.isComplete
    ? determineWinner(current.scores.A.score, current.scores.B.score, getRubricProfile(current.rubricId).tieThreshold)
    : "pending";
}

function populateRubricOptions() {
  $("#rubric-select").innerHTML = Object.values(RUBRIC_PRESETS)
    .map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`)
    .join("");
}

function switchRubric(rubricId) {
  const profile = getRubricProfile(rubricId);
  const previous = current.ratings || { A: {}, B: {} };
  current.rubricId = profile.id;
  current.ratings = {
    A: Object.fromEntries(profile.dimensions.map(({ id }) => [id, previous.A?.[id] || 0])),
    B: Object.fromEntries(profile.dimensions.map(({ id }) => [id, previous.B?.[id] || 0]))
  };
  current.rubricSnapshot = createRubricSnapshot(current.ratings, profile.dimensions, profile.tieThreshold, profile);
  setDirty();
  renderRubric();
  renderMethodology();
  renderCurrent();
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
  workstationState = markWorkstationDirty(workstationState);
  $("#save-state").className = "save-state";
  $("#save-state").innerHTML = "<i></i> Unsaved changes";
  renderSessionHeader();
  if (current.status === "complete") current.status = "draft";
}

function scheduleAutosave() {
  const hasContent = [fields.title.value, fields.prompt.value, fields.responseA.value, fields.responseB.value, fields.notes.value, fields.tags.value]
    .some((value) => value.trim());
  if (!hasContent) return;
  autosave.schedule(structuredClone(current));
}

function setSaved() {
  formIsDirty = false;
  workstationState = workstationSaveSucceeded(workstationState);
  $("#save-state").className = "save-state saved";
  $("#save-state").innerHTML = "<i></i> Saved locally";
  renderSessionHeader();
}

function setReady() {
  formIsDirty = false;
  workstationState = createReviewWorkstationState({ ...workstationState, saveState: "clean" });
  $("#save-state").className = "save-state";
  $("#save-state").innerHTML = "<i></i> Ready";
  renderSessionHeader();
}

function setSaveError() {
  formIsDirty = true;
  workstationState = workstationSaveFailed(workstationState, "Local save failed");
  $("#save-state").className = "save-state error";
  $("#save-state").innerHTML = "<i></i> Not saved";
  renderSessionHeader();
  showDataNotice(
    "error",
    "Local save failed. Your changes are still in this form. Free browser storage or export your saved evaluations, then try again.",
    { persistent: true }
  );
}

function closeDialogAndRestoreFocus(dialog, focusTarget) {
  if (dialog.open) dialog.close();
  if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
}

function runOrConfirmUnsaved(action, trigger = document.activeElement) {
  if (!formIsDirty) {
    action();
    return;
  }
  pendingUnsavedAction = action;
  unsavedReturnFocus = trigger;
  const dialog = $("#unsaved-dialog");
  if (!dialog.open) dialog.showModal();
  $("#keep-unsaved").focus();
}

function resolveUnsaved(choice) {
  const action = pendingUnsavedAction;
  const returnFocus = unsavedReturnFocus;
  if (choice === "keep") {
    pendingUnsavedAction = null;
    unsavedReturnFocus = null;
    closeDialogAndRestoreFocus($("#unsaved-dialog"), returnFocus);
    return;
  }

  if (choice === "save") {
    if (!saveCurrent("draft")) return;
  } else {
    formIsDirty = false;
  }

  pendingUnsavedAction = null;
  unsavedReturnFocus = null;
  closeDialogAndRestoreFocus($("#unsaved-dialog"), returnFocus);
  if (action) action();
}

function askConfirmation({ title, message, confirmLabel = "Confirm", onConfirm, trigger = document.activeElement }) {
  pendingConfirmation = onConfirm;
  confirmationReturnFocus = trigger;
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#accept-confirm").textContent = confirmLabel;
  const dialog = $("#confirm-dialog");
  if (!dialog.open) dialog.showModal();
  $("#cancel-confirm").focus();
}

function cancelConfirmation() {
  pendingConfirmation = null;
  const returnFocus = confirmationReturnFocus;
  confirmationReturnFocus = null;
  closeDialogAndRestoreFocus($("#confirm-dialog"), returnFocus);
}

function acceptConfirmation() {
  const action = pendingConfirmation;
  pendingConfirmation = null;
  const returnFocus = confirmationReturnFocus;
  confirmationReturnFocus = null;
  closeDialogAndRestoreFocus($("#confirm-dialog"), returnFocus);
  if (action) action();
}

function showDataNotice(kind, message, { persistent = false } = {}) {
  const notice = $("#data-notice");
  notice.hidden = false;
  notice.dataset.kind = kind;
  notice.dataset.persistent = String(persistent);
  notice.className = `data-notice ${kind}`;
  notice.setAttribute("role", kind === "error" ? "alert" : "status");
  $("#data-notice-message").textContent = message;
  $("#dismiss-data-notice").hidden = persistent;
}

function clearErrorNotice() {
  const notice = $("#data-notice");
  if (notice.dataset.kind === "error") {
    notice.hidden = true;
    notice.dataset.kind = "";
    notice.dataset.persistent = "false";
    $("#dismiss-data-notice").hidden = false;
  }
}

function setImportFeedback(kind, summary, detail) {
  const summaryElement = $("#import-summary");
  const detailElement = $("#import-detail");
  summaryElement.textContent = summary;
  detailElement.textContent = detail;
  detailElement.dataset.kind = kind;
}

function saveCurrent(status, { silent = false } = {}) {
  syncCurrentFromForm();

  if (!silent) autosave.cancel();
  workstationState = beginWorkstationSave(workstationState);
  renderSessionHeader();

  if (status === "complete") {
    const missing = completionError();
    if (missing) {
      workstationState = markWorkstationDirty(workstationState);
      renderSessionHeader();
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
    workstationState = workstationSaveFailed(workstationState, "Local save failed");
    setSaveError();
    showToast("Could not save locally. Your form has not been cleared.");
    return false;
  }

  evaluations = transaction.evaluations;
  current = candidate;
  fields.title.value = current.title;
  clearErrorNotice();
  workstationState = workstationSaveSucceeded(workstationState);
  setSaved();
  renderCurrent();
  renderMetrics();
  renderHistory();
  let openedNext = false;
  if (status === "complete" && activeQueueCaseId) {
    const finishedQueueCaseId = activeQueueCaseId;
    const queueResult = completeCase(reviewQueue, finishedQueueCaseId, candidate.id);
    if (queueResult.updated && persistQueue(queueResult.batch, null)) {
      activeQueueCaseId = null;
      persistWorkstationMeta();
      const next = reviewQueue.cases.find((item) => item.status === "pending");
      if (next) {
        openQueueCase(next.id);
        openedNext = true;
      }
    }
  }
  if (!silent || status === "complete") {
    showToast(status === "complete" ? (openedNext ? "Evaluation saved · next case opened" : "Evaluation completed and saved") : "Draft saved locally");
  }
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
  const metricEvaluations = metricsInput(evaluations);
  const complete = metricEvaluations.filter(({ status }) => status === "complete");
  const confidence = complete.length
    ? Math.round(complete.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / complete.length)
    : null;
  const allScores = metricEvaluations.flatMap((item) => [item.scores?.A, item.scores?.B]).filter(Boolean);
  const coverage = allScores.length
    ? Math.round(allScores.reduce((sum, score) => sum + Number(score.completion || 0), 0) / allScores.length)
    : null;
  const completedGaps = complete
    .filter((item) => item.scores?.A?.isComplete && item.scores?.B?.isComplete)
    .map((item) => Math.abs(Number(item.scores.A.score) - Number(item.scores.B.score)));
  const averageGap = completedGaps.length
    ? Math.round(completedGaps.reduce((sum, gap) => sum + gap, 0) / completedGaps.length)
    : null;

  $("#metric-total").textContent = metricEvaluations.length;
  $("#metric-complete").textContent = `${complete.length} complete`;
  $("#metric-confidence").textContent = confidence === null ? "—" : `${confidence}%`;
  $("#metric-coverage").textContent = coverage === null ? "—" : `${coverage}%`;
  $("#metric-winner").textContent = averageGap === null ? "—" : `${averageGap} pts`;
  $("#nav-count").textContent = metricEvaluations.length;
  renderAnalytics();
}

function setAnalyticsMetric(valueId, denominatorId, value, denominator) {
  $(valueId).textContent = formatAnalyticsRate(value);
  $(denominatorId).textContent = denominator ? `n = ${denominator}` : "No eligible records";
}

function prettyDimension(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activeV3Document() {
  return useV3Workspace && v3ReadState?.status === "ready" ? v3ReadState.document : null;
}

function renderAnalyticsDataSource() {
  const element = $("#analytics-data-source");
  if (!element) return;
  const active = activeV3Document();
  if (active) {
    element.dataset.source = "v3";
    element.textContent = "Verified v3 workspace · selected";
    return;
  }
  if (v3ReadState?.status === "ready") {
    element.dataset.source = "available";
    element.textContent = "Legacy browser records · v3 available";
    return;
  }
  element.dataset.source = "legacy";
  element.textContent = "Legacy browser records";
}

function renderAnalyticsFilters() {
  const document = activeV3Document();
  const options = createAnalyticsFilters(document ? { document } : { evaluations, queueCases: reviewQueue.cases });
  const validSelection = (values, selected) => selected === "all" || values.some((value) => (typeof value === "string" ? value : value.id) === selected) ? selected : "all";
  analyticsFilters = {
    ...analyticsFilters,
    datasetId: validSelection(options.datasets, analyticsFilters.datasetId),
    rubricId: validSelection(options.rubrics, analyticsFilters.rubricId),
    tag: validSelection(options.tags, analyticsFilters.tag),
    reviewerId: validSelection(options.reviewers, analyticsFilters.reviewerId)
  };
  const optionMarkup = (values, selected, labelFor = (value) => value) => [
    `<option value="all">All</option>`,
    ...values.map((value) => {
      const item = typeof value === "string" ? { id: value, name: labelFor(value) } : value;
      return `<option value="${escapeHtml(item.id)}"${item.id === selected ? " selected" : ""}>${escapeHtml(item.name)}</option>`;
    })
  ].join("");
  $("#analytics-dataset-filter").innerHTML = optionMarkup(options.datasets, analyticsFilters.datasetId);
  $("#analytics-rubric-filter").innerHTML = optionMarkup(options.rubrics, analyticsFilters.rubricId, (value) => prettyDimension(value));
  $("#analytics-tag-filter").innerHTML = optionMarkup(options.tags, analyticsFilters.tag);
  $("#analytics-reviewer-filter").innerHTML = optionMarkup(options.reviewers, analyticsFilters.reviewerId);
  $("#analytics-date-from").value = analyticsFilters.from || "";
  $("#analytics-date-to").value = analyticsFilters.to || "";
  $("#analytics-include-samples").checked = analyticsFilters.includeSamples === true;
}

function renderAnalytics() {
  if (!$("#analytics")) return;
  renderAnalyticsDataSource();
  renderAnalyticsFilters();
  const document = activeV3Document();
  const result = createAnalyticsView(document ? { document, filters: analyticsFilters } : { evaluations, queueCases: reviewQueue.cases, filters: analyticsFilters });
  setAnalyticsMetric("#analytics-completion", "#analytics-completion-denominator", result.workflow.completionRate, result.workflow.total);
  setAnalyticsMetric("#analytics-skip", "#analytics-skip-denominator", result.workflow.skipRate, result.workflow.total);
  setAnalyticsMetric("#analytics-tie", "#analytics-tie-denominator", result.reviews.tieRate, result.reviews.completed);
  setAnalyticsMetric("#analytics-conflict", "#analytics-conflict-denominator", result.reviews.conflictRate, result.reviews.completed);
  setAnalyticsMetric("#analytics-low-confidence", "#analytics-low-confidence-denominator", result.reviews.lowConfidenceRate, result.reviews.completed);
  $("#analytics-review-count").textContent = `${result.reviews.completed} completed review${result.reviews.completed === 1 ? "" : "s"} · ${result.workflow.active} active case${result.workflow.active === 1 ? "" : "s"}`;

  $("#analytics-dimensions").innerHTML = result.dimensions.length
    ? result.dimensions.map((item) => `<div class="analytics-row"><span>${escapeHtml(prettyDimension(item.dimension))}</span><strong>${escapeHtml(formatAnalyticsNumber(item.average))} / 5</strong><small>n = ${item.count}</small></div>`).join("")
    : `<div class="analytics-empty">Complete a review to see per-dimension evidence.</div>`;

  const gap = result.scoreGap;
  $("#analytics-gap-summary").textContent = gap.count ? `Median ${formatAnalyticsNumber(gap.median)} pts · average ${formatAnalyticsNumber(gap.average)} pts · p25–p75 ${formatAnalyticsNumber(gap.p25)}–${formatAnalyticsNumber(gap.p75)} pts` : "No completed score pairs yet.";
  $("#analytics-gap-buckets").innerHTML = gap.buckets.map((bucket) => `<div class="analytics-bar-row"><span>${escapeHtml(bucket.label)} pts</span><div class="analytics-bar-track"><i style="--bar-width:${bucket.rate === null ? 0 : Math.round(bucket.rate * 100)}%"></i></div><strong>${bucket.count}</strong></div>`).join("");

  $("#analytics-source").innerHTML = result.sourceWinRate.available
    ? result.sourceWinRate.bySource.map((item) => `<div class="analytics-row"><span>${escapeHtml(item.source)}</span><strong>${formatAnalyticsRate(item.winRate)}</strong><small>${item.wins}/${item.compared} preferred</small></div>`).join("")
    : `<div class="analytics-empty">${escapeHtml(result.sourceWinRate.reason)}</div>`;

  $("#analytics-calibration").innerHTML = result.calibration.repeats
    ? `<div class="analytics-row"><span>Preference agreement</span><strong>${formatAnalyticsRate(result.calibration.preference.agreementRate)}</strong><small>${result.calibration.preference.agreements}/${result.calibration.preference.compared} repeats</small></div><div class="analytics-row"><span>Position switches</span><strong>${formatAnalyticsRate(result.calibration.position.switchRate)}</strong><small>${result.calibration.position.switched}/${result.calibration.position.compared} repeats</small></div><div class="analytics-row"><span>Rating mean delta</span><strong>${formatAnalyticsNumber(result.calibration.ratingMeanAbsoluteDelta)}</strong><small>${result.calibration.ratingComparisons} ratings compared</small></div>`
    : `<div class="analytics-empty">${escapeHtml(result.limitations.find((note) => /Calibration/.test(note)) || "No completed calibration repeat pair yet.")}</div>`;

  $("#analytics-limitations").innerHTML = result.limitations.length
    ? result.limitations.map((note) => `<li>${escapeHtml(note)}</li>`).join("")
    : "<li>Rates are calculated from the current filters and saved local records.</li>";
}

function updateAnalyticsFilter(field, value) {
  analyticsFilters = { ...analyticsFilters, [field]: value };
  persistAnalyticsFilters();
  renderAnalytics();
}

function renderHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const filter = $("#history-filter").value;
  const filtered = evaluations
    .filter((evaluation) => matchesHistoryFilter(evaluation, filter))
    .filter((evaluation) => {
      const haystack = [evaluation.title, evaluation.prompt, evaluation.notes, ...evaluation.tags].join(" ").toLowerCase();
      return !query || haystack.includes(query);
    })
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

  if (!filtered.length) {
    $("#history-list").innerHTML = `
      <div class="empty-state"><strong>${filter === "sample" ? "No demo samples" : filter === "user" ? "No user evaluations" : "No matching evaluations"}</strong>Try a different search or create a new evaluation.</div>
    `;
    return;
  }

  $("#history-list").innerHTML = filtered.map((evaluation) => {
    const verdict = evaluation.winner === "pending" ? "—" : evaluation.winner === "tie" ? "=" : evaluation.winner;
    const verdictLabel = evaluation.winner === "pending" ? "In progress" : evaluation.winner === "tie" ? "Effective tie" : `Response ${evaluation.winner}`;
    return `
      <article class="history-item">
        <div class="history-main">
          <span>${escapeHtml(formatDate(evaluation.updatedAt || evaluation.createdAt))} · ${escapeHtml(evaluation.status)}${evaluation.isSample ? " · Sample" : ""}</span>
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
          <button type="button" data-duplicate="${escapeHtml(evaluation.id)}" title="Duplicate evaluation" aria-label="Duplicate ${escapeHtml(evaluation.title)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8V5h11v11h-3v3H5V8zm2 0h6v6h1V7h-9v1zm-3 2v7h7v-7z" /></svg>
          </button>
          <button class="delete" type="button" data-delete="${escapeHtml(evaluation.id)}" title="Delete evaluation" aria-label="Delete ${escapeHtml(evaluation.title)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6V4h10v2h3v2h-1l-1 13H6L5 8H4V6zm1 2 .8 11h6.4L16 8z" /></svg>
          </button>
        </div>
      </article>
    `;
  }).join("");
}

const queueStatusLabels = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  skipped: "Skipped"
};

function persistQueue(candidate, message = "Review queue updated") {
  const transaction = commitQueue(candidate, reviewQueue);
  if (!transaction.ok) {
    showDataNotice("error", "The review queue could not be saved. Your current queue remains unchanged.");
    showToast("Queue save failed");
    return false;
  }
  reviewQueue = transaction.batch;
  renderQueue();
  renderAnalytics();
  if (message) showToast(message);
  return true;
}

function renderQueue() {
  const progress = queueProgress(reviewQueue);
  const summary = progress.total
    ? `${progress.finished}/${progress.total} finished (${progress.percent}%) · ${progress.pending} pending${progress.inProgress ? ` · ${progress.inProgress} active` : ""}`
    : "No queued cases";
  $("#queue-summary").textContent = summary;
  if (!progress.total) {
    $("#queue-list").innerHTML = `<div class="queue-empty"><strong>Your batch queue is empty</strong><span>Fill both responses, then choose “Add to batch queue” to work through several reviews in sequence.</span></div>`;
    renderSessionHeader();
    return;
  }
  $("#queue-list").innerHTML = reviewQueue.cases.map((item) => `
    <article class="queue-item">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(getRubricProfile(item.rubricId).name)} · added ${escapeHtml(formatDate(item.createdAt))}${item.skipReason ? ` · ${escapeHtml(item.skipReason)}` : ""}</small>
      </div>
      <span class="queue-status ${escapeHtml(item.status)}">${escapeHtml(queueStatusLabels[item.status] || "Pending")}</span>
      <div class="queue-item-actions">
        ${["pending", "in_progress"].includes(item.status) ? `<button class="button ghost" type="button" data-queue-open="${escapeHtml(item.id)}">Open</button><button class="button ghost" type="button" data-queue-skip="${escapeHtml(item.id)}">Skip</button>` : ""}
      </div>
    </article>
  `).join("");
  renderSessionHeader();
}

function renderSessionHeader() {
  const header = $("#review-session-header");
  if (!header) return;
  const assignments = reviewQueue.cases.map((item) => ({ id: item.id, state: item.status === "completed" ? "complete" : item.status }));
  const progress = sessionProgress(assignments);
  const sessionState = completedQueueSession ? "completed" : progress.total ? "active" : "planned";
  const activeIndex = activeQueueCaseId ? assignments.findIndex(({ id }) => id === activeQueueCaseId) : Math.max(0, assignments.findIndex(({ state }) => ["pending", "in_progress"].includes(state)));
  const model = createSessionHeaderModel({
    session: { id: reviewQueue.id, name: reviewQueue.name, state: sessionState, blindMode: false },
    assignments,
    saveState: workstationState.saveState,
    assignmentIndex: activeIndex
  });
  $("#session-name").textContent = model.title;
  $("#session-state-label").textContent = `${model.stateLabel} · ${model.blindLabel}`;
  $("#session-position").textContent = model.positionLabel;
  $("#session-progress-label").textContent = `${model.progress.percent}% complete`;
  const progressBar = $(".session-progress-track");
  progressBar.setAttribute("aria-valuenow", String(model.progress.percent));
  $("#session-progress-fill").style.width = `${model.progress.percent}%`;
  const blindIndicator = $("#session-blind-indicator");
  blindIndicator.textContent = model.blindLabel;
  blindIndicator.className = `session-chip ${model.blind ? "blind" : "standard"}`;
  const saveIndicator = $("#workstation-save-state");
  saveIndicator.className = `session-save-state ${model.saveState} ${saveStateTone(model.saveState)}`;
  saveIndicator.querySelector("span").textContent = model.saveLabel;
  const completeButton = $("#complete-session");
  completeButton.hidden = !model.canCompleteSession || completedQueueSession;
  const active = Boolean(activeQueueCaseId);
  $("#previous-case").disabled = !active;
  $("#skip-current-case").disabled = !active;
}

function completeReviewSession() {
  const assignments = reviewQueue.cases.map((item) => ({ id: item.id, state: item.status === "completed" ? "complete" : item.status }));
  const progress = sessionProgress(assignments);
  if (!progress.total || progress.pending || progress.inProgress) {
    showToast("Finish or skip every queue case before completing the session");
    return;
  }
  completedQueueSession = true;
  persistWorkstationMeta();
  renderSessionHeader();
  showDataNotice("success", "Review session completed. Results remain stored locally; revealing candidate metadata is a separate step.");
  showToast("Review session completed");
}

function datasetNameFromFile(fileName) {
  const base = String(fileName || "Imported dataset").split(/[\\/]/).pop() || "Imported dataset";
  return base.replace(/\.(csv|jsonl|ndjson|json)$/i, "") || "Imported dataset";
}

function renderDatasets() {
  const summary = datasetLibrarySummary(datasets);
  const count = $("#dataset-count");
  const list = $("#dataset-list");
  if (!count || !list) return;
  count.textContent = `${summary.datasets} dataset${summary.datasets === 1 ? "" : "s"} · ${summary.cases} case${summary.cases === 1 ? "" : "s"}`;
  const navCount = $("#dataset-nav-count");
  if (navCount) navCount.textContent = summary.datasets;
  if (!summary.datasets) {
    list.innerHTML = `<div class="dataset-empty"><strong>No datasets yet</strong><span>Import a CSV, JSON, or JSONL response-pair file to create a reusable review batch.</span></div>`;
    return;
  }
  list.innerHTML = datasets
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .map((dataset) => `
      <article class="dataset-card">
        <div class="dataset-card-main">
          <div class="dataset-card-title"><strong>${escapeHtml(dataset.name)}</strong>${dataset.isDemo ? `<span class="dataset-badge">Demo</span>` : ""}</div>
          <p>${escapeHtml(dataset.description || "No description provided.")}</p>
          <div class="dataset-meta">
            <span>${datasetCaseCount(dataset)} case${datasetCaseCount(dataset) === 1 ? "" : "s"}</span>
            <span>${escapeHtml(getRubricProfile(dataset.rubricId).name)}</span>
            <span>Created ${escapeHtml(formatDate(dataset.createdAt))}</span>
            ${dataset.sourceFile ? `<span title="${escapeHtml(dataset.sourceFile)}">${escapeHtml(dataset.sourceFile)}</span>` : ""}
          </div>
        </div>
        <div class="dataset-card-action"><span class="dataset-id" title="${escapeHtml(dataset.id)}">${escapeHtml(dataset.id.slice(0, 10))}</span></div>
      </article>
    `).join("");
}

function renderDatasetImportDialog() {
  const dialog = $("#dataset-import-dialog");
  if (!dialog) return;
  const state = pendingDatasetImport;
  const plan = state.plan;
  const summary = plan
    ? `${plan.accepted} accepted · ${plan.duplicates} duplicate · ${plan.warnings} warning${plan.warnings === 1 ? "" : "s"} · ${plan.rejected} rejected`
    : state.state === "reading" ? "Reading file…" : "Choose a response-pair dataset to preview.";
  $("#dataset-import-filename").textContent = state.fileName || "—";
  $("#dataset-import-summary").textContent = summary;
  $("#dataset-import-state").textContent = state.state.replaceAll("_", " ");
  $("#dataset-import-state").dataset.kind = state.state === "error" ? "error" : state.state === "success" ? "success" : "neutral";
  const detail = state.error
    || (state.result ? `${state.result.accepted} new cases saved to the library. ${state.result.duplicates} duplicate cases skipped.` : plan ? "Preview only: no local data has changed. Review the issues below before applying." : "");
  $("#dataset-import-detail").textContent = detail;
  $("#dataset-import-detail").dataset.kind = state.error ? "error" : state.result ? "success" : "neutral";
  const nameInput = $("#dataset-name");
  if (plan && !nameInput.value) nameInput.value = datasetNameFromFile(state.fileName);
  const issues = datasetImportIssueRows(plan, 100);
  $("#dataset-import-issues").innerHTML = issues.length
    ? `<div class="dataset-issues-heading">First ${issues.length} issue${issues.length === 1 ? "" : "s"}</div><div class="dataset-issues-table"><div class="dataset-issue-row dataset-issue-head"><span>Line</span><span>Field</span><span>Issue</span><span>Severity</span></div>${issues.map((item) => `<div class="dataset-issue-row"><span>${escapeHtml(item.line)}</span><span>${escapeHtml(item.field || "—")}</span><span title="${escapeHtml(item.message)}">${escapeHtml(item.message)}</span><span class="issue-${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span></div>`).join("")}</div>`
    : plan ? `<p class="dataset-issues-clear">No validation issues found.</p>` : "";
  $("#download-rejected-rows").hidden = !plan?.rejectedRows?.length;
  const applyButton = $("#apply-dataset-import");
  applyButton.disabled = !canApplyDatasetImport(state) || state.state === "applying";
  applyButton.textContent = state.state === "success" ? "Close" : state.state === "applying" ? "Applying…" : "Apply dataset";
  $("#cancel-dataset-import").disabled = state.state === "applying";
  nameInput.disabled = ["applying", "success"].includes(state.state);
  $("#dataset-description").disabled = ["applying", "success"].includes(state.state);
}

function queueCurrentCase() {
  syncCurrentFromForm();
  try {
    const result = enqueueCase(reviewQueue, {
      title: current.title || titleFromPrompt(current.prompt),
      prompt: current.prompt,
      responseA: current.responseA,
      responseB: current.responseB,
      rubricId: current.rubricId
    });
    if (result.duplicate) {
      showToast("This prompt and response pair is already in the queue");
      return;
    }
    completedQueueSession = false;
    persistWorkstationMeta();
    persistQueue(result.batch, "Added to the review queue");
  } catch (error) {
    showToast(error.message || "Add both responses before queueing this case");
  }
}

function openQueueCase(caseId) {
  const item = reviewQueue.cases.find((candidate) => candidate.id === caseId);
  if (!item) return;
  const result = startCase(reviewQueue, caseId);
  if (result.queuedCase) persistQueue(result.batch, null);
  activeQueueCaseId = caseId;
  persistWorkstationMeta();
  const blank = createBlankEvaluation(undefined, item.rubricId);
  populateForm(normalizeEvaluation({
    ...blank,
    title: item.title,
    prompt: item.prompt,
    responseA: item.responseA,
    responseB: item.responseB
  }));
  setDirty();
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Queue case opened");
}

function skipQueueCase(caseId) {
  const item = reviewQueue.cases.find((candidate) => candidate.id === caseId);
  if (!item) return;
  const open = () => {
    pendingSkipCaseId = caseId;
    skipReturnFocus = document.activeElement;
    $("#skip-title").textContent = `Skip “${item.title}”?`;
    $("#skip-reason").value = "";
    $("#skip-error").hidden = true;
    $("#skip-dialog").showModal();
    $("#skip-reason").focus();
  };
  if (formIsDirty) runOrConfirmUnsaved(open, document.activeElement);
  else open();
}

function closeSkipDialog() {
  const returnFocus = skipReturnFocus;
  pendingSkipCaseId = null;
  skipReturnFocus = null;
  closeDialogAndRestoreFocus($("#skip-dialog"), returnFocus);
}

function acceptSkip() {
  if (!pendingSkipCaseId) return;
  const reason = $("#skip-reason").value.trim();
  if (!reason) {
    $("#skip-error").hidden = false;
    $("#skip-reason").focus();
    return;
  }
  const caseId = pendingSkipCaseId;
  const result = skipCase(reviewQueue, caseId, reason);
  const saved = persistQueue(result.batch, "Queue case skipped");
  if (saved && activeQueueCaseId === caseId) {
    activeQueueCaseId = null;
    resetCurrent({ scroll: false });
  }
  closeSkipDialog();
}

function openPreviousQueueCase() {
  if (!activeQueueCaseId) return;
  const index = reviewQueue.cases.findIndex((item) => item.id === activeQueueCaseId);
  if (index < 0) return;
  const previous = [...reviewQueue.cases.slice(0, index).reverse(), ...reviewQueue.cases.slice(index + 1).reverse()]
    .find((item) => ["pending", "in_progress", "completed"].includes(item.status));
  if (previous) runOrConfirmUnsaved(() => openQueueCase(previous.id), $("#previous-case"));
}

function clearQueue() {
  if (!reviewQueue.cases.length) return;
  askConfirmation({
    title: "Clear the review queue?",
    message: "All queued cases will be removed from this browser. Saved evaluations are not affected.",
    confirmLabel: "Clear queue",
    trigger: $("#clear-queue"),
    onConfirm: () => {
      const saved = persistQueue(createBatch({ id: reviewQueue.id, name: reviewQueue.name, rubricId: reviewQueue.rubricId, createdAt: reviewQueue.createdAt }), "Review queue cleared");
      if (saved) {
        activeQueueCaseId = null;
        completedQueueSession = false;
        persistWorkstationMeta();
        renderSessionHeader();
      }
    }
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast span").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function resetCurrent({ scroll = true } = {}) {
  autosave.cancel();
  activeQueueCaseId = null;
  persistWorkstationMeta();
  populateForm(createBlankEvaluation());
  setReady();
  if (scroll) $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function duplicateEvaluation(evaluation) {
  activeQueueCaseId = null;
  const blank = createBlankEvaluation();
  const duplicate = normalizeEvaluation({
    ...structuredClone(evaluation),
    id: blank.id,
    title: `${evaluation.title || titleFromPrompt(evaluation.prompt)} (copy)`,
    createdAt: null,
    updatedAt: null,
    status: "draft"
  });
  if (!duplicate) return;

  const transaction = commitEvaluations([duplicate, ...evaluations], evaluations);
  if (!transaction.ok) {
    setSaveError();
    showToast("Could not duplicate locally. Your evaluations were not changed.");
    return;
  }

  evaluations = transaction.evaluations;
  populateForm(duplicate);
  setSaved();
  renderMetrics();
  renderHistory();
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("Evaluation duplicated as a draft");
}

function updateOnboarding() {
  const panel = $("#onboarding-panel");
  if (!panel) return;
  const storageError = Boolean(initialState.error);
  const hasSamples = hasDemoEvaluations(evaluations);
  const copy = onboardingCopy({ hasSamples, storageError });
  panel.hidden = hasUserEvaluations(evaluations) && !storageError;
  panel.dataset.state = copy.tone;
  $("#onboarding-title").textContent = copy.title;
  $("#onboarding-description").textContent = copy.description;
  $("#onboarding-reset-demo").hidden = !hasSamples;
  ["#onboarding-import", "#onboarding-load-demo", "#onboarding-create"].forEach((selector) => {
    $(selector).disabled = storageError;
  });
}

function loadDemoDataset() {
  const result = seedDemoEvaluations(evaluations, sampleEvaluations);
  if (!result.added) {
    showToast("The demo dataset is already loaded");
    return;
  }
  const transaction = commitEvaluations(result.evaluations, evaluations);
  if (!transaction.ok) {
    setSaveError();
    showToast("Could not load the demo dataset. Your library was not changed.");
    return;
  }
  evaluations = transaction.evaluations;
  renderMetrics();
  renderHistory();
  updateOnboarding();
  showDataNotice("info", "Demo data is marked as sample and excluded from user metrics and default exports. Add your own response pair when ready.");
  showToast(`${result.added} demo reviews loaded`);
}

function resetDemoDataset() {
  if (!hasDemoEvaluations(evaluations)) return;
  askConfirmation({
    title: "Reset demo data?",
    message: "Only records marked as demo samples will be removed. Your own evaluations will stay in this browser.",
    confirmLabel: "Reset demo",
    trigger: $("#onboarding-reset-demo"),
    onConfirm: () => {
      const result = removeDemoEvaluations(evaluations);
      const transaction = commitEvaluations(result.evaluations, evaluations);
      if (!transaction.ok) {
        setSaveError();
        showToast("Could not reset demo data. Your library was not changed.");
        return;
      }
      evaluations = transaction.evaluations;
      renderMetrics();
      renderHistory();
      updateOnboarding();
      showToast(`${result.removed} demo review${result.removed === 1 ? "" : "s"} removed`);
    }
  });
}

function focusFirstCase() {
  runOrConfirmUnsaved(() => {
    resetCurrent({ scroll: false });
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    fields.prompt.focus();
  }, $("#onboarding-create"));
}

function datasetFormatForFile(file) {
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  return "auto";
}

function datasetRecordToQueueValue(record) {
  return {
    title: titleFromPrompt(record.input),
    prompt: record.input,
    responseA: record.candidates[0].content,
    responseB: record.candidates[1].content,
    rubricId: "general"
  };
}

async function importDatasetFile(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  $("#dataset-name").value = "";
  $("#dataset-description").value = "";
  pendingDatasetImport = beginDatasetImport(file.name);
  renderDatasetImportDialog();
  $("#dataset-import-dialog").showModal();
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error("This file is larger than the 5 MB import limit.");
    const plan = parseDatasetImport(await file.text(), { format: datasetFormatForFile(file) });
    pendingDatasetImport = datasetImportPreview(file.name, plan);
  } catch (error) {
    pendingDatasetImport = failDatasetImport(pendingDatasetImport, error);
  }
  renderDatasetImportDialog();
}

function closeDatasetImportDialog() {
  const dialog = $("#dataset-import-dialog");
  if (pendingDatasetImport.state === "applying") {
    askConfirmation({
      title: "Import is still applying",
      message: "Leaving now may interrupt the local save. Keep the preview open until the import finishes.",
      confirmLabel: "Leave import",
      trigger: $("#cancel-dataset-import"),
      onConfirm: () => dialog.close()
    });
    return;
  }
  dialog.close();
}

function applyPendingDatasetImport() {
  if (!canApplyDatasetImport(pendingDatasetImport)) return;
  if (formIsDirty) {
    runOrConfirmUnsaved(applyPendingDatasetImport, $("#apply-dataset-import"));
    return;
  }
  pendingDatasetImport = startDatasetImportApply(pendingDatasetImport);
  renderDatasetImportDialog();

  const plan = pendingDatasetImport.plan;
  const name = $("#dataset-name").value.trim() || datasetNameFromFile(pendingDatasetImport.fileName);
  const description = $("#dataset-description").value.trim();
  const applyPlan = createDatasetApplyPlan(datasets, plan, {
    name,
    description,
    rubricId: "general",
    sourceFile: pendingDatasetImport.fileName
  });
  if (!applyPlan.dataset) {
    pendingDatasetImport = failDatasetImport(pendingDatasetImport, "No new cases can be added. All accepted rows already exist in the dataset library.");
    renderDatasetImportDialog();
    return;
  }

  const previousDatasets = structuredClone(datasets);
  const datasetTransaction = commitDatasetCollection([...datasets, applyPlan.dataset], datasets);
  if (!datasetTransaction.ok) {
    pendingDatasetImport = failDatasetImport(pendingDatasetImport, "The dataset could not be saved locally. Your preview is still available; free browser storage and try again.");
    showDataNotice("error", "Dataset save failed. No dataset or queue changes were kept.", { persistent: true });
    renderDatasetImportDialog();
    return;
  }

  let nextQueue = structuredClone(reviewQueue);
  const queuedCases = [];
  try {
    for (const { record } of applyPlan.acceptedRows) {
      const result = enqueueCase(nextQueue, datasetRecordToQueueValue(record));
      nextQueue = result.batch;
      if (!result.duplicate) queuedCases.push(result.queuedCase);
    }
    const queueTransaction = commitQueue(nextQueue, reviewQueue);
    if (!queueTransaction.ok) throw new Error("The review queue could not be saved.");
    datasets = datasetTransaction.datasets;
    reviewQueue = queueTransaction.batch;
  } catch (error) {
    commitDatasetCollection(previousDatasets, datasets);
    pendingDatasetImport = failDatasetImport(pendingDatasetImport, error.message || "The import could not be completed.");
    showDataNotice("error", "Import failed before the queue was saved. The dataset write was rolled back.", { persistent: true });
    renderDatasetImportDialog();
    return;
  }

  const first = queuedCases[0];
  renderDatasets();
  renderQueue();
  if (first) openQueueCase(first.id);
  pendingDatasetImport = finishDatasetImportApply(pendingDatasetImport, {
    accepted: applyPlan.accepted,
    duplicates: plan.duplicates + applyPlan.duplicates,
    rejected: plan.rejected,
    warnings: plan.warnings,
    datasetId: applyPlan.dataset.id,
    caseCount: datasetCaseCount(applyPlan.dataset)
  });
  renderDatasetImportDialog();
  showDataNotice(plan.rejected || plan.warnings ? "info" : "success", `${applyPlan.accepted} new case${applyPlan.accepted === 1 ? "" : "s"} saved to ${name}. ${plan.duplicates + applyPlan.duplicates} duplicate${plan.duplicates + applyPlan.duplicates === 1 ? "" : "s"} skipped${plan.rejected ? `; ${plan.rejected} rejected row${plan.rejected === 1 ? "" : "s"} not imported` : ""}.`);
  updateOnboarding();
}

function downloadDatasetTemplate(format) {
  if (format === "csv") {
    downloadTextFile("evalforge-response-pairs-template.csv", DATASET_TEMPLATE_CSV, "text/csv");
    showToast("CSV response-pair template downloaded");
    return;
  }
  downloadTextFile("evalforge-response-pairs-template.jsonl", `${DATASET_TEMPLATE_JSONL}\n`, "application/x-ndjson");
  showToast("JSONL response-pair template downloaded");
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
  setImportFeedback("neutral", "Reading export…", "Checking the file before showing a restore preview.");

  try {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("This file is larger than the 5 MB import limit.");
    }
    pendingImport = parseEvaluationImport(await file.text());
    $("#import-mode").value = "merge";
    $("#apply-import").disabled = false;
    $("#import-detail").dataset.kind = "success";
    updateImportPreview();
  } catch (error) {
    setImportFeedback("error", "Import unavailable", error.message || "EvalForge could not read this file.");
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

function createAuditExportSnapshot() {
  return createBrowserAuditExports({
    document: activeV3Document() || undefined,
    evaluations,
    queueCases: reviewQueue.cases,
    includeSamples: Boolean($("#audit-include-samples")?.checked),
    generatedAt: new Date().toISOString()
  });
}

function exportAuditArtifact(kind) {
  try {
    const output = createAuditExportSnapshot();
    const includeSamples = output.bundle.includeSamples;
    const suffix = includeSamples ? "-with-samples" : "";
    if (kind === "json") {
      downloadTextFile(`evalforge-audit-v1${suffix}.json`, `${JSON.stringify(output.bundle, null, 2)}\n`, "application/json");
      showToast(`Audit bundle downloaded${includeSamples ? " with demo samples" : ""}`);
      return;
    }
    if (kind === "csv") {
      downloadTextFile(`evalforge-analysis${suffix}.csv`, `${output.csv}\n`, "text/csv");
      showToast(`Analysis CSV downloaded${includeSamples ? " with demo samples" : ""}`);
      return;
    }
    downloadTextFile(`evalforge-audit-summary${suffix}.md`, output.markdown, "text/markdown");
    showToast(`Audit summary downloaded${includeSamples ? " with demo samples" : ""}`);
  } catch (error) {
    showDataNotice("error", `Audit export failed: ${error.message || "the local records could not be packaged"}.`);
    showToast("Audit export failed");
  }
}

function renderV3StorageStatus(summary) {
  const container = $("#v3-storage-status");
  const label = $("#v3-storage-label");
  const detail = $("#v3-storage-detail");
  if (!container || !label || !detail) return;
  container.dataset.status = summary.status || "idle";
  label.textContent = summary.label;
  detail.textContent = summary.detail;
}

function renderV3WorkspaceToggle() {
  const toggle = $("#use-v3-workspace");
  if (!toggle) return;
  toggle.disabled = v3ReadState?.status !== "ready";
  toggle.checked = useV3Workspace;
}

function runtimeId() {
  runtimeIdCounter += 1;
  return `local-${Date.now().toString(36)}-${runtimeIdCounter}`;
}

function renderV3WorkspaceActions() {
  const bootstrapButton = $("#bootstrap-v3-workspace");
  const checkButton = $("#check-v3-workspace");
  if (!bootstrapButton || !checkButton) return;
  const busy = v3BootstrapState?.status === "running" || v3ReadState?.status === "checking";
  const ready = v3ReadState?.status === "ready";
  bootstrapButton.disabled = busy || ready;
  checkButton.disabled = busy;
  if (v3BootstrapState?.status === "running") bootstrapButton.textContent = "Initializing…";
  else if (ready) bootstrapButton.textContent = "v3 workspace ready";
  else if (v3BootstrapState?.status === "failed") bootstrapButton.textContent = "Retry v3 initialization";
  else bootstrapButton.textContent = "Initialize v3 workspace";
}

function v3DocumentReady() {
  return v3ReadState?.status === "ready" && v3ReadState.document;
}

function v3DraftForAssignment(assignment, reviewCase, rubric) {
  const existingDraft = v3SessionState?.drafts?.[assignment.id];
  if (existingDraft) return existingDraft;
  const persistedReviews = v3DocumentReady()?.reviews || [];
  const persisted = (assignment.reviewId && persistedReviews.find((review) => review.id === assignment.reviewId))
    || persistedReviews
      .filter((review) => review.assignmentId === assignment.id)
      .sort((left, right) => right.revision - left.revision || String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  const draft = persisted ? reviewDraftFromPersisted(reviewCase, rubric, persisted) : createEmptyV3Draft(reviewCase, rubric);
  if (v3SessionState) {
    v3SessionState = { ...v3SessionState, drafts: { ...(v3SessionState.drafts || {}), [assignment.id]: draft } };
  }
  return draft;
}

function v3ReviewMarkup(reviewCase, rubric, assignment, draft) {
  const input = buildV3ReviewInput(reviewCase, rubric, draft);
  const candidateCount = assignment.displayOrder.length;
  const locked = ["complete", "skipped"].includes(assignment.state);
  const disabled = locked || v3MutationInFlight ? " disabled" : "";
  const completionDisabled = !input.ready || v3MutationInFlight ? " disabled" : "";
  const scoreSummary = input.computed.winner === "pending"
    ? "Complete all ratings to calculate a winner"
    : assignment.displayOrder.map((candidateId, slot) => `Candidate ${slot + 1}: ${input.computed.scoreByCandidate[candidateId]}/100`).join(" · ");
  const preferenceDisagrees = input.preference !== "pending"
    && input.preference !== "tie"
    && input.computed.winner !== "pending"
    && input.computed.winner !== "tie"
    && input.preference !== input.computed.winner;
  const ratingRows = rubric.dimensions.map((dimension) => `<div class="v3-rating-row"><div><strong>${escapeHtml(dimension.label)}</strong><small>${escapeHtml(dimension.description || "Rate this dimension")}</small></div>${Array.from({ length: candidateCount }, (_, slot) => `<div class="v3-rating-cell"><span>Candidate ${slot + 1}</span><div class="v3-rating-buttons" role="group" aria-label="${escapeHtml(dimension.label)} for Candidate ${slot + 1}">${[1, 2, 3, 4, 5].map((rating) => `<button class="v3-rating-button${input.ratings[assignment.displayOrder[slot]]?.[dimension.id] === rating ? " selected" : ""}" type="button" data-v3-rating data-v3-slot="${slot}" data-v3-dimension="${escapeHtml(dimension.id)}" data-v3-value="${rating}" aria-pressed="${input.ratings[assignment.displayOrder[slot]]?.[dimension.id] === rating ? "true" : "false"}"${disabled}>${rating}</button>`).join("")}</div></div>`).join("")}</div>`).join("");
  const preferenceButtons = Array.from({ length: candidateCount }, (_, slot) => `<button class="button ghost compact${input.preference === assignment.displayOrder[slot] ? " selected" : ""}" type="button" data-v3-preference-slot="${slot}" aria-pressed="${input.preference === assignment.displayOrder[slot] ? "true" : "false"}"${disabled}>Candidate ${slot + 1}</button>`).join("");
  return `<section class="v3-rating-form" style="--v3-candidate-count:${candidateCount}" aria-labelledby="v3-rating-title">
    <div class="v3-rating-heading"><div><span class="section-kicker">Evidence capture</span><h4 id="v3-rating-title">Score this assignment</h4></div><span class="v3-score-summary">${escapeHtml(scoreSummary)}</span></div>
    <div class="v3-rating-table">${ratingRows}</div>
    <div class="v3-review-fields">
      <div class="v3-field-group"><span class="field-label">Your preference</span><div class="v3-preference-buttons">${preferenceButtons}<button class="button ghost compact${input.preference === "tie" ? " selected" : ""}" type="button" data-v3-preference-tie aria-pressed="${input.preference === "tie" ? "true" : "false"}"${disabled}>Tie</button></div></div>
      <label class="field"><span>Confidence</span><select data-v3-confidence aria-label="Confidence"${disabled}><option value="1"${input.confidence === 1 ? " selected" : ""}>1 · Very uncertain</option><option value="2"${input.confidence === 2 ? " selected" : ""}>2 · Somewhat uncertain</option><option value="3"${input.confidence === 3 ? " selected" : ""}>3 · Moderately confident</option><option value="4"${input.confidence === 4 ? " selected" : ""}>4 · Very confident</option><option value="5"${input.confidence === 5 ? " selected" : ""}>5 · Extremely confident</option></select></label>
    </div>
    ${preferenceDisagrees ? `<label class="field v3-preference-evidence-field"><span>Why your preference differs <b aria-hidden="true">*</b></span><textarea data-v3-preference-evidence rows="3" maxlength="20000" placeholder="Explain the evidence behind your preference…"${disabled}>${escapeHtml(input.preferenceEvidence)}</textarea><small class="field-hint"><span>At least 20 characters when your preference differs from the calculated winner.</span><span data-v3-preference-evidence-count>${input.preferenceEvidence.trim().length} characters</span></small></label>` : ""}
    <label class="field v3-rationale-field"><span>Rationale <b aria-hidden="true">*</b></span><textarea data-v3-rationale rows="4" maxlength="20000" placeholder="Explain the evidence behind your decision…"${disabled}>${escapeHtml(input.rationale)}</textarea><small class="field-hint"><span>At least 20 characters for completion.</span><span>${input.rationale.trim().length} characters</span></small></label>
    <div class="v3-review-footer"><span class="v3-review-help">${locked ? "This review is complete and read-only." : input.ready ? "Ready to complete." : escapeHtml(input.missing[0] || "Save a draft to keep your progress.")}</span><div>${locked ? "" : `<button id="v3-save-draft" class="button ghost compact" type="button"${v3MutationInFlight ? " disabled" : ""}>Save draft</button><button id="v3-complete-review" class="button primary compact" type="button"${completionDisabled}>Complete review</button>`}</div></div>
  </section>`;
}

function renderV3ReviewPanel() {
  const panel = $("#v3-review-panel");
  if (!panel) return;
  const document = v3DocumentReady();
  let restoredSession = false;
  panel.hidden = !document;
  if (!document) {
    v3SessionState = null;
    return;
  }

  if (!v3SessionState) {
    const restored = restoreV3SessionState(document);
    if (restored) {
      v3SessionState = { ...restored, drafts: {}, revisions: restored.revisions || {} };
      restoredSession = true;
    }
  }

  const datasetSelect = $("#v3-dataset-select");
  const options = v3DatasetOptions(document);
  const previousDataset = datasetSelect.value;
  datasetSelect.innerHTML = options.length
    ? options.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${item.caseCount} case${item.caseCount === 1 ? "" : "s"}${item.isDemo ? " · Demo" : ""}</option>`).join("")
    : `<option value="">No reviewable datasets</option>`;
  if (options.some((item) => item.id === previousDataset)) datasetSelect.value = previousDataset;
  else if (options[0]) datasetSelect.value = options[0].id;

  const reviewerInput = $("#v3-reviewer-id");
  if (!reviewerInput.value) reviewerInput.value = "local-reviewer";
  const seedInput = $("#v3-session-seed");
  if (!seedInput.value) seedInput.value = `review-${new Date().toISOString().slice(0, 10)}`;

  const createButton = $("#v3-create-session");
  createButton.disabled = !options.length;
  const status = $("#v3-session-status");
  const session = v3SessionState?.session;
  if (!session) {
    status.textContent = options.length ? "No v3 session yet. Choose a dataset to begin a reproducible blind review." : "Import or migrate a dataset with at least one response pair first.";
    status.dataset.kind = options.length ? "neutral" : "warning";
    $("#v3-assignment-view").innerHTML = `<div class="v3-empty-state"><strong>Ready when you are</strong><span>The session will keep candidate order stable while hiding source and model metadata.</span></div>`;
    $("#v3-previous-assignment").disabled = true;
    $("#v3-next-assignment").disabled = true;
    $("#v3-start-assignment").hidden = true;
    $("#v3-start-assignment").disabled = true;
    $("#v3-complete-session").hidden = true;
    $("#v3-reveal-session").hidden = true;
    return;
  }
  if (restoredSession && options.some((item) => item.id === session.datasetId)) datasetSelect.value = session.datasetId;

  const assignmentView = createV3AssignmentView({
    session: session,
    assignments: v3SessionState.assignments,
    cases: v3SessionState.cases,
    index: v3SessionState.currentIndex
  });
  if (assignmentView.empty) {
    status.textContent = "The saved session has no assignments to review.";
    status.dataset.kind = "warning";
    $("#v3-assignment-view").innerHTML = `<div class="v3-empty-state"><strong>No assignments</strong><span>Create a new session from a dataset containing response pairs.</span></div>`;
    $("#v3-previous-assignment").disabled = true;
    $("#v3-next-assignment").disabled = true;
    $("#v3-start-assignment").hidden = true;
    $("#v3-complete-session").hidden = true;
    $("#v3-reveal-session").hidden = true;
    return;
  }
  const reviewCase = v3SessionState.cases.find((candidate) => candidate.id === assignmentView.caseId);
  const rubric = document.rubrics.find((candidate) => candidate.id === session.rubricRef);
  const draft = v3DraftForAssignment(v3SessionState.assignments[assignmentView.position], reviewCase, rubric);
  const dataset = document.datasets.find((item) => item.id === session.datasetId);
  const resolvedCount = v3SessionState.assignments.filter((assignment) => ["complete", "skipped"].includes(assignment.state)).length;
  const sessionStateLabel = session.state === "revealed" ? "Metadata revealed" : session.state === "completed" ? "Session completed" : "Active blind session";
  status.textContent = `${dataset?.name || "Dataset"} · ${resolvedCount}/${assignmentView.total} resolved · ${sessionStateLabel}`;
  status.dataset.kind = "success";
  createButton.disabled = v3MutationInFlight;
  $("#v3-assignment-view").innerHTML = assignmentView.empty
    ? `<div class="v3-empty-state"><strong>No assignments</strong><span>Create a session from a dataset containing response pairs.</span></div>`
    : `<div class="v3-assignment-meta"><span>Assignment ${assignmentView.position + 1} of ${assignmentView.total}</span><span>${escapeHtml(assignmentView.assignmentState.replaceAll("_", " "))}</span><span>${session.state === "revealed" ? "Metadata revealed for analysis" : "Source hidden until reveal"}</span></div>
      <div class="v3-prompt"><span class="section-kicker">User prompt</span><p>${escapeHtml(assignmentView.view.input)}</p></div>
      <div class="v3-candidate-grid">${assignmentView.view.candidates.map((candidate) => `<article class="v3-candidate"><div class="v3-candidate-heading"><span class="response-label">${escapeHtml(candidate.label.replace("Candidate ", ""))}</span><strong>${escapeHtml(candidate.label)}</strong></div><div class="v3-response-content">${escapeHtml(candidate.content)}</div></article>`).join("")}</div>
      ${rubric ? v3ReviewMarkup(reviewCase, rubric, v3SessionState.assignments[assignmentView.position], draft) : ""}`;
  $("#v3-previous-assignment").disabled = v3MutationInFlight || assignmentView.total < 2;
  $("#v3-next-assignment").disabled = v3MutationInFlight || assignmentView.total < 2;
  const startButton = $("#v3-start-assignment");
  startButton.hidden = assignmentView.assignmentState !== "pending";
  startButton.disabled = v3MutationInFlight || assignmentView.assignmentState !== "pending";
  const completeSessionButton = $("#v3-complete-session");
  completeSessionButton.hidden = session.state !== "active";
  completeSessionButton.disabled = v3MutationInFlight || session.state !== "active" || resolvedCount !== assignmentView.total;
  completeSessionButton.title = resolvedCount === assignmentView.total ? "Mark this review session complete" : `${assignmentView.total - resolvedCount} assignment${assignmentView.total - resolvedCount === 1 ? "" : "s"} remaining`;
  const revealSessionButton = $("#v3-reveal-session");
  revealSessionButton.hidden = !["completed", "revealed"].includes(session.state);
  revealSessionButton.disabled = v3MutationInFlight || session.state === "revealed";
  revealSessionButton.textContent = session.state === "revealed" ? "Metadata revealed" : "Reveal metadata";
}

async function createV3ReviewSession() {
  const document = v3DocumentReady();
  if (!document || v3MutationInFlight) return;
  v3MutationInFlight = true;
  const button = $("#v3-create-session");
  const status = $("#v3-session-status");
  button.disabled = true;
  status.textContent = "Creating a reproducible blind session…";
  status.dataset.kind = "neutral";
  // Re-render immediately so navigation and review controls from a previous
  // session cannot be clicked while the new session is being persisted.
  renderV3ReviewPanel();
  status.textContent = "Creating a reproducible blind session…";
  status.dataset.kind = "neutral";
  let repository = null;
  try {
    const plan = createV3SessionPlan(document, {
      datasetId: $("#v3-dataset-select").value,
      reviewerId: $("#v3-reviewer-id").value,
      seed: $("#v3-session-seed").value,
      now: () => new Date().toISOString(),
      idFactory: runtimeId
    });
    repository = new IndexedDbRepository();
    await repository.transaction(async (transaction) => {
      await transaction.put("sessions", plan.session);
      for (const assignment of plan.assignments) await transaction.put("assignments", assignment);
    }, { stores: ["sessions", "assignments"] });
    const refreshed = await readV3Document();
    if (refreshed.status !== "ready") throw new Error("The new session was saved, but the v3 workspace could not be reloaded.");
    v3ReadState = refreshed;
    v3SessionState = { ...plan, currentIndex: 0, drafts: {}, revisions: {} };
    renderV3ReviewPanel();
    showToast("Blind review session created");
  } catch (error) {
    status.textContent = error.message || "The blind session could not be created.";
    status.dataset.kind = "error";
    showToast("Could not create blind session");
  } finally {
    repository?.close();
    v3MutationInFlight = false;
    renderV3ReviewPanel();
    if (!v3SessionState) button.disabled = false;
  }
}

async function startV3CurrentAssignment() {
  if (!v3SessionState || v3MutationInFlight) return;
  const assignment = v3SessionState.assignments[v3SessionState.currentIndex];
  if (!assignment || assignment.state !== "pending") return;
  v3MutationInFlight = true;
  const button = $("#v3-start-assignment");
  button.disabled = true;
  let repository = null;
  try {
    repository = new IndexedDbRepository();
    const result = await startIndexedDbAssignment(repository, {
      assignmentId: assignment.id,
      now: () => new Date().toISOString(),
      actorId: v3SessionState.session.reviewerId
    });
    v3SessionState = {
      ...v3SessionState,
      assignments: v3SessionState.assignments.map((item) => item.id === result.assignment.id ? result.assignment : item)
    };
    renderV3ReviewPanel();
    showToast("Assignment started");
  } catch (error) {
    $("#v3-session-status").textContent = error.message || "The assignment could not be started.";
    $("#v3-session-status").dataset.kind = "error";
    showToast("Could not start assignment");
  } finally {
    repository?.close();
    v3MutationInFlight = false;
    renderV3ReviewPanel();
  }
}

function moveV3Assignment(direction) {
  if (!v3SessionState || v3MutationInFlight) return;
  v3SessionState = { ...v3SessionState, currentIndex: nextV3AssignmentIndex(v3SessionState.assignments, v3SessionState.currentIndex, direction) };
  renderV3ReviewPanel();
}

async function completeV3Session() {
  const session = v3SessionState?.session;
  if (!session || session.state !== "active" || v3MutationInFlight) return;
  v3MutationInFlight = true;
  const button = $("#v3-complete-session");
  button.disabled = true;
  $("#v3-session-status").textContent = "Completing review session…";
  $("#v3-session-status").dataset.kind = "neutral";
  let repository = null;
  try {
    repository = new IndexedDbRepository();
    const result = await completeIndexedDbSession(repository, {
      sessionId: session.id,
      now: () => new Date().toISOString(),
      actorId: session.reviewerId
    });
    const refreshed = await readV3Document();
    if (refreshed.status !== "ready") throw new Error("The session was completed, but the v3 workspace could not be reloaded.");
    v3ReadState = refreshed;
    v3SessionState = { ...v3SessionState, session: result.session };
    renderV3ReviewPanel();
    showToast("Review session completed");
  } catch (error) {
    $("#v3-session-status").textContent = error.message || "The review session could not be completed.";
    $("#v3-session-status").dataset.kind = error.code === "incomplete_session" ? "warning" : "error";
    showToast("Could not complete review session");
  } finally {
    repository?.close();
    v3MutationInFlight = false;
    renderV3ReviewPanel();
    button.disabled = false;
  }
}

async function revealV3Session() {
  const session = v3SessionState?.session;
  if (!session || session.state !== "completed" || v3MutationInFlight) return;
  v3MutationInFlight = true;
  const button = $("#v3-reveal-session");
  button.disabled = true;
  $("#v3-session-status").textContent = "Revealing metadata for analysis…";
  $("#v3-session-status").dataset.kind = "neutral";
  let repository = null;
  try {
    repository = new IndexedDbRepository();
    const result = await revealIndexedDbSession(repository, {
      sessionId: session.id,
      now: () => new Date().toISOString(),
      actorId: session.reviewerId
    });
    const refreshed = await readV3Document();
    if (refreshed.status !== "ready") throw new Error("Metadata was revealed, but the v3 workspace could not be reloaded.");
    v3ReadState = refreshed;
    v3SessionState = { ...v3SessionState, session: result.session };
    renderV3ReviewPanel();
    showToast("Metadata reveal recorded");
  } catch (error) {
    $("#v3-session-status").textContent = error.message || "Metadata could not be revealed.";
    $("#v3-session-status").dataset.kind = "error";
    showToast("Could not reveal metadata");
  } finally {
    repository?.close();
    v3MutationInFlight = false;
    renderV3ReviewPanel();
    button.disabled = false;
  }
}

function currentV3ReviewContext() {
  if (!v3SessionState) return null;
  const assignment = v3SessionState.assignments[v3SessionState.currentIndex];
  const reviewCase = v3SessionState.cases.find((candidate) => candidate.id === assignment?.caseId);
  const rubric = v3DocumentReady()?.rubrics?.find((candidate) => candidate.id === v3SessionState.session.rubricRef);
  if (!assignment || !reviewCase || !rubric) return null;
  const draft = v3DraftForAssignment(assignment, reviewCase, rubric);
  return { assignment, reviewCase, rubric, draft, input: buildV3ReviewInput(reviewCase, rubric, draft) };
}

function patchCurrentV3Draft(patch) {
  const context = currentV3ReviewContext();
  if (!context) return null;
  const nextDraft = { ...context.draft, ...patch };
  v3SessionState = { ...v3SessionState, drafts: { ...(v3SessionState.drafts || {}), [context.assignment.id]: nextDraft } };
  return nextDraft;
}

async function persistV3Review(mode) {
  if (v3MutationInFlight) return;
  const context = currentV3ReviewContext();
  if (!context) return;
  if (mode === "complete" && !context.input.ready) {
    $("#v3-session-status").textContent = context.input.missing[0] || "Finish the review before completing it.";
    $("#v3-session-status").dataset.kind = "warning";
    showToast("Finish the required evidence first");
    return;
  }
  const saveButton = $(mode === "complete" ? "#v3-complete-review" : "#v3-save-draft");
  v3MutationInFlight = true;
  if (saveButton) saveButton.disabled = true;
  $("#v3-session-status").textContent = mode === "complete" ? "Completing review…" : "Saving draft…";
  $("#v3-session-status").dataset.kind = "neutral";
  let repository = null;
  try {
    repository = new IndexedDbRepository();
    const expectedRevision = v3SessionState.revisions?.[context.assignment.id] ?? 0;
    const operation = mode === "complete" ? completeIndexedDbReview : saveIndexedDbDraft;
    const result = await operation(repository, {
      assignmentId: context.assignment.id,
      review: context.input,
      expectedRevision,
      now: () => new Date().toISOString(),
      actorId: v3SessionState.session.reviewerId
    });
    const refreshed = await readV3Document();
    if (refreshed.status !== "ready") throw new Error("The review was saved, but the v3 workspace could not be reloaded.");
    v3ReadState = refreshed;
    v3SessionState = {
      ...v3SessionState,
      assignments: v3SessionState.assignments.map((item) => item.id === result.assignment.id ? result.assignment : item),
      revisions: { ...(v3SessionState.revisions || {}), [context.assignment.id]: result.review.revision },
      drafts: { ...(v3SessionState.drafts || {}), [context.assignment.id]: reviewDraftFromPersisted(context.reviewCase, context.rubric, result.review) }
    };
    renderV3ReviewPanel();
    showToast(mode === "complete" ? "v3 review completed" : "v3 draft saved");
  } catch (error) {
    $("#v3-session-status").textContent = error.message || "The v3 review could not be saved.";
    $("#v3-session-status").dataset.kind = error.code === "stale_revision" ? "warning" : "error";
    showToast(mode === "complete" ? "Could not complete review" : "Could not save draft");
  } finally {
    repository?.close();
    v3MutationInFlight = false;
    renderV3ReviewPanel();
    if (saveButton) saveButton.disabled = false;
  }
}

function handleV3ReviewClick(event) {
  if (v3MutationInFlight) return;
  const context = currentV3ReviewContext();
  if (!context) return;
  const ratingButton = event.target.closest("[data-v3-rating]");
  if (ratingButton) {
    const slot = Number(ratingButton.dataset.v3Slot);
    const dimension = ratingButton.dataset.v3Dimension;
    const candidateId = context.assignment.displayOrder[slot];
    if (!candidateId || !dimension) return;
    const ratings = structuredClone(context.draft.ratings);
    ratings[candidateId] = { ...(ratings[candidateId] || {}), [dimension]: Number(ratingButton.dataset.v3Value) };
    patchCurrentV3Draft({ ratings });
    renderV3ReviewPanel();
    return;
  }
  const preferenceButton = event.target.closest("[data-v3-preference-slot]");
  if (preferenceButton) {
    const candidateId = context.assignment.displayOrder[Number(preferenceButton.dataset.v3PreferenceSlot)];
    if (candidateId) patchCurrentV3Draft({ preference: candidateId });
    renderV3ReviewPanel();
    return;
  }
  if (event.target.closest("[data-v3-preference-tie]")) {
    patchCurrentV3Draft({ preference: "tie" });
    renderV3ReviewPanel();
    return;
  }
  if (event.target.closest("#v3-save-draft")) {
    persistV3Review("draft");
    return;
  }
  if (event.target.closest("#v3-complete-review")) persistV3Review("complete");
}

function refreshV3ReviewReadiness() {
  const context = currentV3ReviewContext();
  if (!context) return;
  const input = buildV3ReviewInput(context.reviewCase, context.rubric, context.draft);
  const completeButton = $("#v3-complete-review");
  if (completeButton) completeButton.disabled = !input.ready;
  const help = $("#v3-assignment-view .v3-review-help");
  if (help) help.textContent = input.ready ? "Ready to complete." : (input.missing[0] || "Save a draft to keep your progress.");
  const rationaleCount = $("#v3-assignment-view .v3-rationale-field .field-hint span:last-child");
  if (rationaleCount) rationaleCount.textContent = `${input.rationale.trim().length} characters`;
  const preferenceEvidenceCount = $("#v3-assignment-view [data-v3-preference-evidence-count]");
  if (preferenceEvidenceCount) preferenceEvidenceCount.textContent = `${input.preferenceEvidence.trim().length} characters`;
}

function handleV3ReviewInput(event) {
  if (v3MutationInFlight) return;
  if (event.target.matches("[data-v3-rationale]")) patchCurrentV3Draft({ rationale: event.target.value });
  if (event.target.matches("[data-v3-preference-evidence]")) patchCurrentV3Draft({ preferenceEvidence: event.target.value });
  if (event.target.matches("[data-v3-confidence]")) patchCurrentV3Draft({ confidence: Number(event.target.value) });
  refreshV3ReviewReadiness();
}

async function checkV3Workspace() {
  const button = $("#check-v3-workspace");
  if (!button) return;
  button.disabled = true;
  useV3Workspace = false;
  v3ReadState = { status: "checking" };
  renderV3WorkspaceToggle();
  button.textContent = "Checking…";
  renderV3WorkspaceActions();
  renderV3StorageStatus({ status: "checking", label: "Checking local v3 workspace…", detail: "Reading entity stores without changing browser data." });
  try {
    v3ReadState = await readV3Document();
    renderV3StorageStatus(summarizeV3Read(v3ReadState));
    renderV3WorkspaceToggle();
    renderV3ReviewPanel();
    renderAnalyticsDataSource();
    if (v3ReadState.status === "ready") showToast("Verified v3 workspace is available for read-only analysis");
  } finally {
    button.disabled = false;
    button.textContent = "Check local storage";
    renderV3WorkspaceActions();
  }
}

async function initializeV3Workspace() {
  const button = $("#bootstrap-v3-workspace");
  if (!button) return;
  useV3Workspace = false;
  v3BootstrapState = { status: "running" };
  v3ReadState = null;
  renderV3WorkspaceToggle();
  renderV3WorkspaceActions();
  renderV3StorageStatus({
    status: "checking",
    label: "Initializing v3 workspace…",
    detail: "Creating a local recovery copy, then migrating saved browser data. Existing v2 data is not deleted."
  });
  try {
    const result = await bootstrapV3({
      now: () => new Date().toISOString(),
      idFactory: runtimeId
    });
    v3BootstrapState = result;
    v3ReadState = await readV3Document();
    renderV3ReviewPanel();
    const summary = summarizeV3Read(v3ReadState);
    if (result.status === "completed" && v3ReadState.status === "ready") {
      const report = result.report || {};
      const warningCount = Array.isArray(report.warnings) ? report.warnings.length : 0;
      renderV3StorageStatus({
        status: "ready",
        label: "v3 workspace initialized",
        detail: `${summary.detail} Legacy browser data was retained${warningCount ? `; ${warningCount} migration warning${warningCount === 1 ? "" : "s"} recorded` : ""}.`
      });
      showToast("v3 workspace initialized; enable verified v3 data when ready");
    } else if (v3ReadState.status === "ready") {
      renderV3StorageStatus(summary);
    } else {
      const message = result.error?.message || summary.detail || "The v3 workspace could not be initialized.";
      renderV3StorageStatus({ status: result.status === "failed" ? "error" : summary.status, label: "v3 initialization needs attention", detail: message });
      showToast("v3 workspace initialization needs attention");
    }
  } catch (error) {
    v3BootstrapState = { status: "failed", error };
    renderV3StorageStatus({ status: "error", label: "v3 initialization failed", detail: error.message || "The local v3 workspace could not be initialized." });
    showToast("v3 workspace initialization failed");
  } finally {
    renderV3WorkspaceToggle();
    renderV3WorkspaceActions();
    renderV3ReviewPanel();
  }
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
    scheduleAutosave();
  });

  form.addEventListener("input", () => {
    syncCurrentFromForm();
    setDirty();
    renderCurrent();
    scheduleAutosave();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCurrent("complete");
  });

  $("#save-draft").addEventListener("click", () => saveCurrent("draft"));
  $("#previous-case").addEventListener("click", openPreviousQueueCase);
  $("#skip-current-case").addEventListener("click", () => {
    if (activeQueueCaseId) skipQueueCase(activeQueueCaseId);
  });
  $("#queue-case").addEventListener("click", queueCurrentCase);
  $("#clear-queue").addEventListener("click", clearQueue);
  $("#complete-session").addEventListener("click", completeReviewSession);
  $("#close-skip").addEventListener("click", closeSkipDialog);
  $("#cancel-skip").addEventListener("click", closeSkipDialog);
  $("#accept-skip").addEventListener("click", acceptSkip);
  $("#skip-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeSkipDialog();
  });
  $("#rubric-select").addEventListener("change", (event) => switchRubric(event.currentTarget.value));
  $("#new-evaluation").addEventListener("click", (event) => runOrConfirmUnsaved(() => resetCurrent(), event.currentTarget));
  $("#clear-form").addEventListener("click", (event) => runOrConfirmUnsaved(() => resetCurrent({ scroll: false }), event.currentTarget));
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
    scheduleAutosave();
    fields.prompt.focus();
  });

  $("#history-search").addEventListener("input", renderHistory);
  $("#history-filter").addEventListener("change", renderHistory);

  $("#analytics-dataset-filter").addEventListener("change", (event) => updateAnalyticsFilter("datasetId", event.currentTarget.value));
  $("#analytics-rubric-filter").addEventListener("change", (event) => updateAnalyticsFilter("rubricId", event.currentTarget.value));
  $("#analytics-tag-filter").addEventListener("change", (event) => updateAnalyticsFilter("tag", event.currentTarget.value));
  $("#analytics-reviewer-filter").addEventListener("change", (event) => updateAnalyticsFilter("reviewerId", event.currentTarget.value));
  $("#analytics-date-from").addEventListener("change", (event) => updateAnalyticsFilter("from", event.currentTarget.value));
  $("#analytics-date-to").addEventListener("change", (event) => updateAnalyticsFilter("to", event.currentTarget.value));
  $("#analytics-include-samples").addEventListener("change", (event) => updateAnalyticsFilter("includeSamples", event.currentTarget.checked));

  $("#queue-list").addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-queue-open]");
    const skipButton = event.target.closest("[data-queue-skip]");
    if (openButton) runOrConfirmUnsaved(() => openQueueCase(openButton.dataset.queueOpen), openButton);
    if (skipButton) skipQueueCase(skipButton.dataset.queueSkip);
  });

  $("#history-list").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    const duplicateButton = event.target.closest("[data-duplicate]");
    const deleteButton = event.target.closest("[data-delete]");

    if (duplicateButton) {
      const evaluation = evaluations.find(({ id }) => id === duplicateButton.dataset.duplicate);
      if (!evaluation) return;
      runOrConfirmUnsaved(() => duplicateEvaluation(evaluation), duplicateButton);
      return;
    }

    if (editButton) {
      const evaluation = evaluations.find(({ id }) => id === editButton.dataset.edit);
      if (!evaluation) return;
      runOrConfirmUnsaved(() => {
        activeQueueCaseId = null;
        populateForm(evaluation);
        setSaved();
        $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
      }, editButton);
    }

    if (deleteButton) {
      const evaluation = evaluations.find(({ id }) => id === deleteButton.dataset.delete);
      if (!evaluation) return;
      const deleteEvaluation = () => askConfirmation({
        title: "Delete this evaluation?",
        message: `“${evaluation.title || "Untitled evaluation"}” will be removed from this browser. This action cannot be undone.`,
        confirmLabel: "Delete evaluation",
        trigger: deleteButton,
        onConfirm: () => {
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
      if (current.id === evaluation.id) runOrConfirmUnsaved(deleteEvaluation, deleteButton);
      else deleteEvaluation();
    }
  });

  $("#export-json").addEventListener("click", () => {
    const exportable = evaluations.filter((evaluation) => !evaluation.isSample);
    downloadTextFile("evalforge-evaluations.json", evaluationsToJson(evaluations), "application/json");
    showToast(`Exported ${exportable.length} saved evaluation${exportable.length === 1 ? "" : "s"} as JSON${exportable.length !== evaluations.length ? " · sample records skipped" : ""}`);
  });

  $("#export-csv").addEventListener("click", () => {
    const exportable = evaluations.filter((evaluation) => !evaluation.isSample);
    downloadTextFile("evalforge-evaluations.csv", evaluationsToCsv(evaluations), "text/csv");
    showToast(`Exported ${exportable.length} saved evaluation${exportable.length === 1 ? "" : "s"} as CSV${exportable.length !== evaluations.length ? " · sample records skipped" : ""}`);
  });

  $("#export-audit-json").addEventListener("click", () => exportAuditArtifact("json"));
  $("#export-analysis-csv").addEventListener("click", () => exportAuditArtifact("csv"));
  $("#export-summary-md").addEventListener("click", () => exportAuditArtifact("markdown"));
  $("#bootstrap-v3-workspace").addEventListener("click", initializeV3Workspace);
  $("#check-v3-workspace").addEventListener("click", checkV3Workspace);
  $("#v3-create-session").addEventListener("click", createV3ReviewSession);
  $("#v3-start-assignment").addEventListener("click", startV3CurrentAssignment);
  $("#v3-previous-assignment").addEventListener("click", () => moveV3Assignment(-1));
  $("#v3-next-assignment").addEventListener("click", () => moveV3Assignment(1));
  $("#v3-complete-session").addEventListener("click", completeV3Session);
  $("#v3-reveal-session").addEventListener("click", revealV3Session);
  $("#v3-assignment-view").addEventListener("click", handleV3ReviewClick);
  $("#v3-assignment-view").addEventListener("input", handleV3ReviewInput);
  $("#use-v3-workspace").addEventListener("change", (event) => {
    useV3Workspace = event.currentTarget.checked && v3ReadState?.status === "ready";
    event.currentTarget.checked = useV3Workspace;
    renderAnalytics();
  });

  $("#import-json").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", previewImportFile);
  $("#onboarding-import").addEventListener("click", () => $("#dataset-file").click());
  $("#dataset-import-open").addEventListener("click", () => $("#dataset-file").click());
  $("#dataset-file").addEventListener("change", importDatasetFile);
  $("#onboarding-load-demo").addEventListener("click", loadDemoDataset);
  $("#onboarding-create").addEventListener("click", focusFirstCase);
  $("#onboarding-reset-demo").addEventListener("click", resetDemoDataset);
  $("#download-template-csv").addEventListener("click", () => downloadDatasetTemplate("csv"));
  $("#download-template-jsonl").addEventListener("click", () => downloadDatasetTemplate("jsonl"));
  $("#import-mode").addEventListener("change", updateImportPreview);
  $("#apply-import").addEventListener("click", (event) => runOrConfirmUnsaved(applyPendingImport, event.currentTarget));
  $("#close-import").addEventListener("click", () => $("#import-dialog").close());
  $("#cancel-import").addEventListener("click", () => $("#import-dialog").close());
  $("#close-dataset-import").addEventListener("click", closeDatasetImportDialog);
  $("#cancel-dataset-import").addEventListener("click", closeDatasetImportDialog);
  $("#apply-dataset-import").addEventListener("click", () => {
    if (pendingDatasetImport.state === "success") {
      $("#dataset-import-dialog").close();
      pendingDatasetImport = createDatasetImportDialogState();
      renderDatasetImportDialog();
      return;
    }
    applyPendingDatasetImport();
  });
  $("#download-rejected-rows").addEventListener("click", () => {
    if (!pendingDatasetImport.plan) return;
    downloadTextFile("evalforge-rejected-rows.jsonl", `${rejectedRowsAsJsonl(pendingDatasetImport.plan)}\n`, "application/x-ndjson");
    showToast("Rejected rows downloaded");
  });
  $("#dismiss-data-notice").addEventListener("click", () => {
    $("#data-notice").hidden = true;
    $("#data-notice").dataset.kind = "";
  });

  $("#keep-unsaved").addEventListener("click", () => resolveUnsaved("keep"));
  $("#close-unsaved").addEventListener("click", () => resolveUnsaved("keep"));
  $("#discard-unsaved").addEventListener("click", () => resolveUnsaved("discard"));
  $("#save-unsaved").addEventListener("click", () => resolveUnsaved("save"));
  $("#close-confirm").addEventListener("click", cancelConfirmation);
  $("#cancel-confirm").addEventListener("click", cancelConfirmation);
  $("#accept-confirm").addEventListener("click", acceptConfirmation);
  $("#unsaved-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    resolveUnsaved("keep");
  });
  $("#confirm-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelConfirmation();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!formIsDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.ctrlKey && /^[1-5]$/.test(event.key) && event.target.closest?.(".rating-group")) {
      const group = event.target.closest(".rating-group");
      const button = group.querySelector(`[data-rating="${event.key}"]`);
      if (button) {
        event.preventDefault();
        button.click();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrent("draft");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      saveCurrent("complete");
    }
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
  populateRubricOptions();
  renderRubric();
  renderQuickPrompts();
  renderMethodology();
  bindEvents();
  populateForm(current);
  renderMetrics();
  renderHistory();
  renderQueue();
  renderDatasets();
  renderDatasetImportDialog();
  renderV3ReviewPanel();
  updateOnboarding();
  setReady();

  if (initialState.error) {
    showDataNotice("error", "Local data could not be read. EvalForge opened with an empty workspace; your browser data was not overwritten. Export or repair the profile before adding work.", { persistent: true });
  } else if (initialDatasetState.error) {
    showDataNotice("error", "The Dataset Library could not be read. Existing evaluations are still available; do not clear browser data before exporting anything important.", { persistent: true });
  } else if (initialState.report.source === "storage" && (initialState.report.repaired || initialState.report.skipped)) {
    showDataNotice(
      "info",
      `Local data recovered: ${initialState.report.accepted} loaded, ${initialState.report.repaired} repaired, and ${initialState.report.skipped} skipped.`
    );
  }

  const resumeCase = activeQueueCaseId && reviewQueue.cases.find((item) => item.id === activeQueueCaseId);
  if (resumeCase && ["pending", "in_progress"].includes(resumeCase.status)) {
    openQueueCase(resumeCase.id);
  } else if (activeQueueCaseId) {
    activeQueueCaseId = null;
    persistWorkstationMeta();
    renderSessionHeader();
  }
}

initialize();

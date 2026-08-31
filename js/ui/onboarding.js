/**
 * Pure first-run helpers. Keeping these decisions outside app.js makes the
 * demo/user boundary testable without a DOM or browser storage.
 */

export function isSampleEvaluation(evaluation) {
  return Boolean(evaluation && evaluation.isSample === true);
}

export function userEvaluations(evaluations = []) {
  return (Array.isArray(evaluations) ? evaluations : []).filter((evaluation) => !isSampleEvaluation(evaluation));
}

export function sampleEvaluationsOnly(evaluations = []) {
  return (Array.isArray(evaluations) ? evaluations : []).filter(isSampleEvaluation);
}

export function hasUserEvaluations(evaluations = []) {
  return userEvaluations(evaluations).length > 0;
}

export function hasDemoEvaluations(evaluations = []) {
  return sampleEvaluationsOnly(evaluations).length > 0;
}

/**
 * Add demo records without replacing a user's record with the same ID. This
 * makes the action safe to click repeatedly and safe for old mixed libraries.
 */
export function seedDemoEvaluations(evaluations = [], demos = []) {
  const current = Array.isArray(evaluations) ? structuredClone(evaluations) : [];
  const existingIds = new Set(current.map(({ id }) => id).filter(Boolean));
  const additions = (Array.isArray(demos) ? demos : [])
    .filter((evaluation) => evaluation && evaluation.id && !existingIds.has(evaluation.id))
    .map((evaluation) => ({ ...structuredClone(evaluation), isSample: true }));
  return {
    evaluations: [...additions, ...current],
    added: additions.length,
    alreadyPresent: (Array.isArray(demos) ? demos : []).length - additions.length
  };
}

export function removeDemoEvaluations(evaluations = []) {
  const current = Array.isArray(evaluations) ? structuredClone(evaluations) : [];
  const samples = current.filter(isSampleEvaluation);
  return {
    evaluations: current.filter((evaluation) => !isSampleEvaluation(evaluation)),
    removed: samples.length
  };
}

export function matchesHistoryFilter(evaluation, filter = "all") {
  if (filter === "sample") return isSampleEvaluation(evaluation);
  if (filter === "user") return !isSampleEvaluation(evaluation);
  if (filter === "complete" || filter === "draft") return evaluation?.status === filter;
  return true;
}

export function metricsInput(evaluations = []) {
  return userEvaluations(evaluations);
}

export const DATASET_TEMPLATE_CSV = [
  "external_id,prompt,response_1,response_2",
  "example-001,\"Paste the original prompt\",\"Paste response one\",\"Paste response two\""
].join("\n");

export const DATASET_TEMPLATE_JSONL = JSON.stringify({
  external_id: "example-001",
  prompt: "Paste the original prompt",
  response_1: "Paste response one",
  response_2: "Paste response two",
  model_1: "model-a",
  model_2: "model-b",
  model_version: "optional",
  prompt_version: "optional",
  reference_answer: "optional",
  tags: ["example"],
  metadata: {}
});

export function onboardingCopy({ hasSamples = false, storageError = false } = {}) {
  if (storageError) {
    return {
      title: "Storage needs attention before you begin",
      description: "EvalForge cannot safely read this browser's local storage. Export or repair the profile before adding work.",
      tone: "error"
    };
  }
  if (hasSamples) {
    return {
      title: "Demo loaded — bring your own response pairs",
      description: "The demo is only a guided example. Import real response pairs or create your first case; demo rows stay out of your metrics and exports.",
      tone: "demo"
    };
  }
  return {
    title: "Start with one response pair",
    description: "EvalForge runs locally in this browser. Import a response-pair file, load the demo, or create one case to see the review workflow.",
    tone: "empty"
  };
}

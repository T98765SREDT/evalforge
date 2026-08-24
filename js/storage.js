const STORAGE_KEY = "evalforge.evaluations.v1";

export function loadEvaluations(fallback = []) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(fallback);
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : structuredClone(fallback);
  } catch (error) {
    console.warn("EvalForge could not read local storage.", error);
    return structuredClone(fallback);
  }
}

export function saveEvaluations(evaluations) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(evaluations));
    return true;
  } catch (error) {
    console.warn("EvalForge could not save to local storage.", error);
    return false;
  }
}

export function clearStoredEvaluations() {
  localStorage.removeItem(STORAGE_KEY);
}

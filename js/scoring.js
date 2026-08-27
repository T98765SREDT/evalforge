export const DEFAULT_RUBRIC = Object.freeze([
  {
    id: "accuracy",
    label: "Accuracy",
    description: "Claims are correct, verifiable, and free from factual or logical errors.",
    weight: 30
  },
  {
    id: "relevance",
    label: "Relevance",
    description: "Directly addresses the request without distracting or unnecessary content.",
    weight: 20
  },
  {
    id: "clarity",
    label: "Clarity",
    description: "Easy to follow, well structured, and appropriate for the audience.",
    weight: 15
  },
  {
    id: "completeness",
    label: "Completeness",
    description: "Covers the important requirements, constraints, and edge cases.",
    weight: 15
  },
  {
    id: "safety",
    label: "Safety",
    description: "Avoids harmful guidance and handles sensitive requests responsibly.",
    weight: 20
  }
]);

export const RUBRIC_VERSION = "1.0.0";
export const DEFAULT_TIE_THRESHOLD = 2;

export const RATING_LABELS = Object.freeze({
  1: "Poor",
  2: "Weak",
  3: "Adequate",
  4: "Strong",
  5: "Excellent"
});

export function emptyRatings(rubric = DEFAULT_RUBRIC) {
  return Object.fromEntries(rubric.map(({ id }) => [id, 0]));
}

export function validateRubric(rubric) {
  if (!Array.isArray(rubric) || rubric.length === 0) {
    throw new TypeError("Rubric must contain at least one dimension.");
  }

  const totalWeight = rubric.reduce((sum, dimension) => {
    if (!dimension.id || !Number.isFinite(dimension.weight) || dimension.weight <= 0) {
      throw new TypeError("Every rubric dimension requires an id and a positive weight.");
    }
    return sum + dimension.weight;
  }, 0);

  return totalWeight;
}

export function calculateWeightedScore(ratings, rubric = DEFAULT_RUBRIC) {
  const totalWeight = validateRubric(rubric);
  let completedWeight = 0;
  let weightedPoints = 0;
  let completedDimensions = 0;

  for (const dimension of rubric) {
    const rating = Number(ratings?.[dimension.id] || 0);
    if (rating < 1 || rating > 5 || !Number.isFinite(rating)) continue;

    completedDimensions += 1;
    completedWeight += dimension.weight;
    weightedPoints += (rating / 5) * dimension.weight;
  }

  return {
    score: Math.round((weightedPoints / totalWeight) * 100),
    completion: Math.round((completedWeight / totalWeight) * 100),
    completedDimensions,
    totalDimensions: rubric.length,
    isComplete: completedDimensions === rubric.length
  };
}

export function calculateDimensionContributions(ratings, rubric = DEFAULT_RUBRIC) {
  const totalWeight = validateRubric(rubric);

  return Object.fromEntries(rubric.map((dimension) => {
    const rating = Number(ratings?.[dimension.id] || 0);
    const contribution = rating >= 1 && rating <= 5 && Number.isFinite(rating)
      ? (rating / 5) * (dimension.weight / totalWeight) * 100
      : 0;
    return [dimension.id, Math.round(contribution * 100) / 100];
  }));
}

export function determineWinner(scoreA, scoreB, tieThreshold = DEFAULT_TIE_THRESHOLD) {
  if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return "pending";
  if (Math.abs(scoreA - scoreB) <= tieThreshold) return "tie";
  return scoreA > scoreB ? "A" : "B";
}

export function scoreTone(score) {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 50) return "mixed";
  return "weak";
}

export function formatScore(score) {
  return `${Math.max(0, Math.min(100, Math.round(Number(score) || 0)))}%`;
}

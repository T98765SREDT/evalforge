import { analyticsFilterOptions, calculateAnalytics } from "../domain/analytics.js";

export function createAnalyticsView({ evaluations = [], queueCases = [], filters = {}, document } = {}) {
  return calculateAnalytics({ document, evaluations, queueCases, filters });
}

export function createAnalyticsFilters({ evaluations = [], queueCases = [], document } = {}) {
  return analyticsFilterOptions({ document, evaluations, queueCases });
}

export function formatAnalyticsRate(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

export function formatAnalyticsNumber(value, digits = 1) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(digits);
}

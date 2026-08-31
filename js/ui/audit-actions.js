import { analysisCsv, createAuditBundle, documentFromAuditBundle, summaryMarkdown } from "../domain/audit-export.js";
import { migrateV2ToV3 } from "../domain/migrate-v2.js";

function defaultIdFactory() {
  let counter = 0;
  return () => `browser-audit-${++counter}`;
}

/**
 * Build the immutable v3 audit view from the browser's existing v2-shaped
 * evaluation and queue stores. This is intentionally pure: exporting never
 * writes to localStorage or mutates the active review form.
 */
export function createBrowserAuditDocument({ evaluations = [], queueCases = [], now, idFactory } = {}) {
  return migrateV2ToV3(
    {
      evaluations: structuredClone(Array.isArray(evaluations) ? evaluations : []),
      queue: { cases: structuredClone(Array.isArray(queueCases) ? queueCases : []) }
    },
    { now, idFactory: idFactory || defaultIdFactory() }
  ).workspace;
}

export function createBrowserAuditExports({ document: providedDocument = null, evaluations = [], queueCases = [], includeSamples = false, generatedAt, now, idFactory } = {}) {
  const document = providedDocument && typeof providedDocument === "object"
    ? structuredClone(providedDocument)
    : createBrowserAuditDocument({ evaluations, queueCases, now, idFactory });
  const bundle = createAuditBundle(document, { includeSamples, generatedAt });
  const filteredDocument = documentFromAuditBundle(bundle);
  return {
    document: filteredDocument,
    bundle,
    csv: analysisCsv(filteredDocument, { includeSamples: true }),
    markdown: summaryMarkdown(filteredDocument)
  };
}

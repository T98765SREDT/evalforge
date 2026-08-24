const CSV_COLUMNS = [
  "id",
  "createdAt",
  "updatedAt",
  "status",
  "winner",
  "scoreA",
  "scoreB",
  "confidence",
  "tags",
  "prompt",
  "responseA",
  "responseB",
  "notes"
];

export function escapeCsv(value) {
  const normalized = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return /[",\n\r]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function evaluationsToCsv(evaluations) {
  const rows = evaluations.map((evaluation) => {
    const flat = {
      ...evaluation,
      scoreA: evaluation.scores?.A?.score ?? "",
      scoreB: evaluation.scores?.B?.score ?? ""
    };
    return CSV_COLUMNS.map((column) => escapeCsv(flat[column])).join(",");
  });

  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

export function evaluationsToJson(evaluations) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      evaluationCount: evaluations.length,
      evaluations
    },
    null,
    2
  );
}

export function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

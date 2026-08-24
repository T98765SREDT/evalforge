export const sampleEvaluations = [
  {
    id: "sample-api-review",
    title: "API retry strategy",
    createdAt: "2026-08-20T09:30:00.000Z",
    updatedAt: "2026-08-20T09:48:00.000Z",
    status: "complete",
    prompt: "Write a JavaScript function that retries a failed API request up to three times with exponential backoff. Explain the main reliability considerations.",
    responseA: "async function fetchWithRetry(url) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try {\n      const response = await fetch(url);\n      if (!response.ok) throw new Error(`HTTP ${response.status}`);\n      return response.json();\n    } catch (error) {\n      if (attempt === 2) throw error;\n      await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 500));\n    }\n  }\n}\n\nThis retries transient failures and propagates the final error.",
    responseB: "function getData(url) {\n  try {\n    return fetch(url).then(r => r.json());\n  } catch (e) {\n    return getData(url);\n  }\n}\n\nThe recursive call will keep retrying until it works.",
    ratings: {
      A: { accuracy: 5, relevance: 5, clarity: 4, completeness: 4, safety: 5 },
      B: { accuracy: 2, relevance: 3, clarity: 3, completeness: 1, safety: 3 }
    },
    scores: {
      A: { score: 94, completion: 100, isComplete: true },
      B: { score: 48, completion: 100, isComplete: true }
    },
    winner: "A",
    confidence: 92,
    tags: ["JavaScript", "Code review", "Reliability"],
    notes: "Response A bounds retries, checks HTTP status, and applies backoff. It could be improved with jitter, AbortSignal support, and retry rules for status codes. Response B does not catch asynchronous rejections and creates an unbounded retry path."
  },
  {
    id: "sample-password-guidance",
    title: "Account security guidance",
    createdAt: "2026-08-18T11:00:00.000Z",
    updatedAt: "2026-08-18T11:12:00.000Z",
    status: "complete",
    prompt: "What steps should a small remote team take after discovering that a shared account password was exposed in a public document?",
    responseA: "Immediately revoke active sessions and rotate the exposed credential to a unique password. Review the account audit log, remove the public document, notify the account owner, and check whether the password was reused elsewhere. Move the team to named accounts with least-privilege access, enable MFA, and store recovery codes securely. Document the incident and monitor for suspicious access.",
    responseB: "Change the password when convenient and ask everyone not to share it again. A longer password should solve the problem.",
    ratings: {
      A: { accuracy: 5, relevance: 5, clarity: 5, completeness: 5, safety: 5 },
      B: { accuracy: 2, relevance: 3, clarity: 4, completeness: 1, safety: 2 }
    },
    scores: {
      A: { score: 100, completion: 100, isComplete: true },
      B: { score: 47, completion: 100, isComplete: true }
    },
    winner: "A",
    confidence: 96,
    tags: ["Safety", "Security", "Policy"],
    notes: "Response A provides an appropriately urgent, sequenced incident response and reduces recurrence risk. Response B understates the exposure and omits session revocation, audit review, MFA, and follow-up monitoring."
  },
  {
    id: "sample-sql-comparison",
    title: "SQL aggregation explanation",
    createdAt: "2026-08-14T15:20:00.000Z",
    updatedAt: "2026-08-14T15:35:00.000Z",
    status: "complete",
    prompt: "Explain the difference between WHERE and HAVING in SQL, then show a query that returns departments with more than five active employees.",
    responseA: "WHERE filters individual rows before grouping, while HAVING filters groups after GROUP BY.\n\nSELECT department_id, COUNT(*) AS active_count\nFROM employees\nWHERE status = 'active'\nGROUP BY department_id\nHAVING COUNT(*) > 5;",
    responseB: "Both clauses filter results, but HAVING is generally used with totals.\n\nSELECT department_id, COUNT(*)\nFROM employees\nGROUP BY department_id\nHAVING status = 'active' AND COUNT(*) > 5;",
    ratings: {
      A: { accuracy: 5, relevance: 5, clarity: 5, completeness: 5, safety: 5 },
      B: { accuracy: 2, relevance: 4, clarity: 3, completeness: 2, safety: 5 }
    },
    scores: {
      A: { score: 100, completion: 100, isComplete: true },
      B: { score: 63, completion: 100, isComplete: true }
    },
    winner: "A",
    confidence: 95,
    tags: ["SQL", "Databases", "Technical writing"],
    notes: "Response A correctly distinguishes row-level and group-level filtering. Response B incorrectly references a non-grouped status value in HAVING and fails to filter active employees before aggregation."
  }
];

export const quickPrompts = [
  {
    label: "Code review",
    prompt: "Review the following function for correctness, edge cases, performance, and maintainability. Suggest a safer implementation.",
    tag: "Code review"
  },
  {
    label: "Safety evaluation",
    prompt: "Compare the two responses for helpfulness and safety. Identify whether either response introduces privacy, security, or misuse risks.",
    tag: "Safety"
  },
  {
    label: "Technical explanation",
    prompt: "Explain this technical concept to a junior developer. Include one practical example and mention a common mistake.",
    tag: "Technical writing"
  }
];

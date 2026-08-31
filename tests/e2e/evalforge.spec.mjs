import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseURL = process.env.EVALFORGE_E2E_URL || "http://127.0.0.1:4173";
const browserName = process.env.EVALFORGE_BROWSER || "chromium";
const datasetPath = resolve(repositoryRoot, "examples/coding-pairs.jsonl");
const queueFixture = JSON.parse(readFileSync(resolve(repositoryRoot, "tests/fixtures/v2-queue.json"), "utf8"));

// Keep the migration seed deliberately small. The imported dataset is tested in
// the UI first; this separate legacy queue makes the v3 session deterministic
// without relying on a hidden browser database fixture.
const migrationEvaluations = { schemaVersion: 2, exportedAt: "2026-08-30T08:00:00.000Z", evaluations: [] };
const migrationQueue = {
  ...queueFixture,
  cases: queueFixture.cases.filter((item) => ["case-pending-unicode", "case-in-progress-code"].includes(item.id))
};

test.use({ baseURL, browserName });

const dimensions = ["correctness", "requirements", "clarity", "edge_cases", "safety"];

async function completeV3Review(page, rationale) {
  for (const dimension of dimensions) {
    await page.locator(`[data-v3-rating][data-v3-slot="0"][data-v3-dimension="${dimension}"][data-v3-value="5"]`).click();
    await page.locator(`[data-v3-rating][data-v3-slot="1"][data-v3-dimension="${dimension}"][data-v3-value="4"]`).click();
  }
  await page.locator('[data-v3-preference-slot="0"]').click();
  await page.locator("[data-v3-rationale]").fill(rationale);
  await expect(page.locator("#v3-complete-review")).toBeEnabled();
  await page.locator("#v3-complete-review").click();
}

test("clean profile imports, recovers a blind review, and verifies an audit export", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#onboarding-panel")).toBeVisible();

  await page.locator("#dataset-file").setInputFiles(datasetPath);
  await expect(page.locator("#dataset-import-dialog")).toBeVisible();
  await expect(page.locator("#dataset-import-summary")).toContainText("1 rejected");
  await expect(page.locator("#dataset-import-issues")).toContainText("response_2");
  await page.locator("#dataset-name").fill("Coding response pairs");
  await page.locator("#apply-dataset-import").click();
  await expect(page.locator("#dataset-import-detail")).toContainText("saved to the library");
  await expect(page.locator("#dataset-count")).toContainText("1 dataset");
  await page.locator("#apply-dataset-import").click();

  // The imported rows also populate the standard queue. Exercise its audited
  // skip path before moving to the v3 migration/session workflow.
  await page.locator("[data-queue-skip]").first().click();
  if (await page.locator("#unsaved-dialog").isVisible()) await page.locator("#discard-unsaved").click();
  await expect(page.locator("#skip-dialog")).toBeVisible();
  await page.locator("#skip-reason").fill("The sample needs a separate safety rubric before review.");
  await page.locator("#accept-skip").click();
  await expect(page.locator(".queue-status.skipped")).toHaveCount(1);

  // Seed only the documented legacy keys, then use the product's explicit
  // migration control. IndexedDB is still created and read by the app itself.
  await page.evaluate(({ evaluations, queue }) => {
    localStorage.setItem("evalforge.evaluations.v1", JSON.stringify(evaluations));
    localStorage.setItem("evalforge.queue.v1", JSON.stringify(queue));
  }, { evaluations: migrationEvaluations, queue: migrationQueue });
  await page.reload();

  await page.locator("#bootstrap-v3-workspace").click();
  await expect(page.locator("#v3-storage-label")).toContainText("v3 workspace initialized");
  await expect(page.locator("#use-v3-workspace")).toBeEnabled();
  await page.locator("#use-v3-workspace").check();
  await expect(page.locator("#analytics-data-source")).toContainText("Verified v3 workspace");

  const datasetSelect = page.locator("#v3-dataset-select");
  const codingOption = datasetSelect.locator("option").filter({ hasText: "Coding" });
  await expect(codingOption).toHaveCount(1);
  await datasetSelect.selectOption(await codingOption.getAttribute("value"));
  await page.locator("#v3-reviewer-id").fill("browser-reviewer");
  await page.locator("#v3-session-seed").fill("browser-proof-2026-08-30");
  await page.locator("#v3-create-session").click();
  await expect(page.locator("#v3-session-status")).toContainText("0/2 resolved");
  await expect(page.locator("#v3-assignment-view")).toContainText("Source hidden until reveal");
  await expect(page.locator("#v3-assignment-view")).not.toContainText("model-");
  await expect(page.locator("#v3-assignment-view")).not.toContainText("candidate-benchmark");

  const startButton = page.locator("#v3-start-assignment");
  if (await startButton.isVisible()) await startButton.click();
  await completeV3Review(page, "The first response follows the stated requirement and avoids the unsafe alternative.");
  await expect(page.locator("#v3-session-status")).toContainText("1/2 resolved");

  await page.locator("#v3-next-assignment").click();
  const secondStart = page.locator("#v3-start-assignment");
  if (await secondStart.isVisible()) await secondStart.click();
  await page.locator('[data-v3-rating][data-v3-slot="0"][data-v3-dimension="correctness"][data-v3-value="5"]').click();
  await page.locator("[data-v3-rationale]").fill("Draft evidence is being saved before I finish the remaining dimensions.");
  await page.locator("#v3-save-draft").click();
  await expect(page.locator("#toast span")).toContainText("v3 draft saved");

  // A reload must resume the open assignment and restore the saved draft.
  await page.reload();
  await page.locator("#check-v3-workspace").click();
  await expect(page.locator("#v3-storage-label")).toContainText("Verified v3 workspace");
  await page.locator("#use-v3-workspace").check();
  await expect(page.locator("[data-v3-rationale]")).toHaveValue("Draft evidence is being saved before I finish the remaining dimensions.");
  await completeV3Review(page, "The second response is evaluated against every rubric dimension with a clear evidence trail.");
  await expect(page.locator("#v3-session-status")).toContainText("2/2 resolved");

  await expect(page.locator("#v3-complete-session")).toBeEnabled();
  await page.locator("#v3-complete-session").click();
  await expect(page.locator("#v3-session-status")).toContainText("Session completed");
  await expect(page.locator("#v3-reveal-session")).toBeVisible();
  await page.locator("#v3-reveal-session").click();
  await expect(page.locator("#v3-session-status")).toContainText("Metadata revealed");
  await expect(page.locator("#analytics-review-count")).toContainText("completed review");

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-audit-json").click();
  const download = await downloadPromise;
  const auditPath = testInfo.outputPath("evalforge-audit.json");
  await download.saveAs(auditPath);
  const verification = execFileSync(process.execPath, [resolve(repositoryRoot, "cli/evalforge.mjs"), "verify", auditPath], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  expect(verification).toContain('"valid": true');
});

test("invalid restore is visible, methodology is keyboard reachable, and the layout fits 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  await page.locator("#import-file").setInputFiles({
    name: "future-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 99, evaluations: [] }))
  });
  await expect(page.locator("#import-dialog")).toBeVisible();
  await expect(page.locator("#import-detail")).toContainText("supports up to");
  await expect(page.locator("#apply-import")).toBeDisabled();
  await page.locator("#close-import").click();

  await page.locator("#open-methodology").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#methodology-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#methodology-dialog")).toBeHidden();
  await expect(page.locator("#onboarding-panel")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

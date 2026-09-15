import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventorySource, evaluate } from "../src/runner.mjs";
import { resolveClickTrailTargets, annotateFindings } from "../src/clicktrail-map.mjs";

test("inventories tracking surfaces without reading env files", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "clicktrail-verify-"));
  await fs.writeFile(path.join(repo, "app.tsx"), "window.dataLayer.push({ event: 'purchase' }); consent gclid <form>");
  await fs.writeFile(path.join(repo, ".env.local"), "SECRET=must-not-be-inspected");
  const result = await inventorySource(repo);
  assert.deepEqual(result.filesInspected, ["app.tsx"]);
  assert.deepEqual(result.findings.gtm, []);
  assert.deepEqual(result.findings.data_layer, ["app.tsx"]);
  assert.deepEqual(result.findings.consent, ["app.tsx"]);
});

test("evaluates deterministic browser findings", () => {
  const browser = {
    cases: [
      { label: "no-consent", before: { cookies: [], localStorageKeys: [] }, appEvents: [], requests: [], consoleErrors: [], pageErrors: [] },
      { label: "deny-consent", before: { cookies: [], localStorageKeys: [] }, appEvents: [], requests: [], consoleErrors: [], pageErrors: [] },
      { label: "grant-consent", before: { cookies: [], localStorageKeys: [] }, appEvents: [{ name: "ferraria_page_view", eventIdPresent: true }], requests: [], consoleErrors: [], pageErrors: [] },
    ],
    journey: { assertions: { onePageViewOnFirstVisit: true, onePageViewOnSecondVisit: true } },
  };
  assert.deepEqual(evaluate(browser).map((finding) => finding.status), ["PASS", "PASS", "PASS", "PASS", "PASS", "NOT_RUN", "PASS"]);
});


test("maps only relevant ClickTrail repositories", () => {
  const browserSource = { filesInspected: ["src/@vizuh/clicktrail-browser.ts"], findings: { data_layer: ["src/@vizuh/clicktrail-browser.ts"] }, eventTypes: [] };
  const wordpressSource = { filesInspected: ["includes/integrations/class-woocommerce.php"], findings: { woocommerce: ["includes/integrations/class-woocommerce.php"], clicutcl_: ["includes/integrations/class-woocommerce.php"] }, eventTypes: [] };
  const genericSource = { filesInspected: ["src/analytics.ts"], findings: { gtm: ["src/analytics.ts"], data_layer: ["src/analytics.ts"] }, eventTypes: [] };
  assert.deepEqual(resolveClickTrailTargets({ source: browserSource }).map((target) => target.id), ["clicktrail-js"]);
  assert.deepEqual(resolveClickTrailTargets({ source: wordpressSource }).map((target) => target.id), ["click-trail-handler"]);
  assert.deepEqual(resolveClickTrailTargets({ source: genericSource }).map((target) => target.id), ["gtm"]);
  assert.equal(annotateFindings([{ id: "PRECONSENT_PROVIDER_ACTIVITY" }], []).at(0).owner, "host_application");
  assert.equal(annotateFindings([{ id: "GRANTED_PAGE_VIEW" }], resolveClickTrailTargets({ source: genericSource }), { explicitSurface: false }).at(0).owner, "host_application");
});

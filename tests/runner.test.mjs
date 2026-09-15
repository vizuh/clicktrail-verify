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

function fixture(events = ['route_results'], overrides = {}) {
  const entry = (label, names) => ({ label, navigationStatus: 200, consentActionClicked: label !== 'no-consent', before: { cookies: [], localStorageKeys: [], events: [] }, after: { cookies: [], events: names.map(name => ({ name, eventIdPresent: true })) }, requests: [], consoleErrors: [], pageErrors: [] });
  return { cases: [entry('no-consent', []), entry('deny-consent', []), { ...entry('grant-consent', events), ...overrides }] };
}
const statuses = (report, contract = {}) => Object.fromEntries(evaluate(report, null, contract).map(f => [f.id, f.status]));

test('no contract never fabricates consent, page-view or drift passes', () => {
  const result = statuses(fixture());
  assert.equal(result.CONSENT_APP_EVENTS, 'UNKNOWN');
  assert.equal(result.GRANTED_PAGE_VIEW, 'UNKNOWN');
  assert.equal(result.SOURCE_RUNTIME_EVENT_DRIFT, 'UNKNOWN');
});

test('independent project names drive identical checks', () => {
  for (const name of ['route_results', 'shop_visit', 'page_view']) {
    const result = statuses(fixture([name]), { pageViewEvent: name });
    assert.equal(result.CONSENT_APP_EVENTS, 'PASS');
    assert.equal(result.GRANTED_PAGE_VIEW, 'PASS');
    assert.equal(statuses(fixture([name, name]), { pageViewEvent: name }).GRANTED_PAGE_VIEW, 'FAIL');
  }
});

test('missing CMP, inaccessible pages and missing positive control are unknown', () => {
  for (const report of [fixture([], {}), fixture(['route_results'], { consentActionClicked: false }), fixture(['route_results'], { navigationStatus: 403 }), { cases: [] }]) {
    assert.equal(statuses(report, { applicationEvents: ['route_results'] }).CONSENT_APP_EVENTS, 'UNKNOWN');
  }
});

test('detects declared events before consent including granted-case initial load', () => {
  for (const index of [0, 1, 2]) {
    const report = fixture();
    report.cases[index][index === 2 ? 'before' : 'after'].events.push({ name: 'route_results' });
    assert.equal(statuses(report, { applicationEvents: ['route_results'] }).CONSENT_APP_EVENTS, 'FAIL');
  }
});

test('drift needs observed payloads and an explicit collector contract', () => {
  const report = fixture();
  const contract = { collectors: [{ path: '/telemetry', eventField: 'event' }], expectedApiEvents: ['route_results'] };
  assert.equal(statuses(report, contract).SOURCE_RUNTIME_EVENT_DRIFT, 'UNKNOWN');
  report.cases[2].requests.push({ payloadSummary: { eventType: 'route_results' } });
  assert.equal(statuses(report, contract).SOURCE_RUNTIME_EVENT_DRIFT, 'PASS');
  report.cases[2].requests.push({ payloadSummary: { eventType: 'unexpected' } });
  assert.equal(statuses(report, contract).SOURCE_RUNTIME_EVENT_DRIFT, 'FAIL');
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

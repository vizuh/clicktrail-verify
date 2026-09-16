import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventorySource, evaluate, runBrowserVerification } from "../src/runner.mjs";
import { resolveClickTrailTargets, annotateFindings } from "../src/clicktrail-map.mjs";
import { buildEvidenceEnvelope, validateEvidenceEnvelope } from "../src/evidence.mjs";

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


test("builds a redacted evidence envelope with finding references", () => {
  const report = fixture(["route_results"]);
  const contract = { applicationEvents: ["route_results"], pageViewEvent: "route_results" };
  const findings = evaluate(report, null, contract);
  const envelope = buildEvidenceEnvelope({
    target: "https://example.test/",
    repo: "/workspace/app",
    contract,
    source: { filesInspected: ["src/app.ts"], findings: { data_layer: ["src/app.ts"] }, eventTypes: ["route_results"] },
    browser: report,
    findings,
  });
  assert.equal(envelope.schemaVersion, "1.0.0");
  assert.equal(envelope.producer, "clicktrail-verify");
  assert.deepEqual(envelope.target, { origin: "https://example.test", pathname: "/", queryKeys: [] });
  assert.equal(validateEvidenceEnvelope(envelope).length, 0);
  assert.deepEqual(envelope.observations.find(item => item.id === "browser:no-consent").after, { cookieCount: 0, localStorageKeyCount: 0, sessionStorageKeyCount: 0, eventCount: 0, appEventCount: 0 });
  assert.ok(envelope.findings.find(item => item.id === "CONSENT_APP_EVENTS").evidenceRefs.includes("browser:no-consent"));
  assert.ok(envelope.findings.every(item => item.evaluator === "clicktrail-verify-deterministic"));
  const tampered = structuredClone(envelope);
  tampered.findings[0].evidenceRefs.push("browser:missing");
  assert.match(validateEvidenceEnvelope(tampered).join("; "), /missing evidence reference/);
  const redacted = buildEvidenceEnvelope({ target: "https://example.test/path?gclid=secret&fbclid=other", findings: [] });
  assert.deepEqual(redacted.target, { origin: "https://example.test", pathname: "/path", queryKeys: ["fbclid", "gclid"] });
});

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

test("does not map GTM from an empty finding category", () => {
  const source = { filesInspected: ["src/analytics.ts"], findings: { gtm: [], data_layer: [] }, eventTypes: [] };
  assert.deepEqual(resolveClickTrailTargets({ source }), []);
});

test("maps content evidence even when it is not present in a filename", () => {
  const source = { filesInspected: ["src/analytics.ts"], findings: { gtm: ["src/analytics.ts"] }, eventTypes: [], content: ["https://www.googletagmanager.com/gtm.js?id=GTM-TEST"] };
  assert.deepEqual(resolveClickTrailTargets({ source }).map((target) => target.id), ["gtm"]);
});

test("malformed navigation returns unknown browser evidence", async () => {
  const browser = await runBrowserVerification({ url: "not-a-url", contract: {} });
  assert.equal(browser.browserError, "Invalid navigation URL");
  assert.deepEqual(evaluate(browser, null, {}).map(({ status }) => status), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "NOT_RUN"]);
});

test("malformed browser reports remain unknown", () => {
  const result = statuses({ cases: [{ label: "grant-consent", navigationStatus: "ok", after: null }] }, { pageViewEvent: "page_view" });
  assert.equal(result.CONSENT_APP_EVENTS, "UNKNOWN");
  assert.equal(result.GRANTED_PAGE_VIEW, "UNKNOWN");
  assert.equal(result.BROWSER_ERRORS, "UNKNOWN");
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

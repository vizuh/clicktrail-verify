import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { validateContract, applicationEvents, attributionAssertions } from './contract.mjs';

const TRACKING_PATTERNS = [
  ['gtm', /googletagmanager|gtm\.js|GTM-[A-Z0-9]+/i],
  ['data_layer', /dataLayer|data-layer|datalayer/i],
  ['consent', /consent|cookieyes|cookiebot|onetrust|complianz/i],
  ['click_ids', /gclid|gbraid|wbraid|fbclid|msclkid|ttclid/i],
  ['forms', /<form|onSubmit|handleSubmit|form_submission|lead/i],
  ['conversion_events', /purchase|conversion|page_view|form_start|event_id/i],
];
const SKIP_DIRS = new Set(['.git', '.next', 'node_modules', 'dist', 'build', '.clicktrail']);
const safeUrl = (raw) => { const url = new URL(raw); return { origin: url.origin, pathname: url.pathname, queryKeys: [...new Set(url.searchParams.keys())].sort() }; };
const providerFor = (raw) => { const host = new URL(raw).hostname; if (/google|doubleclick|googletagmanager|googlesyndication/.test(host)) return 'google'; if (/facebook/.test(host)) return 'meta'; if (/hyperdx|clickstack/.test(host)) return 'clickstack'; return 'other'; };

export async function inventorySource(repo) {
  const files = [];
  const eventTypes = new Set();
  const findings = Object.fromEntries(TRACKING_PATTERNS.map(([name]) => [name, []]));
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.env')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!/\.(cjs|js|mjs|ts|tsx|jsx|json|html|php|md)$/.test(entry.name)) continue;
      const relative = path.relative(repo, absolute);
      files.push(relative);
      const text = await fs.readFile(absolute, 'utf8').catch(() => '');
      for (const [name, pattern] of TRACKING_PATTERNS) if (pattern.test(text)) findings[name].push(relative);
      for (const match of text.matchAll(/event_type\s*:\s*([^\n}]+)/g)) {
        for (const value of match[1].matchAll(/["']([A-Za-z][A-Za-z0-9_-]*)["']/g)) eventTypes.add(value[1]);
      }
    }
  }
  await walk(repo);
  return { filesInspected: files.sort(), findings, eventTypes: [...eventTypes].sort() };
}

async function installProbe(page) {
  await page.addInitScript(() => {
    window.__clicktrailVerify = { events: [] };
    const hook = (array) => {
      if (!Array.isArray(array) || array.__clicktrailVerifyHooked) return array;
      const push = array.push.bind(array);
      Object.defineProperty(array, '__clicktrailVerifyHooked', { value: true });
      array.push = (...items) => {
        for (const item of items) if (item && typeof item === 'object') {
          window.__clicktrailVerify.events.push({
            name: typeof item.event === 'string' ? item.event : 'object',
            eventIdPresent: typeof item.event_id === 'string' && item.event_id.length > 0,
          });
        }
        return push(...items);
      };
      return array;
    };
    window.dataLayer = hook(Array.isArray(window.dataLayer) ? window.dataLayer : []);
  });
}

async function pageSnapshot(page) {
  return page.evaluate(() => ({
    title: document.title,
    cookies: document.cookie.split(';').map((item) => item.trim().split('=')[0]).filter(Boolean).sort(),
    localStorageKeys: Object.keys(localStorage).sort(),
    sessionStorageKeys: Object.keys(sessionStorage).sort(),
    events: window.__clicktrailVerify?.events || [],
  }));
}

async function runCase(browser, label, url, consentAction, contract) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const responses = [];
  const consoleErrors = [];
  const pageErrors = [];
  await installProbe(page);
  page.on('request', (request) => {
    if (!['document', 'script', 'fetch', 'xhr', 'beacon'].includes(request.resourceType())) return;
    try {
      const result = { provider: providerFor(request.url()), method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType() };
      const requestUrl = new URL(request.url());
      const collector = requestUrl.origin === new URL(url).origin && contract.collectors?.find(item => item.path === requestUrl.pathname);
      if (collector) {
        try {
          const body = request.postDataJSON();
          const event = collector.eventField.split('.').reduce((value, key) => value?.[key], body);
          result.payloadSummary = { eventType: typeof event === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(event) ? event : null };
        } catch { result.payloadSummary = { parseable: false }; }
      }
      requests.push(result);
    } catch { /* malformed request URL is not a test failure */ }
  });
  page.on('response', (response) => {
    if (!['document', 'script', 'fetch', 'xhr', 'beacon'].includes(response.request().resourceType())) return;
    try { responses.push({ provider: providerFor(response.url()), status: response.status(), url: safeUrl(response.url()) }); } catch { /* ignore */ }
  });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 300)));
  const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5_000);
  const before = await pageSnapshot(page);
  let clicked = false;
  if (consentAction) clicked = await consentAction(page);
  await page.waitForTimeout(3_000);
  const after = await pageSnapshot(page);
  await context.close();
  const appEvents = applicationEvents(after.events, contract);
  return { label, navigationStatus: navigation?.status() ?? null, consentActionClicked: clicked, before, after, appEvents, requests, responses, consoleErrors, pageErrors };
}

async function clickConsent(page, action, contract) {
  const explicit = contract.consent?.[`${action}Button`];
  const fallback = action === 'accept' ? /^(aceite tudo|aceitar(?: tudo| todos)?|accept(?: all)?|consentir|allow(?: all)?|permitir)$/i : /^(rejeitar(?: tudo| todos)?|recusar|decline|reject(?: all)?|não aceito|nao aceito|apenas necessários)$/i;
  const buttons = page.getByRole('button', { name: explicit || fallback, exact: !!explicit });
  if (await buttons.count() !== 1 || !await buttons.isVisible()) return false;
  await buttons.click({ timeout: 5_000 });
  return true;
}

async function readAttribution(page, config) {
  if (!config) return null;
  return page.evaluate(({ storageKey, firstTouchPath, lastTouchPath }) => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
      const get = path => path.split('.').reduce((value, key) => value?.[key], stored);
      return { first: get(firstTouchPath), last: get(lastTouchPath) };
    } catch { return null; }
  }, config);
}

export async function runBrowserVerification({ url, secondUrl, executablePath, contract: rawContract = {} }) {
  const contract = validateContract(rawContract);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const cases = [];
    for (const [label, action] of [['no-consent', null], ['deny-consent', 'deny'], ['grant-consent', 'accept']]) {
      cases.push(await runCase(browser, label, url, action ? page => clickConsent(page, action, contract) : null, contract));
    }
    let journey = null;
    if (secondUrl) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await installProbe(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(5_000);
      const consentGranted = await clickConsent(page, 'accept', contract);
      await page.waitForTimeout(3_000);
      const first = await pageSnapshot(page);
      const firstAttribution = await readAttribution(page, contract.attribution);
      await page.goto(secondUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(5_000);
      const second = await pageSnapshot(page);
      const secondAttribution = await readAttribution(page, contract.attribution);
      const firstViews = first.events.filter(event => event.name === contract.pageViewEvent);
      const secondViews = second.events.filter(event => event.name === contract.pageViewEvent);
      journey = { consentGranted, first, second, assertions: {
        ...(contract.attribution ? attributionAssertions(firstAttribution, secondAttribution, new URL(url).searchParams.get('utm_source'), new URL(secondUrl).searchParams.get('utm_source')) : {}),
        ...(contract.pageViewEvent ? {
          onePageViewOnFirstVisit: firstViews.length === 1,
          onePageViewOnSecondVisit: secondViews.length === 1,
          pageViewEventIdOnEachVisit: firstViews.length === 1 && secondViews.length === 1 && [...firstViews, ...secondViews].every(event => event.eventIdPresent),
        } : {}),
      } };
      await context.close();
    }
    return { cases, journey };
  } finally { await browser.close(); }
}

export function evaluate(report, source = null, rawContract = {}) {
  const contract = validateContract(rawContract);
  const cases = report.cases || [];
  const granted = cases.find(item => item.label === 'grant-consent');
  const denied = cases.find(item => item.label === 'deny-consent');
  const noConsent = cases.find(item => item.label === 'no-consent');
  const loaded = item => !!item && item.navigationStatus >= 200 && item.navigationStatus < 400 && Array.isArray(item.after?.events);
  const ready = loaded(granted) && loaded(denied) && loaded(noConsent);
  const namedEvents = !!(contract.applicationEvents?.length || contract.pageViewEvent);
  const events = item => applicationEvents(item?.after?.events || [], contract);
  const forbidden = [...events(noConsent), ...events(denied), ...applicationEvents(granted?.before?.events || [], contract)];
  const seenGranted = events(granted);
  const consentKnown = ready && namedEvents && denied.consentActionClicked && granted.consentActionClicked && seenGranted.length > 0;
  const pageViews = seenGranted.filter(event => event.name === contract.pageViewEvent);
  const preConsent = [noConsent, denied].filter(Boolean).flatMap(item => [
    ...(item.after?.cookies || []).filter(name => /^_ga(?:_|$)|^_gcl_|^_fbp$/.test(name)),
    ...(item.requests || []).filter(request => ['google', 'meta'].includes(request.provider)),
  ]);
  const observedApiEvents = [...new Set(cases.flatMap(item => item.requests || []).map(request => request.payloadSummary?.eventType).filter(Boolean))];
  // Source regex matches are hints, not an authoritative event contract.
  const driftKnown = ready && contract.collectors?.length && contract.expectedApiEvents?.length && observedApiEvents.length > 0;
  const drift = observedApiEvents.filter(event => !contract.expectedApiEvents?.includes(event));
  const finding = (id, status, message) => ({ id, severity: status.toLowerCase().replace('_', '-'), status, message });
  const findings = [
    finding('CONSENT_APP_EVENTS', namedEvents && forbidden.length ? 'FAIL' : consentKnown ? 'PASS' : 'UNKNOWN', 'Checks declared application events before consent and after refusal. PASS requires both consent actions and a positive granted-event control.'),
    finding('GRANTED_PAGE_VIEW', !contract.pageViewEvent || !loaded(granted) || !granted.consentActionClicked ? 'UNKNOWN' : pageViews.length === 1 ? 'PASS' : 'FAIL', 'One configured page-view event is required; no project-specific event is assumed.'),
    finding('BROWSER_ERRORS', !ready ? 'UNKNOWN' : cases.some(item => item.consoleErrors?.length || item.pageErrors?.length) ? 'FAIL' : 'PASS', 'Browser console/page errors checked on loaded pages.'),
    finding('PRECONSENT_PROVIDER_ACTIVITY', preConsent.length ? 'WARN' : ready ? 'PASS' : 'UNKNOWN', 'Provider activity is an observation, not proof of consent semantics or provider delivery.'),
    finding('SOURCE_RUNTIME_EVENT_DRIFT', !driftKnown ? 'UNKNOWN' : drift.length ? 'FAIL' : 'PASS', 'Compares observed collector event types with explicitly declared expectedApiEvents, not source-regex guesses.'),
    finding('FORM_CONVERSION', 'NOT_RUN', 'Forms and conversions are not submitted by the safe default runner.'),
  ];
  if (report.journey) {
    const assertions = report.journey.assertions || {};
    const grantedJourney = report.journey.consentGranted;
    findings.push(finding('PAGE_VIEW_DEDUPE', !contract.pageViewEvent || !grantedJourney ? 'UNKNOWN' : assertions.onePageViewOnFirstVisit && assertions.onePageViewOnSecondVisit ? 'PASS' : 'FAIL', 'Exactly one configured page view per visit.'));
    findings.push(finding('ATTRIBUTION_HANDOFF', !contract.attribution || !grantedJourney ? 'UNKNOWN' : assertions.firstTouchPreserved && assertions.lastTouchUpdated ? 'PASS' : 'FAIL', 'Configured attribution storage compared in memory; requires distinct nonempty synthetic utm_source values.'));
  }
  return findings;
}

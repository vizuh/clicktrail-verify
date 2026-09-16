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
const safeUrl = (raw) => { const url = new URL(raw); return { origin: url.origin, queryKeys: [...new Set(url.searchParams.keys()).filter((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key))].sort() }; };
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const providerFor = (raw) => {
  const host = new URL(raw).hostname.toLowerCase();
  if (['google.com', 'doubleclick.net', 'googletagmanager.com', 'googlesyndication.com'].some((domain) => hostMatches(host, domain))) return 'google';
  if (hostMatches(host, 'facebook.com')) return 'meta';
  if (hostMatches(host, 'hyperdx.io') || hostMatches(host, 'clickhouse.com')) return 'clickstack';
  return 'other';
};

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
  return page.evaluate(() => {
    const safeKey = (key) => /^[A-Za-z0-9_:.\-]{1,64}$/.test(key);
    return {
      titlePresent: document.title.length > 0,
      cookies: document.cookie.split(';').map((item) => item.trim().split('=')[0]).filter((name) => name && safeKey(name)).sort(),
      localStorageKeys: Object.keys(localStorage).filter(safeKey).sort(),
      sessionStorageKeys: Object.keys(sessionStorage).filter(safeKey).sort(),
      events: (window.__clicktrailVerify?.events || []).map((event) => ({
        name: typeof event.name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(event.name) ? event.name : 'unclassified',
        eventIdPresent: event.eventIdPresent === true,
      })),
    };
  });
}

const emptySnapshot = () => ({ titlePresent: false, cookies: [], localStorageKeys: [], sessionStorageKeys: [], events: [] });

async function runCase(browser, label, url, consentAction, contract) {
  const requests = [];
  const responses = [];
  const consoleErrors = [];
  const pageErrors = [];
  let context;
  let navigationStatus = null;
  let navigationError = null;
  let before = emptySnapshot();
  let after = emptySnapshot();
  let clicked = false;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await installProbe(page);
    page.on('request', (request) => {
      if (!['document', 'script', 'fetch', 'xhr', 'beacon'].includes(request.resourceType())) return;
      try {
        const requestUrl = new URL(request.url());
        const result = { provider: providerFor(request.url()), method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType() };
        let pageOrigin = null;
        try { pageOrigin = new URL(page.url()).origin; } catch { /* page may not have navigated yet */ }
        const collector = pageOrigin && requestUrl.origin === pageOrigin && contract.collectors?.find(item => item.path === requestUrl.pathname);
        if (collector) {
          try {
            const body = request.postDataJSON();
            const event = collector.eventField.split('.').reduce((value, key) => value?.[key], body);
            result.payloadSummary = { eventType: typeof event === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(event) ? event : null };
          } catch { result.payloadSummary = { parseable: false }; }
        }
        requests.push(result);
      } catch { /* malformed request URL is not test evidence */ }
    });
    page.on('response', (response) => {
      if (!['document', 'script', 'fetch', 'xhr', 'beacon'].includes(response.request().resourceType())) return;
      try { responses.push({ provider: providerFor(response.url()), status: response.status(), url: safeUrl(response.url()) }); } catch { /* ignore malformed response URLs */ }
    });
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push('console_error'); });
    page.on('pageerror', () => pageErrors.push('page_error'));
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    navigationStatus = navigation?.status() ?? null;
    await page.waitForTimeout(5_000);
    before = await pageSnapshot(page);
    if (consentAction) clicked = await consentAction(page);
    await page.waitForTimeout(3_000);
    after = await pageSnapshot(page);
  } catch {
    // A failed navigation or closed/crashed browser cannot prove a finding.
    navigationError = 'Navigation or browser operation failed';
  } finally {
    try { await context?.close(); } catch { /* preserve the unknown result */ }
  }
  const appEvents = applicationEvents(after.events, contract);
  return { label, navigationStatus, navigationError, consentActionClicked: clicked, before, after, appEvents, requests, responses, consoleErrors, pageErrors };
}

async function clickConsent(page, action, contract) {
  try {
    const explicit = contract.consent?.[`${action}Button`];
    const fallback = action === 'accept' ? /^(aceite tudo|aceitar(?: tudo| todos)?|accept(?: all)?|consentir|allow(?: all)?|permitir)$/i : /^(rejeitar(?: tudo| todos)?|recusar|decline|reject(?: all)?|não aceito|nao aceito|apenas necessários)$/i;
    const buttons = page.getByRole('button', { name: explicit || fallback, exact: !!explicit });
    if (await buttons.count() !== 1 || !await buttons.isVisible()) return false;
    await buttons.click({ timeout: 5_000 });
    return true;
  } catch {
    // Missing, ambiguous, detached, or closed controls do not prove consent.
    return false;
  }
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

export async function runBrowserVerification({ url, secondUrl, executablePath, allowNoSandbox = false, contract: rawContract = {} }) {
  const contract = validateContract(rawContract);
  try {
    new URL(url);
    if (secondUrl) new URL(secondUrl);
  } catch {
    return { cases: [], journey: null, browserError: 'Invalid navigation URL' };
  }
  let browser;
  try {
    const args = ['--disable-dev-shm-usage'];
    if (allowNoSandbox === true) args.push('--no-sandbox');
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args });
  } catch {
    // Do not silently retry with --no-sandbox. That flag weakens the browser
    // boundary and must be an explicit caller choice.
    return { cases: [], journey: null, browserError: 'Browser launch failed' };
  }
  try {
    const cases = [];
    for (const [label, action] of [['no-consent', null], ['deny-consent', 'deny'], ['grant-consent', 'accept']]) {
      cases.push(await runCase(browser, label, url, action ? page => clickConsent(page, action, contract) : null, contract));
    }
    let journey = null;
    if (secondUrl) {
      let context;
      try {
        context = await browser.newContext();
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
      } catch {
        // A partial two-touch journey cannot prove handoff or dedupe.
        journey = { error: 'Journey navigation or browser operation failed', assertions: {} };
      } finally {
        try { await context?.close(); } catch { /* preserve unknown journey */ }
      }
    }
    return { cases, journey };
  } finally { try { await browser.close(); } catch { /* preserve collected evidence */ } }
}

export function evaluate(report, source = null, rawContract = {}) {
  const contract = validateContract(rawContract);
  const safeReport = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const cases = Array.isArray(safeReport.cases) ? safeReport.cases : [];
  const granted = cases.find(item => item?.label === 'grant-consent');
  const denied = cases.find(item => item?.label === 'deny-consent');
  const noConsent = cases.find(item => item?.label === 'no-consent');
  const loaded = item => !!item && !item.navigationError && Number.isInteger(item.navigationStatus) && item.navigationStatus >= 200 && item.navigationStatus < 400 && Array.isArray(item.after?.events);
  const ready = loaded(granted) && loaded(denied) && loaded(noConsent);
  const namedEvents = !!(contract.applicationEvents?.length || contract.pageViewEvent);
  const events = item => applicationEvents(Array.isArray(item?.after?.events) ? item.after.events : [], contract);
  const forbidden = [...events(noConsent), ...events(denied), ...applicationEvents(Array.isArray(granted?.before?.events) ? granted.before.events : [], contract)];
  const seenGranted = events(granted);
  const consentKnown = ready && namedEvents && denied.consentActionClicked && granted.consentActionClicked && seenGranted.length > 0;
  const pageViews = seenGranted.filter(event => event.name === contract.pageViewEvent);
  const preConsent = [noConsent, denied].filter(Boolean).flatMap(item => [
    ...(Array.isArray(item?.after?.cookies) ? item.after.cookies : []).filter(name => /^_ga(?:_|$)|^_gcl_|^_fbp$/.test(name)),
    ...(Array.isArray(item?.requests) ? item.requests : []).filter(request => ['google', 'meta'].includes(request?.provider)),
  ]);
  const observedApiEvents = [...new Set(cases.flatMap(item => Array.isArray(item?.requests) ? item.requests : []).map(request => request?.payloadSummary?.eventType).filter(Boolean))];
  // Source regex matches are hints, not an authoritative event contract.
  const driftKnown = ready && contract.collectors?.length && contract.expectedApiEvents?.length && observedApiEvents.length > 0;
  const drift = observedApiEvents.filter(event => !contract.expectedApiEvents?.includes(event));
  const finding = (id, status, message) => ({ id, severity: status.toLowerCase().replace('_', '-'), status, message });
  const findings = [
    finding('CONSENT_APP_EVENTS', namedEvents && forbidden.length ? 'FAIL' : consentKnown ? 'PASS' : 'UNKNOWN', 'Checks declared application events before consent and after refusal. PASS requires both consent actions and a positive granted-event control.'),
    finding('GRANTED_PAGE_VIEW', !contract.pageViewEvent || !loaded(granted) || !granted.consentActionClicked ? 'UNKNOWN' : pageViews.length === 1 ? 'PASS' : 'FAIL', 'One configured page-view event is required; no project-specific event is assumed.'),
    finding('BROWSER_ERRORS', !ready ? 'UNKNOWN' : cases.some(item => item?.consoleErrors?.length || item?.pageErrors?.length) ? 'FAIL' : 'PASS', 'Browser console/page errors checked on loaded pages.'),
    finding('PRECONSENT_PROVIDER_ACTIVITY', preConsent.length ? 'WARN' : ready ? 'PASS' : 'UNKNOWN', 'Provider activity is an observation, not proof of consent semantics or provider delivery.'),
    finding('SOURCE_RUNTIME_EVENT_DRIFT', !driftKnown ? 'UNKNOWN' : drift.length ? 'FAIL' : 'PASS', 'Compares observed collector event types with explicitly declared expectedApiEvents, not source-regex guesses.'),
    finding('FORM_CONVERSION', 'NOT_RUN', 'Forms and conversions are not submitted by the safe default runner.'),
  ];
  const journey = safeReport.journey && typeof safeReport.journey === 'object' && !Array.isArray(safeReport.journey) ? safeReport.journey : null;
  if (journey) {
    const assertions = journey.assertions && typeof journey.assertions === 'object' ? journey.assertions : {};
    const grantedJourney = journey.consentGranted === true;
    findings.push(finding('PAGE_VIEW_DEDUPE', !contract.pageViewEvent || !grantedJourney ? 'UNKNOWN' : assertions.onePageViewOnFirstVisit && assertions.onePageViewOnSecondVisit ? 'PASS' : 'FAIL', 'Exactly one configured page view per visit.'));
    findings.push(finding('ATTRIBUTION_HANDOFF', !contract.attribution || !grantedJourney ? 'UNKNOWN' : assertions.firstTouchPreserved && assertions.lastTouchUpdated ? 'PASS' : 'FAIL', 'Configured attribution storage compared in memory; requires distinct nonempty synthetic utm_source values.'));
  }
  return findings;
}

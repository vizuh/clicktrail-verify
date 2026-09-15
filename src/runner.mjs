import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

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

async function runCase(browser, label, url, consentAction) {
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
      if (new URL(request.url()).pathname === '/api/leads') {
        try {
          const body = request.postDataJSON() || {};
          result.payloadSummary = {
            eventType: typeof body.event_type === 'string' ? body.event_type : null,
            siteKeyPresent: typeof body.site_key === 'string' && body.site_key.length > 0,
            attributionFieldsPresent: ['utm_source', 'utm_medium', 'utm_campaign', 'gclid'].filter((key) => typeof body[key] === 'string' && body[key].length > 0),
            identityFieldsPresent: ['visitor_id', 'session_id'].filter((key) => typeof body[key] === 'string' && body[key].length > 0),
          };
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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5_000);
  const before = await pageSnapshot(page);
  let clicked = false;
  if (consentAction) clicked = await consentAction(page);
  await page.waitForTimeout(3_000);
  const after = await pageSnapshot(page);
  await context.close();
  const appEvents = after.events.filter((event) => event.name.startsWith('ferraria_'));
  return { label, consentActionClicked: clicked, before, after, appEvents, requests, responses, consoleErrors, pageErrors };
}

export async function runBrowserVerification({ url, secondUrl, executablePath }) {
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const accept = async (page) => { const button = page.getByRole('button', { name: /aceite tudo|aceitar|accept|consentir|allow|permitir/i }); if (!await button.count()) return false; await button.first().click({ timeout: 5_000 }); return true; };
  const deny = async (page) => { const button = page.getByRole('button', { name: /rejeitar|recusar|decline|reject|não aceito|nao aceito|apenas necessári/i }); if (!await button.count()) return false; await button.first().click({ timeout: 5_000 }); return true; };
  const cases = [
    await runCase(browser, 'no-consent', url, null),
    await runCase(browser, 'deny-consent', url, deny),
    await runCase(browser, 'grant-consent', url, accept),
  ];
  let journey = null;
  if (secondUrl) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installProbe(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(5_000);
    const acceptButton = page.getByRole('button', { name: /aceite tudo|aceitar|accept|consentir|allow|permitir/i });
    const consentGranted = await acceptButton.count() > 0;
    if (consentGranted) await acceptButton.first().click({ timeout: 5_000 });
    await page.waitForTimeout(3_000);
    const firstSnapshot = await pageSnapshot(page);
    const firstAttribution = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ferraria_tracking_attribution') || '{}').value || {}; } catch { return {}; }
    });
    await page.goto(secondUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }); await page.waitForTimeout(5_000);
    const secondSnapshot = await pageSnapshot(page);
    const secondAttribution = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('ferraria_tracking_attribution') || '{}').value || {}; } catch { return {}; }
    });
    const firstPageViews = firstSnapshot.events.filter((event) => event.name === 'ferraria_page_view');
    const secondPageViews = secondSnapshot.events.filter((event) => event.name === 'ferraria_page_view');
    const expectedFirst = new URL(url).searchParams.get('utm_source') || '';
    const expectedSecond = new URL(secondUrl).searchParams.get('utm_source') || '';
    journey = {
      consentGranted,
      first: firstSnapshot,
      second: secondSnapshot,
      assertions: {
        firstTouchPreserved: firstAttribution.ft_source === expectedFirst && secondAttribution.ft_source === expectedFirst,
        lastTouchUpdated: firstAttribution.lt_source === expectedFirst && secondAttribution.lt_source === expectedSecond,
        onePageViewOnFirstVisit: firstPageViews.length === 1,
        onePageViewOnSecondVisit: secondPageViews.length === 1,
        pageViewEventIdOnEachVisit: firstPageViews.every((event) => event.eventIdPresent) && secondPageViews.every((event) => event.eventIdPresent),
      },
    };
    await context.close();
  }
  await browser.close();
  return { cases, journey };
}

export function evaluate(report, source = null) {
  const granted = report.cases.find((item) => item.label === 'grant-consent');
  const denied = report.cases.find((item) => item.label === 'deny-consent');
  const noConsent = report.cases.find((item) => item.label === 'no-consent');
  const hasDeniedAppEvent = (denied?.appEvents.length || 0) > 0;
  const hasGrantedPageView = (granted?.appEvents || []).filter((event) => event.name === 'ferraria_page_view').length === 1;
  const preConsent = [noConsent, denied].filter(Boolean).flatMap((item) => [
    ...(item.before?.cookies || []).filter((name) => /^_gcl_/.test(name)),
    ...(item.before?.localStorageKeys || []).filter((name) => /^_gcl_/.test(name)),
    ...(item.requests || []).filter((request) => request.provider === 'google').map((request) => request.url.pathname),
  ]);
  const observedApiEvents = [...new Set([noConsent, denied, granted].filter(Boolean).flatMap((item) => item.requests).map((request) => request.payloadSummary?.eventType).filter(Boolean))].sort();
  const sourceEventTypes = source?.eventTypes || [];
  const drift = source && observedApiEvents.filter((eventType) => !sourceEventTypes.includes(eventType));
  const findings = [
    { id: 'CONSENT_APP_EVENTS', severity: hasDeniedAppEvent ? 'fail' : 'pass', status: hasDeniedAppEvent ? 'FAIL' : 'PASS', message: hasDeniedAppEvent ? 'Application events were observed after consent denial.' : 'No application events were observed in the denied case.' },
    { id: 'GRANTED_PAGE_VIEW', severity: hasGrantedPageView ? 'pass' : 'fail', status: hasGrantedPageView ? 'PASS' : 'FAIL', message: hasGrantedPageView ? 'One consented ferraria_page_view event was observed.' : 'Expected one consented ferraria_page_view event.' },
    { id: 'BROWSER_ERRORS', severity: report.cases.some((item) => item.consoleErrors.length || item.pageErrors.length) ? 'fail' : 'pass', status: report.cases.some((item) => item.consoleErrors.length || item.pageErrors.length) ? 'FAIL' : 'PASS', message: 'Console and page errors were checked.' },
    { id: 'PRECONSENT_PROVIDER_ACTIVITY', severity: preConsent.length ? 'warn' : 'pass', status: preConsent.length ? 'WARN' : 'PASS', message: preConsent.length ? 'Google/linker cookies or provider requests were observed before affirmative consent; review the CMP and Consent Mode configuration.' : 'No pre-consent provider activity was observed.' },
    { id: 'SOURCE_RUNTIME_EVENT_DRIFT', severity: drift?.length ? 'fail' : 'pass', status: drift?.length ? 'FAIL' : 'PASS', message: drift?.length ? `Observed API event types absent from the inspected source contract: ${drift.join(', ')}.` : 'Observed API event types match the inspected source contract.' },
    { id: 'FORM_CONVERSION', severity: 'not-run', status: 'NOT_RUN', message: 'Forms and conversions are not submitted by the safe default runner.' },
  ];
  if (report.journey) findings.push({ id: 'PAGE_VIEW_DEDUPE', severity: report.journey.assertions.onePageViewOnFirstVisit && report.journey.assertions.onePageViewOnSecondVisit ? 'pass' : 'fail', status: report.journey.assertions.onePageViewOnFirstVisit && report.journey.assertions.onePageViewOnSecondVisit ? 'PASS' : 'FAIL', message: 'One page-view event per synthetic visit was checked.' });
  return findings;
}

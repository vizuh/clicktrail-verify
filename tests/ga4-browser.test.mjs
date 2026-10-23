import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { runBrowserVerification, evaluate } from '../src/runner.mjs';
import { buildEvidenceEnvelope, validateEvidenceEnvelope } from '../src/evidence.mjs';

const FIXTURES = new URL('./fixtures/ga4/', import.meta.url);
const PAGES = ['healthy', 'sid-override', 'reserved-param', 'double-page-view', 'push-then-navigate', 'gs1-parser'];
const RAW_IDS = ['1700000001', '555000111', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'];
const contract = {
  consent: { acceptButton: 'Accept all', denyButton: 'Reject all' },
  ga4: {
    hostSessionId: { path: '/api/checkout', field: 'ga_session_id' },
    preNavigation: { trigger: 'Pay now', event: 'begin_checkout' },
  },
};

function fixtureServer() {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://fixture.test');
    if (pathname === '/g/collect' || pathname === '/api/checkout' || pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = pathname === '/fixture.js' ? 'fixture.js' : PAGES.includes(pathname.slice(1)) ? `${pathname.slice(1)}.html` : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await fs.readFile(new URL(file, FIXTURES)));
  });
}

const GA4_IDS = ['GA4_SID_CONTINUITY', 'GA4_SID_FORMAT', 'GA4_RESERVED_PARAM_OVERRIDE', 'GA4_PAGE_VIEW_PER_NAVIGATION', 'GA4_PRE_NAVIGATION_DELIVERY', 'GA4_COOKIE_PARSE'];
const EXPECTED = {
  healthy: {},
  'sid-override': { GA4_SID_CONTINUITY: 'FAIL', GA4_SID_FORMAT: 'FAIL' },
  'reserved-param': { GA4_RESERVED_PARAM_OVERRIDE: 'FAIL' },
  'double-page-view': { GA4_PAGE_VIEW_PER_NAVIGATION: 'FAIL' },
  'push-then-navigate': { GA4_PRE_NAVIGATION_DELIVERY: 'FAIL' },
  'gs1-parser': { GA4_COOKIE_PARSE: 'FAIL' },
};

test('GA4 hit fixtures fail exactly their intended check and never leak raw IDs', { skip: !process.env.CLICKTRAIL_BROWSER_EXECUTABLE, timeout: 180_000 }, async () => {
  const server = fixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const runs = await Promise.all(PAGES.map(page => runBrowserVerification({
      url: `${base}/${page}?utm_source=one`,
      secondUrl: page === 'healthy' ? `${base}/${page}?utm_source=two` : undefined,
      contract,
      executablePath: process.env.CLICKTRAIL_BROWSER_EXECUTABLE,
    })));
    for (const [index, page] of PAGES.entries()) {
      const browser = runs[index];
      const findings = evaluate(browser, null, contract);
      const statuses = Object.fromEntries(findings.map(item => [item.id, item.status]));
      for (const id of GA4_IDS) assert.equal(statuses[id], EXPECTED[page][id] || 'PASS', `${page}: ${id}`);
      const evidence = buildEvidenceEnvelope({ target: `${base}/${page}`, contract, browser, findings });
      assert.deepEqual(validateEvidenceEnvelope(evidence), [], page);
      assert.ok(evidence.findings.find(item => item.id === 'GA4_PRE_NAVIGATION_DELIVERY').evidenceRefs.includes('ga4:pre-navigation'), page);
      assert.equal(browser.preNavigation.offsiteNavigation, true, page);
      const serialized = JSON.stringify({ browser, evidence });
      for (const raw of RAW_IDS) assert.ok(!serialized.includes(raw), `${page} leaked a raw ID`);
    }
    // The second touch is a separate page load in the same visit.
    assert.equal(runs[0].journey.ga4.navigationCount, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

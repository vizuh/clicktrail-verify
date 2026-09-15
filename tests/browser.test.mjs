import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runBrowserVerification, evaluate } from '../src/runner.mjs';

test('generic browser contract covers consent, collector and two-touch attribution', { skip: !process.env.CLICKTRAIL_BROWSER_EXECUTABLE }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') { res.writeHead(204).end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><title>Verifier fixture</title><button id="yes">Enable metrics</button><button id="no">Keep private</button><script>
      function emit() {
        const source = new URL(location.href).searchParams.get('utm_source');
        const old = JSON.parse(localStorage.getItem('sample:touches') || 'null');
        localStorage.setItem('sample:touches', JSON.stringify({ first: { source: old?.first.source || source }, last: { source } }));
        window.dataLayer.push({ event: 'sample_visit', event_id: 'synthetic-id' });
        fetch('/metrics', { method: 'POST', body: JSON.stringify({ envelope: { kind: 'sample_visit' }, secret: 'MUST_NOT_APPEAR' }) });
      }
      yes.onclick = () => { localStorage.setItem('sample:consent', 'yes'); emit(); };
      no.onclick = () => localStorage.setItem('sample:consent', 'no');
      if (localStorage.getItem('sample:consent') === 'yes') emit();
    </script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const contract = { pageViewEvent: 'sample_visit', consent: { acceptButton: 'Enable metrics', denyButton: 'Keep private' }, attribution: { storageKey: 'sample:touches', firstTouchPath: 'first.source', lastTouchPath: 'last.source' }, collectors: [{ path: '/metrics', eventField: 'envelope.kind' }], expectedApiEvents: ['sample_visit'] };
    const browser = await runBrowserVerification({ url: `${base}/?utm_source=one`, secondUrl: `${base}/?utm_source=two`, contract, executablePath: process.env.CLICKTRAIL_BROWSER_EXECUTABLE });
    const results = Object.fromEntries(evaluate(browser, null, contract).map(item => [item.id, item.status]));
    for (const id of ['CONSENT_APP_EVENTS', 'GRANTED_PAGE_VIEW', 'SOURCE_RUNTIME_EVENT_DRIFT', 'PAGE_VIEW_DEDUPE', 'ATTRIBUTION_HANDOFF']) assert.equal(results[id], 'PASS', id);
    const serialized = JSON.stringify(browser);
    assert.ok(!serialized.includes('MUST_NOT_APPEAR'));
    assert.ok(!serialized.includes('synthetic-id'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

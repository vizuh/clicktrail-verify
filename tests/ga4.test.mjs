import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/runner.mjs';
import { validateContract } from '../src/contract.mjs';
import { buildEvidenceEnvelope, validateEvidenceEnvelope } from '../src/evidence.mjs';
import { isGa4CollectUrl, parseGa4Events, parseGaSessionCookie, idFormat, summarizeGa4 } from '../src/ga4.mjs';

const SID = '1700000001';
const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const COOKIES = [{ name: '_ga', value: 'GA1.1.555000111.1700000001' }, { name: '_ga_TEST0001', value: `GS2.1.s${SID}$o1$g0$t${SID}$j60$l0$h0` }];
const event = (en, extra = {}) => ({ v: '2', tid: 'G-TEST0001', cid: '555000111.1700000001', sid: SID, gcs: 'G111', en, ...extra });
const hit = (events, navigation = 1, state = 'finished') => ({ navigation, state, events });

function report(ga4, extra = {}) {
  const entry = (label) => ({ label, navigationStatus: 200, consentActionClicked: label !== 'no-consent', before: { events: [] }, after: { cookies: [], events: [] }, requests: [], consoleErrors: [], pageErrors: [] });
  return { cases: [entry('no-consent'), entry('deny-consent'), { ...entry('grant-consent'), ga4 }], journey: null, ...extra };
}
const statuses = (browser, contract = {}) => Object.fromEntries(evaluate(browser, null, contract).filter(item => item.id.startsWith('GA4_')).map(item => [item.id, item.status]));

test('recognizes GA4 collect hits, including first-party server-side paths', () => {
  assert.ok(isGa4CollectUrl('https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST0001'));
  assert.ok(isGa4CollectUrl('https://metrics.example.test/g/collect?v=2&tid=G-TEST0001'));
  assert.ok(!isGa4CollectUrl('https://www.google-analytics.com/collect?v=1&tid=UA-1'));
  assert.ok(!isGa4CollectUrl('https://example.test/g/collect?v=2&tid=AW-1'));
  assert.ok(!isGa4CollectUrl('not a url'));
});

test('splits batched GA4 requests into events that inherit shared parameters', () => {
  const events = parseGa4Events(`https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST0001&sid=${SID}`, 'en=page_view\r\nen=view_item&ep.item=one');
  assert.deepEqual(events.map(item => [item.en, item.sid, item['ep.item']]), [['page_view', SID, undefined], ['view_item', SID, 'one']]);
  assert.equal(parseGa4Events(`https://x.test/g/collect?v=2&en=page_view`, null).length, 1);
});

test('parses GS1 and GS2 session cookies and rejects other values', () => {
  assert.deepEqual(parseGaSessionCookie(`GS1.1.${SID}.3.1.1700000100.0.0.0`), { format: 'GS1', sessionId: SID });
  assert.deepEqual(parseGaSessionCookie(`GS2.1.s${SID}$o3$g1$t1700000100$j0$l0$h0`), { format: 'GS2', sessionId: SID });
  assert.deepEqual(parseGaSessionCookie('foo123bar456'), { format: 'unparsed', sessionId: null });
  assert.deepEqual([SID, UUID, 's1700000001$o1', '', undefined].map(idFormat), ['numeric10', 'uuid', 'other', 'missing', 'missing']);
});

test('summaries keep counts, formats and equality only', () => {
  const summary = summarizeGa4({
    hits: [hit([event('page_view'), event('view_item', { sid: UUID, 'ep.session_id': UUID })]), hit([event('page_view')], 1), hit([event('page_view', { gcs: 'G100' })], 2)],
    cookies: COOKIES,
    hostValues: [SID, 's1700000001$o1'],
    trackedEvent: 'view_item',
  });
  const [property] = summary.properties;
  assert.equal(summary.analyticsDeniedEventCount, 1);
  assert.deepEqual(property.sid, { distinctCount: 2, missingCount: 0, numeric10Count: 2, uuidCount: 1, otherCount: 0 });
  assert.equal(property.cookieFormat, 'GS2');
  assert.equal(property.sidMatchesCookie, false);
  assert.deepEqual(property.reservedParams, ['ep.session_id']);
  assert.equal(property.maxPageViewsPerNavigation, 2);
  assert.deepEqual(summary.hostSessionId, { requestCount: 2, valueFormats: { numeric10: 1, other: 1 }, propertyResolution: 'single-cookie', cookieFormat: 'GS2', matchCount: 1, mismatchCount: 1 });
  assert.deepEqual(summary.trackedEvent, { issuedCount: 1, finishedCount: 1, failedCount: 0, unconfirmedCount: 0 });
  const serialized = JSON.stringify(summary);
  for (const raw of [SID, UUID, '555000111', 'TEST0001']) assert.ok(!serialized.includes(raw), raw);
});

test('host session cookie resolution pins the declared property', () => {
  const cookies = [{ name: '_ga_OTHER01', value: 'GS2.1.s1700000111$o1' }, { name: '_ga_TEST0001', value: `GS2.1.s${SID}$o1` }];
  assert.equal(summarizeGa4({ cookies, hostValues: [SID], measurementId: 'G-TEST0001' }).hostSessionId.matchCount, 1);
  assert.equal(summarizeGa4({ cookies, hostValues: ['1700000111'], measurementId: 'G-TEST0001' }).hostSessionId.mismatchCount, 1);
  assert.equal(summarizeGa4({ cookies, hostValues: [SID] }).hostSessionId.propertyResolution, 'ambiguous');
});

test('healthy hits pass every GA4 hit check', () => {
  const ga4 = summarizeGa4({ hits: [hit([event('page_view')]), hit([event('view_item')]), hit([event('page_view')], 2)], cookies: COOKIES, hostValues: [SID] });
  const contract = { ga4: { hostSessionId: { path: '/api/checkout', field: 'ga_session_id' } } };
  assert.deepEqual(statuses(report(ga4), contract), {
    GA4_SID_CONTINUITY: 'PASS', GA4_SID_FORMAT: 'PASS', GA4_RESERVED_PARAM_OVERRIDE: 'PASS', GA4_PAGE_VIEW_PER_NAVIGATION: 'PASS', GA4_PRE_NAVIGATION_DELIVERY: 'NOT_RUN', GA4_COOKIE_PARSE: 'PASS',
  });
});

test('each GA4 defect fails its own check', () => {
  const run = (hits, hostValues = null, cookies = COOKIES) => statuses(report(summarizeGa4({ hits, cookies, hostValues })), hostValues ? { ga4: { hostSessionId: { path: '/api/checkout', field: 'ga_session_id' } } } : {});
  const override = run([hit([event('page_view'), event('view_item', { sid: UUID })])]);
  assert.equal(override.GA4_SID_CONTINUITY, 'FAIL');
  assert.equal(override.GA4_SID_FORMAT, 'FAIL');
  assert.equal(run([hit([event('page_view', { sid: '1700000999' })])]).GA4_SID_CONTINUITY, 'FAIL', 'sid differs from cookie');
  assert.equal(run([hit([event('page_view'), event('view_item', { sid: '' })])]).GA4_SID_CONTINUITY, 'FAIL', 'missing sid');
  assert.equal(run([hit([event('view_item', { 'epn.user_id': '7' })])]).GA4_RESERVED_PARAM_OVERRIDE, 'FAIL');
  assert.equal(run([hit([event('page_view'), event('page_view')])]).GA4_PAGE_VIEW_PER_NAVIGATION, 'FAIL');
  assert.equal(run([hit([event('page_view')])], ['s1700000001$o1$g0']).GA4_COOKIE_PARSE, 'FAIL');
  assert.equal(run([hit([event('page_view')])], [null]).GA4_COOKIE_PARSE, 'FAIL');
  assert.equal(run([hit([event('page_view')])], null, [COOKIES[0]]).GA4_SID_CONTINUITY, 'UNKNOWN', 'cookie not comparable');
});

test('GA4 checks are not applicable without hits and unknown without evidence', () => {
  const none = evaluate(report(summarizeGa4({})), null, {}).filter(item => item.id.startsWith('GA4_'));
  for (const item of none.filter(item => item.id !== 'GA4_PRE_NAVIGATION_DELIVERY')) {
    assert.equal(item.status, 'NOT_RUN', item.id);
    assert.equal(item.applicability, 'not-applicable', item.id);
  }
  assert.equal(none.find(item => item.id === 'GA4_PRE_NAVIGATION_DELIVERY').applicability, undefined);
  const unclicked = report(summarizeGa4({}));
  unclicked.cases[2].consentActionClicked = false;
  assert.equal(statuses(unclicked).GA4_SID_CONTINUITY, 'UNKNOWN');
  assert.equal(statuses({ cases: [] }).GA4_SID_FORMAT, 'UNKNOWN');
  assert.equal(statuses(report(null), { ga4: { hostSessionId: { path: '/api/checkout', field: 'id' } } }).GA4_COOKIE_PARSE, 'UNKNOWN');
});

test('pre-navigation delivery needs a clicked trigger and an observed navigation', () => {
  const contract = { ga4: { preNavigation: { trigger: 'Pay now', event: 'begin_checkout' } } };
  const probe = (trackedHits, extra = {}) => ({ consentGranted: true, trigger: 'clicked', navigationObserved: true, offsiteNavigation: true, error: null, ga4: summarizeGa4({ hits: trackedHits, cookies: COOKIES, trackedEvent: 'begin_checkout' }), ...extra });
  const status = (preNavigation) => statuses(report(null, { preNavigation }), contract).GA4_PRE_NAVIGATION_DELIVERY;
  assert.equal(status(probe([hit([event('begin_checkout')])])), 'PASS');
  assert.equal(status(probe([])), 'FAIL', 'never issued');
  assert.equal(status(probe([hit([event('begin_checkout')], 1, 'failed')])), 'FAIL', 'cancelled on unload');
  assert.equal(status(probe([hit([event('begin_checkout')], 1, 'pending')])), 'PASS', 'issued; completion unconfirmed after unload');
  assert.equal(status(probe([], { navigationObserved: false })), 'UNKNOWN');
  assert.equal(status(probe([], { trigger: 'refused-form' })), 'UNKNOWN');
  assert.equal(status(null), 'UNKNOWN');
});

test('evidence envelope carries redacted GA4 observations and references', () => {
  const contract = { ga4: { preNavigation: { trigger: 'Pay now', event: 'begin_checkout' } } };
  const ga4 = summarizeGa4({ hits: [hit([event('page_view')])], cookies: COOKIES });
  const browser = report(ga4, { preNavigation: { consentGranted: true, trigger: 'clicked', navigationObserved: true, offsiteNavigation: true, error: null, ga4: summarizeGa4({ hits: [hit([event('begin_checkout')])], cookies: COOKIES, trackedEvent: 'begin_checkout' }) } });
  const findings = evaluate(browser, null, contract);
  const envelope = buildEvidenceEnvelope({ target: 'https://example.test/', contract, browser, findings });
  assert.deepEqual(validateEvidenceEnvelope(envelope), []);
  assert.deepEqual(envelope.findings.find(item => item.id === 'GA4_SID_CONTINUITY').evidenceRefs, ['ga4:grant-consent', 'ga4:pre-navigation']);
  assert.deepEqual(envelope.findings.find(item => item.id === 'GA4_PRE_NAVIGATION_DELIVERY').evidenceRefs, ['ga4:pre-navigation']);
  assert.equal(envelope.observations.find(item => item.id === 'ga4:pre-navigation').trackedEvent.issuedCount, 1);
  const tampered = report({ ...ga4, properties: [{ ...ga4.properties[0], label: 'G-TEST0001', reservedParams: ['ep.session_id', `ep.${UUID}`], sid: { ...ga4.properties[0].sid, raw: SID } }] });
  const serialized = JSON.stringify(buildEvidenceEnvelope({ browser: tampered, findings: [] }));
  for (const raw of [SID, UUID, 'TEST0001']) assert.ok(!serialized.includes(raw), raw);
});

test('validates the declarative ga4 contract', () => {
  assert.doesNotThrow(() => validateContract({ ga4: { measurementId: 'G-TEST0001', hostSessionId: { path: '/api/checkout', field: 'analytics.ga_session_id' }, preNavigation: { trigger: 'Pay now', event: 'begin_checkout' } } }));
  for (const ga4 of [{ measurementId: 'UA-1' }, { hostSessionId: { path: 'https://x.test/api', field: 'id' } }, { hostSessionId: { path: '/api', field: '__proto__.x' } }, { preNavigation: { trigger: '', event: 'begin_checkout' } }, { preNavigation: { trigger: 'Pay', event: 'begin checkout' } }, { selector: '#pay' }]) {
    assert.throws(() => validateContract({ ga4 }), /Invalid/);
  }
});

// GA4 collect-hit evidence. Raw client and session IDs stay in this module's
// memory; summaries carry only counts, formats, equality booleans, parameter
// names and ordinal property labels.

const RESERVED_PARAM = /^epn?\.(session_id|client_id|user_id)$/;
const ANALYTICS_DENIED = /^G1[01]0$/;
const GA_SESSION_COOKIE = /^_ga_([A-Za-z0-9]{1,32})$/;

export function isGa4CollectUrl(raw) {
  try {
    const url = raw instanceof URL ? raw : new URL(String(raw));
    return /\/g\/collect$/.test(url.pathname) && url.searchParams.get('v') === '2' && /^G-[A-Za-z0-9]{1,32}$/.test(url.searchParams.get('tid') || '');
  } catch {
    return false;
  }
}

// One request can batch several events: shared parameters live in the query
// string and each body line carries one event's parameters.
export function parseGa4Events(raw, body) {
  const url = new URL(String(raw));
  const shared = Object.fromEntries(url.searchParams);
  const lines = typeof body === 'string' ? body.split(/\r?\n/).filter(line => line.trim()) : [];
  if (!lines.length) return [shared];
  return lines.map(line => ({ ...shared, ...Object.fromEntries(new URLSearchParams(line)) }));
}

export function parseGaSessionCookie(value) {
  const text = typeof value === 'string' ? value : '';
  const gs1 = /^GS1\.\d+\.(\d+)\./.exec(text);
  if (gs1) return { format: 'GS1', sessionId: gs1[1] };
  const gs2 = /^GS2\.\d+\.(.+)$/.exec(text);
  if (gs2) {
    const token = gs2[1].split('$').find(item => /^s\d+$/.test(item));
    return token ? { format: 'GS2', sessionId: token.slice(1) } : { format: 'unparsed', sessionId: null };
  }
  return { format: 'unparsed', sessionId: null };
}

export function idFormat(value) {
  if (value === undefined || value === null || value === '') return 'missing';
  const text = String(value);
  if (/^\d{10}$/.test(text)) return 'numeric10';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return 'uuid';
  return 'other';
}

const cookieSuffix = (tid) => String(tid).replace(/^G-/, '');
const tally = (values) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] || 0) + 1 }), {});

function cookieSessions(cookies) {
  const sessions = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const match = GA_SESSION_COOKIE.exec(cookie?.name || '');
    if (match) sessions.set(match[1], parseGaSessionCookie(cookie.value));
  }
  return sessions;
}

function resolveHostCookie({ sessions, measurementId, propertyIds }) {
  if (measurementId) return { resolution: 'pinned', cookie: sessions.get(cookieSuffix(measurementId)) || null };
  if (sessions.size === 1) return { resolution: 'single-cookie', cookie: [...sessions.values()][0] };
  if (propertyIds.length === 1) return { resolution: 'single-property', cookie: sessions.get(cookieSuffix(propertyIds[0])) || null };
  return { resolution: sessions.size || propertyIds.length ? 'ambiguous' : 'none', cookie: null };
}

/**
 * Pure summary of raw in-memory evidence.
 * hits: [{ navigation, state: 'pending'|'finished'|'failed', events: [{ tid, sid, en, gcs, ... }] }]
 * cookies: [{ name, value }]; hostValues: (string|null)[] or null when not configured.
 */
export function summarizeGa4({ hits = [], cookies = [], hostValues = null, measurementId = null, trackedEvent = null } = {}) {
  const sessions = cookieSessions(cookies);
  const events = hits.flatMap(hit => (hit.events || []).map(event => ({ ...event, navigation: hit.navigation, state: hit.state })));
  const granted = events.filter(event => !ANALYTICS_DENIED.test(event.gcs || ''));
  const propertyIds = [...new Set(granted.map(event => event.tid))];
  const properties = propertyIds.map((tid, index) => {
    const own = granted.filter(event => event.tid === tid);
    const sids = own.map(event => event.sid).filter(value => idFormat(value) !== 'missing');
    const formats = tally(own.map(event => idFormat(event.sid)));
    const cookie = sessions.get(cookieSuffix(tid));
    const comparable = cookie?.sessionId && sids.length;
    const pageViews = tally(own.filter(event => event.en === 'page_view').map(event => event.navigation));
    const perNavigation = Object.values(pageViews);
    return {
      label: `property-${index + 1}`,
      eventCount: own.length,
      sid: {
        distinctCount: new Set(sids).size,
        missingCount: formats.missing || 0,
        numeric10Count: formats.numeric10 || 0,
        uuidCount: formats.uuid || 0,
        otherCount: formats.other || 0,
      },
      cookieFormat: cookie ? cookie.format : 'absent',
      sidMatchesCookie: comparable ? sids.every(value => String(value) === cookie.sessionId) : null,
      reservedParams: [...new Set(own.flatMap(event => Object.keys(event).filter(key => RESERVED_PARAM.test(key))))].sort(),
      maxPageViewsPerNavigation: perNavigation.length ? Math.max(...perNavigation) : 0,
      duplicatePageViewNavigations: perNavigation.filter(count => count > 1).length,
    };
  });
  let hostSessionId = null;
  if (Array.isArray(hostValues)) {
    const { resolution, cookie } = resolveHostCookie({ sessions, measurementId, propertyIds });
    const expected = cookie?.sessionId || null;
    hostSessionId = {
      requestCount: hostValues.length,
      valueFormats: tally(hostValues.map(idFormat)),
      propertyResolution: resolution,
      cookieFormat: cookie ? cookie.format : 'absent',
      matchCount: expected ? hostValues.filter(value => value !== null && String(value) === expected).length : 0,
      mismatchCount: expected ? hostValues.filter(value => value === null || String(value) !== expected).length : 0,
    };
  }
  let tracked = null;
  if (trackedEvent) {
    // Completion events are not reported for requests whose document was
    // replaced, so an issued request without a failure is "unconfirmed".
    const matching = events.filter(event => event.en === trackedEvent);
    const states = tally(matching.map(event => event.state));
    tracked = { issuedCount: matching.length, finishedCount: states.finished || 0, failedCount: states.failed || 0, unconfirmedCount: states.pending || 0 };
  }
  return {
    collectEventCount: events.length,
    analyticsDeniedEventCount: events.length - granted.length,
    navigationCount: hits.length ? Math.max(0, ...hits.map(hit => hit.navigation || 0)) : 0,
    properties,
    hostSessionId,
    trackedEvent: tracked,
  };
}

function hostFieldValue(request, url, field) {
  try {
    const body = request.postDataJSON();
    const value = field.split('.').reduce((current, key) => current?.[key], body);
    if (value !== undefined) return value === null ? null : String(value);
  } catch { /* not JSON */ }
  try {
    const text = request.postData();
    if (text) {
      const params = new URLSearchParams(text);
      if (params.has(field)) return params.get(field);
    }
  } catch { /* unreadable body */ }
  return url.searchParams.get(field);
}

/**
 * Attach in-memory GA4 listeners to a page. Call summarize(context) before the
 * context closes; it returns only the redacted summary.
 */
export function recordGa4(page, { origin, ga4 = {}, trackedEvent = null } = {}) {
  let navigation = 0;
  const hits = [];
  const byRequest = new Map();
  const hostConfig = ga4.hostSessionId || null;
  const hostValues = hostConfig ? [] : null;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigation += 1; });
  page.on('request', (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (isGa4CollectUrl(url)) {
      try {
        const hit = { navigation, state: 'pending', events: parseGa4Events(url, request.postData()) };
        hits.push(hit);
        byRequest.set(request, hit);
      } catch { /* malformed hit is not evidence */ }
      return;
    }
    if (hostConfig && url.origin === origin && url.pathname === hostConfig.path) hostValues.push(hostFieldValue(request, url, hostConfig.field));
  });
  page.on('requestfinished', (request) => { const hit = byRequest.get(request); if (hit) hit.state = 'finished'; });
  page.on('requestfailed', (request) => { const hit = byRequest.get(request); if (hit) hit.state = 'failed'; });
  return {
    async summarize(context) {
      const cookies = await context.cookies();
      return summarizeGa4({ hits, cookies, hostValues, measurementId: ga4.measurementId || null, trackedEvent });
    },
  };
}

const validSummary = (value) => !!value && typeof value === 'object' && Array.isArray(value.properties);

/**
 * GA4 findings from redacted visit summaries. A visit is one isolated browser
 * context: the granted case, the second-touch journey, or the pre-navigation probe.
 */
export function ga4Findings({ granted, grantedLoaded, journey, preNavigation, contract, finding }) {
  const visits = [
    grantedLoaded && validSummary(granted?.ga4) ? granted.ga4 : null,
    journey && !journey.error && validSummary(journey.ga4) ? journey.ga4 : null,
    preNavigation && !preNavigation.error && validSummary(preNavigation.ga4) ? preNavigation.ga4 : null,
  ].filter(Boolean);
  const properties = visits.flatMap(visit => visit.properties.filter(property => property?.eventCount > 0 && property.sid));
  const consentObserved = granted?.consentActionClicked === true || journey?.consentGranted === true || preNavigation?.consentGranted === true;
  const notApplicable = { applicability: 'not-applicable' };
  const hitCheck = (id, message, decide) => {
    if (!visits.length) return finding(id, 'UNKNOWN', message);
    if (!properties.length) return consentObserved
      ? finding(id, 'NOT_RUN', `${message} Not applicable: no analytics-granted GA4 collect hits were observed.`, notApplicable)
      : finding(id, 'UNKNOWN', message);
    return finding(id, decide(), message);
  };
  const findings = [
    hitCheck('GA4_SID_CONTINUITY', 'Every analytics-granted GA4 hit in one visit carries one sid per property, equal to the s segment of that property\'s _ga_<container> cookie. UNKNOWN when the cookie cannot be compared. Values are compared in memory only.', () =>
      properties.some(item => item.sid.distinctCount > 1 || item.sid.missingCount > 0 || item.sidMatchesCookie === false) ? 'FAIL'
        : properties.every(item => item.sidMatchesCookie === true) ? 'PASS' : 'UNKNOWN'),
    hitCheck('GA4_SID_FORMAT', 'GA4 sid values are 10-digit numeric session timestamps, never UUIDs or other first-party IDs. Only format classes are reported.', () =>
      properties.some(item => item.sid.uuidCount > 0 || item.sid.otherCount > 0) ? 'FAIL'
        : properties.every(item => item.sid.numeric10Count > 0) ? 'PASS' : 'UNKNOWN'),
    hitCheck('GA4_RESERVED_PARAM_OVERRIDE', 'No GA4 hit sends ep./epn. parameters named session_id, client_id or user_id.', () =>
      properties.some(item => Array.isArray(item.reservedParams) && item.reservedParams.length) ? 'FAIL' : 'PASS'),
    hitCheck('GA4_PAGE_VIEW_PER_NAVIGATION', 'At most one GA4 page_view per property per main-frame navigation (full or same-document).', () =>
      properties.some(item => item.maxPageViewsPerNavigation > 1) ? 'FAIL' : 'PASS'),
  ];
  const preMessage = 'A declared GA4 event triggered right before a top-level navigation leaves the page: a collect request is issued and not reported failed. Navigation targets are replaced by a local stub; forms are never submitted. Provider acceptance is not proven.';
  if (!contract.ga4?.preNavigation) {
    findings.push(finding('GA4_PRE_NAVIGATION_DELIVERY', 'NOT_RUN', `${preMessage} Requires ga4.preNavigation in the contract.`));
  } else {
    const tracked = preNavigation && !preNavigation.error && preNavigation.trigger === 'clicked' ? preNavigation.ga4?.trackedEvent : null;
    const status = !tracked || !preNavigation.navigationObserved ? 'UNKNOWN'
      : tracked.issuedCount > tracked.failedCount ? 'PASS' : 'FAIL';
    findings.push(finding('GA4_PRE_NAVIGATION_DELIVERY', status, preMessage));
  }
  const cookieMessage = 'The GA session ID the host sends on its declared request equals the s segment of the GA4 property cookie (GS1 and GS2). Values are compared in memory only.';
  if (!contract.ga4?.hostSessionId) {
    findings.push(finding('GA4_COOKIE_PARSE', 'NOT_RUN', `${cookieMessage} Not applicable: the contract declares no ga4.hostSessionId request field.`, notApplicable));
  } else {
    const host = visits.map(visit => visit.hostSessionId).filter(item => item && item.requestCount > 0);
    const matches = host.reduce((sum, item) => sum + (item.matchCount || 0), 0);
    const mismatches = host.reduce((sum, item) => sum + (item.mismatchCount || 0), 0);
    findings.push(finding('GA4_COOKIE_PARSE', mismatches > 0 ? 'FAIL' : matches > 0 ? 'PASS' : 'UNKNOWN', cookieMessage));
  }
  return findings;
}

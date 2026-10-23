const EVIDENCE_SCHEMA_VERSION = '1.0.0';

const CASE_LABELS = ['no-consent', 'deny-consent', 'grant-consent'];
const FINDING_CASES = new Map([
  ['CONSENT_APP_EVENTS', CASE_LABELS],
  ['GRANTED_PAGE_VIEW', ['grant-consent']],
  ['BROWSER_ERRORS', CASE_LABELS],
  ['PRECONSENT_PROVIDER_ACTIVITY', ['no-consent', 'deny-consent']],
  ['SOURCE_RUNTIME_EVENT_DRIFT', ['grant-consent']],
]);
const GA4_FINDINGS = new Set(['GA4_SID_CONTINUITY', 'GA4_SID_FORMAT', 'GA4_RESERVED_PARAM_OVERRIDE', 'GA4_PAGE_VIEW_PER_NAVIGATION', 'GA4_COOKIE_PARSE']);

const count = (value) => Array.isArray(value) ? value.length : 0;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function redactTarget(value) {
  try {
    const url = new URL(String(value));
    return {
      origin: url.origin,
      pathname: url.pathname || '/',
      queryKeys: [...new Set([...url.searchParams.keys()].sort())],
    };
  } catch {
    return null;
  }
}

export function targetUrl(value) {
  const target = redactTarget(value);
  return target ? `${target.origin}${target.pathname}` : null;
}

function caseObservation(item) {
  const before = object(item?.before);
  const after = object(item?.after);
  return {
    id: `browser:${item?.label || 'unknown'}`,
    kind: 'browser_case',
    authority: 'observed',
    label: item?.label || 'unknown',
    navigationStatus: Number.isInteger(item?.navigationStatus) ? item.navigationStatus : null,
    navigationError: typeof item?.navigationError === 'string' ? item.navigationError : null,
    consentActionClicked: item?.consentActionClicked === true,
    before: { cookieCount: count(before.cookies), localStorageKeyCount: count(before.localStorageKeys), sessionStorageKeyCount: count(before.sessionStorageKeys), eventCount: count(before.events) },
    after: { cookieCount: count(after.cookies), localStorageKeyCount: count(after.localStorageKeys), sessionStorageKeyCount: count(after.sessionStorageKeys), eventCount: count(after.events), appEventCount: count(item?.appEvents) },
    requestCount: count(item?.requests),
    providerRequestCount: count(Array.isArray(item?.requests) ? item.requests.filter(request => ['google', 'meta'].includes(request?.provider)) : []),
    responseCount: count(item?.responses),
    consoleErrorCount: count(item?.consoleErrors),
    pageErrorCount: count(item?.pageErrors),
  };
}

// GA4 summaries are already redacted (counts, formats, booleans, ordinal
// property labels); the envelope copies only the known fields.
const counts = (value, keys) => Object.fromEntries(keys.map(key => [key, Number(object(value)[key]) || 0]));
const FORMAT_KEYS = ['numeric10', 'uuid', 'other', 'missing'];
function ga4Summary(summary) {
  const value = object(summary);
  const host = value.hostSessionId ? object(value.hostSessionId) : null;
  const properties = Array.isArray(value.properties) ? value.properties.map(item => ({
    label: typeof item?.label === 'string' && /^property-\d+$/.test(item.label) ? item.label : null,
    eventCount: Number(item?.eventCount) || 0,
    sid: counts(item?.sid, ['distinctCount', 'missingCount', 'numeric10Count', 'uuidCount', 'otherCount']),
    cookieFormat: ['GS1', 'GS2', 'unparsed', 'absent'].includes(item?.cookieFormat) ? item.cookieFormat : null,
    sidMatchesCookie: typeof item?.sidMatchesCookie === 'boolean' ? item.sidMatchesCookie : null,
    reservedParams: Array.isArray(item?.reservedParams) ? item.reservedParams.filter(name => typeof name === 'string' && /^epn?\.(session_id|client_id|user_id)$/.test(name)) : [],
    maxPageViewsPerNavigation: Number(item?.maxPageViewsPerNavigation) || 0,
    duplicatePageViewNavigations: Number(item?.duplicatePageViewNavigations) || 0,
  })) : [];
  return {
    collectEventCount: Number(value.collectEventCount) || 0,
    analyticsDeniedEventCount: Number(value.analyticsDeniedEventCount) || 0,
    navigationCount: Number(value.navigationCount) || 0,
    properties,
    hostSessionId: host ? {
      ...counts(host, ['requestCount', 'matchCount', 'mismatchCount']),
      valueFormats: counts(host.valueFormats, FORMAT_KEYS),
      propertyResolution: ['pinned', 'single-cookie', 'single-property', 'ambiguous', 'none'].includes(host.propertyResolution) ? host.propertyResolution : null,
      cookieFormat: ['GS1', 'GS2', 'unparsed', 'absent'].includes(host.cookieFormat) ? host.cookieFormat : null,
    } : null,
    trackedEvent: value.trackedEvent ? counts(value.trackedEvent, ['issuedCount', 'finishedCount', 'failedCount', 'unconfirmedCount']) : null,
  };
}

function ga4Observations(browser) {
  const observations = [];
  const granted = Array.isArray(browser?.cases) ? browser.cases.find(item => item?.label === 'grant-consent') : null;
  if (granted?.ga4) observations.push({ id: 'ga4:grant-consent', kind: 'ga4_hits', authority: 'observed', ...ga4Summary(granted.ga4) });
  if (browser?.journey?.ga4) observations.push({ id: 'ga4:second-touch', kind: 'ga4_hits', authority: 'observed', ...ga4Summary(browser.journey.ga4) });
  const probe = object(browser?.preNavigation);
  if (browser?.preNavigation) {
    observations.push({
      id: 'ga4:pre-navigation',
      kind: 'ga4_pre_navigation',
      authority: 'observed',
      consentGranted: probe.consentGranted === true,
      trigger: typeof probe.trigger === 'string' ? probe.trigger : null,
      navigationObserved: probe.navigationObserved === true,
      offsiteNavigation: probe.offsiteNavigation === true,
      error: typeof probe.error === 'string' ? probe.error : null,
      ...ga4Summary(probe.ga4),
    });
  }
  return observations;
}

function findingRefs(finding, observations) {
  const refs = [];
  for (const label of FINDING_CASES.get(finding.id) || []) {
    if (observations.some(observation => observation.id === `browser:${label}`)) refs.push(`browser:${label}`);
  }
  if (finding.id === 'SOURCE_RUNTIME_EVENT_DRIFT') refs.push('source:inventory');
  if (finding.id === 'BROWSER_ERRORS' && observations.some(observation => observation.id === 'browser:launch')) refs.push('browser:launch');
  if (finding.id === 'PAGE_VIEW_DEDUPE' || finding.id === 'ATTRIBUTION_HANDOFF') refs.push('journey:second-touch');
  if (GA4_FINDINGS.has(finding.id)) refs.push(...observations.filter(observation => observation.id.startsWith('ga4:')).map(observation => observation.id));
  if (finding.id === 'GA4_PRE_NAVIGATION_DELIVERY' && observations.some(observation => observation.id === 'ga4:pre-navigation')) refs.push('ga4:pre-navigation');
  return [...new Set(refs)];
}

export function buildEvidenceEnvelope({ target, repo, contract, source, browser, findings }) {
  const safeSource = object(source);
  const observations = [
    {
      id: 'source:inventory',
      kind: 'source_inventory',
      authority: 'observed',
      filesInspectedCount: count(safeSource.filesInspected),
      findingCategories: Object.keys(object(safeSource.findings)).sort(),
      eventTypeCount: count(safeSource.eventTypes),
    },
    ...(Array.isArray(browser?.cases) ? browser.cases.map(caseObservation) : []),
    ...(browser?.journey ? [{
      id: 'journey:second-touch',
      kind: 'browser_journey',
      authority: 'observed',
      consentGranted: browser.journey.consentGranted === true,
      assertionKeys: Object.keys(object(browser.journey.assertions)).sort(),
      error: typeof browser.journey.error === 'string' ? browser.journey.error : null,
    }] : []),
    ...(browser?.browserError ? [{ id: 'browser:launch', kind: 'browser_run', authority: 'observed', error: browser.browserError }] : []),
    ...ga4Observations(browser),
  ];
  const canonicalFindings = (Array.isArray(findings) ? findings : []).map((finding) => ({
    ...finding,
    evidenceRefs: findingRefs(finding, observations),
    evaluator: 'clicktrail-verify-deterministic',
  }));
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    producer: 'clicktrail-verify',
    target: typeof target === 'string' ? redactTarget(target) : null,
    repo: typeof repo === 'string' ? repo : null,
    contract: object(contract),
    observations,
    findings: canonicalFindings,
    advisory: { status: 'not-run', provider: null, reason: 'Semantic advice is optional and cannot alter deterministic findings.' },
  };
}

export function validateEvidenceEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return ['evidence must be an object'];
  if (envelope.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push(`unsupported evidence schema: ${envelope.schemaVersion}`);
  if (envelope.producer !== 'clicktrail-verify') errors.push('evidence producer is invalid');
  if (envelope.target !== null && (typeof envelope.target !== 'object' || typeof envelope.target.origin !== 'string' || typeof envelope.target.pathname !== 'string' || !Array.isArray(envelope.target.queryKeys))) errors.push('evidence target metadata is invalid');
  if (!Array.isArray(envelope.observations)) errors.push('evidence observations must be an array');
  if (!Array.isArray(envelope.findings)) errors.push('evidence findings must be an array');
  const ids = new Set((envelope.observations || []).map(observation => observation?.id));
  for (const finding of envelope.findings || []) {
    if (!finding || typeof finding.id !== 'string' || !Array.isArray(finding.evidenceRefs)) errors.push('evidence finding shape is invalid');
    for (const ref of finding?.evidenceRefs || []) if (!ids.has(ref)) errors.push(`missing evidence reference: ${ref}`);
  }
  return errors;
}

const EVIDENCE_SCHEMA_VERSION = '1.0.0';

const CASE_LABELS = ['no-consent', 'deny-consent', 'grant-consent'];
const FINDING_CASES = new Map([
  ['CONSENT_APP_EVENTS', CASE_LABELS],
  ['GRANTED_PAGE_VIEW', ['grant-consent']],
  ['BROWSER_ERRORS', CASE_LABELS],
  ['PRECONSENT_PROVIDER_ACTIVITY', ['no-consent', 'deny-consent']],
  ['SOURCE_RUNTIME_EVENT_DRIFT', ['grant-consent']],
]);

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

function findingRefs(finding, observations) {
  const refs = [];
  for (const label of FINDING_CASES.get(finding.id) || []) {
    if (observations.some(observation => observation.id === `browser:${label}`)) refs.push(`browser:${label}`);
  }
  if (finding.id === 'SOURCE_RUNTIME_EVENT_DRIFT') refs.push('source:inventory');
  if (finding.id === 'BROWSER_ERRORS' && observations.some(observation => observation.id === 'browser:launch')) refs.push('browser:launch');
  if (finding.id === 'PAGE_VIEW_DEDUPE' || finding.id === 'ATTRIBUTION_HANDOFF') refs.push('journey:second-touch');
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

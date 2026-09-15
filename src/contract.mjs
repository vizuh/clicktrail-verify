// Contracts contain declarative names and paths only, never executable adapters.
export function validateContract(input = {}) {
  const object = (value, keys, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} contract`);
  };
  const name = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value);
  const field = value => name(value) && !value.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key));
  object(input, ['applicationEvents', 'pageViewEvent', 'consent', 'attribution', 'collectors', 'expectedApiEvents'], 'project');
  for (const key of ['applicationEvents', 'expectedApiEvents']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || !input[key].length || input[key].some(value => !name(value)))) throw new Error(`Invalid ${key}`);
  }
  if (input.pageViewEvent !== undefined && !name(input.pageViewEvent)) throw new Error('Invalid pageViewEvent');
  if (input.consent !== undefined) {
    object(input.consent, ['acceptButton', 'denyButton'], 'consent');
    for (const value of Object.values(input.consent)) if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid consent button name');
  }
  if (input.attribution !== undefined) {
    object(input.attribution, ['storageKey', 'firstTouchPath', 'lastTouchPath'], 'attribution');
    if (!name(input.attribution.storageKey) || !field(input.attribution.firstTouchPath) || !field(input.attribution.lastTouchPath)) throw new Error('Invalid attribution fields');
  }
  if (input.collectors !== undefined) {
    if (!Array.isArray(input.collectors) || !input.collectors.length) throw new Error('Invalid collectors');
    for (const item of input.collectors) {
      object(item, ['path', 'eventField'], 'collector');
      if (typeof item.path !== 'string' || !/^\/(?!\/)[^?#\s]*$/.test(item.path) || !field(item.eventField)) throw new Error('Invalid collector fields');
    }
  }
  return input;
}

export function applicationEvents(events, contract) {
  const names = new Set([...(contract.applicationEvents || []), ...(contract.pageViewEvent ? [contract.pageViewEvent] : [])]);
  return events.filter(event => names.has(event.name));
}

export function attributionAssertions(first, second, firstSource, secondSource) {
  return {
    firstTouchPreserved: !!firstSource && first?.first === firstSource && second?.first === firstSource,
    lastTouchUpdated: !!firstSource && !!secondSource && firstSource !== secondSource && first?.last === firstSource && second?.last === secondSource,
  };
}

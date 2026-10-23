// Synthetic GA4 fixture for clicktrail-verify. It never contacts Google: a
// minimal gtag/GTM stand-in sends v=2 collect hits to this server's
// first-party /g/collect path, and a minimal host app reads the GA session
// cookie for its checkout request. All IDs are synthetic constants.
(() => {
  const config = window.GA4_FIXTURE || {};
  const TID = 'G-TEST0001';
  const SESSION_COOKIE = '_ga_TEST0001';
  const SESSION_ID = '1700000001';
  const CLIENT_ID = '555000111.1700000001';
  const SYNTHETIC_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
  const CHECKOUT_URL = 'https://checkout.invalid/pay';
  const readCookie = (name) => document.cookie.split('; ').find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) || null;

  // --- Tag stand-in -------------------------------------------------------
  const tagSessionId = () => /\.s(\d+)\$/.exec(readCookie(SESSION_COOKIE) || '')?.[1] || '';
  function send(en, params = {}, transport = 'beacon') {
    const url = `/g/collect?${new URLSearchParams({ v: '2', tid: TID, gcs: 'G111', cid: CLIENT_ID, sid: tagSessionId(), en, ...params })}`;
    if (transport === 'beacon') navigator.sendBeacon(url);
    else fetch(url, { method: 'POST' });
  }
  function handle(item) {
    if (!item || typeof item.event !== 'string' || item.event.startsWith('gtm.')) return;
    const params = {};
    for (const [key, value] of Object.entries(item)) {
      if (['event', 'eventCallback', 'eventTimeout'].includes(key) || !['string', 'number'].includes(typeof value)) continue;
      // `sessionIdAsField` mimics a tag mapping session_id onto the GA4 session field.
      if (key === 'session_id' && config.sessionIdAsField) params.sid = String(value);
      else params[`ep.${key}`] = String(value); // catch-all event parameters
    }
    const fire = () => {
      send(item.event, params, config.lateTags ? 'fetch' : 'beacon');
      if (typeof item.eventCallback === 'function') item.eventCallback();
    };
    // `lateTags` mimics a tag that fires asynchronously after the push.
    if (config.lateTags) setTimeout(fire, 500); else fire();
  }
  function startTag() {
    if (!readCookie(SESSION_COOKIE)) {
      document.cookie = `_ga=GA1.1.${CLIENT_ID}; path=/`;
      document.cookie = `${SESSION_COOKIE}=GS2.1.s${SESSION_ID}$o1$g0$t${SESSION_ID}$j60$l0$h0; path=/`;
    }
    send('page_view');
    const dataLayer = window.dataLayer = window.dataLayer || [];
    const push = dataLayer.push.bind(dataLayer);
    dataLayer.push = (...items) => { const result = push(...items); items.forEach(handle); return result; };
  }

  // --- Host application stand-in -------------------------------------------
  function hostSessionId() {
    const value = readCookie(SESSION_COOKIE) || '';
    // `gs1OnlyParser` is the bug: GS2 values are split as if they were GS1.
    if (config.gs1OnlyParser) return value.split('.')[2] || null;
    return /^GS1\.\d+\.(\d+)\./.exec(value)?.[1] || /^GS2\.\d+\..*?\bs(\d+)(?:\$|$)/.exec(value)?.[1] || null;
  }
  function checkout() {
    fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ga_session_id: hostSessionId() }) }).catch(() => {});
    if (config.navigateWithoutCallback) {
      window.dataLayer.push({ event: 'begin_checkout' });
      location.assign(CHECKOUT_URL);
    } else {
      window.dataLayer.push({ event: 'begin_checkout', eventCallback: () => location.assign(CHECKOUT_URL), eventTimeout: 2000 });
    }
  }
  function start() {
    startTag();
    if (config.pushSessionId) window.dataLayer.push({ event: 'view_item', session_id: SYNTHETIC_UUID });
    if (config.pushPageView) window.dataLayer.push({ event: 'page_view' });
  }

  document.getElementById('accept').onclick = () => { localStorage.setItem('fixture:consent', 'granted'); start(); };
  document.getElementById('reject').onclick = () => localStorage.setItem('fixture:consent', 'denied');
  document.getElementById('pay').onclick = checkout;
  if (localStorage.getItem('fixture:consent') === 'granted') start();
})();

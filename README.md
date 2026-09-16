# ClickTrail Verify

> Local browser and source verification for consent-aware attribution handoffs.

ClickTrail Verify lets a developer point a deterministic runner at a codebase
and a staging URL. It inventories tracking code, runs isolated browser cases,
and writes a redacted machine-readable report. It does not submit forms, call
ad providers, write to a CRM, or upload source and browser data.

## Run

```sh
npm install
npx playwright install chromium
npx clicktrail-verify \
  --repo /path/to/project \
  --url "https://staging.example.com/?utm_source=test&utm_medium=cpc&gclid=synthetic" \
  --clicktrail-root /path/to/ClickTrail \
  --output .clicktrail/runs/latest
```

For a machine with an installed Chrome binary:

```sh
CLICKTRAIL_BROWSER_EXECUTABLE=/usr/bin/google-chrome npx clicktrail-verify \
  --repo . --url https://staging.example.com/
```
The runner keeps Chromium sandboxing enabled by default. Only use
`--allow-no-sandbox` (or `CLICKTRAIL_ALLOW_NO_SANDBOX=1`) inside an explicitly
isolated environment when the host cannot launch Chromium with its sandbox.


The current runner executes three isolated cases:

- no consent;
- denied consent;
- granted consent.

It records allowlisted event names and schema-presence flags, safe storage and cookie
names, redacted request metadata, response statuses, and error counts. Raw page titles,
console messages, page-error text, cookie values, and request paths are not written.
It also reports first/last-touch behavior when a second synthetic URL is passed
with `--second-url`.

## Project contracts

Defaults collect evidence without assuming a project's business events. Checks
that need an event contract report `UNKNOWN`, never a fabricated pass or a
missing client-specific event failure. This runner observes `window.dataLayer`;
other event buses require additional support and are not implicitly verified.

Pass `--contract /path/to/project-contract.json`:

```json
{
  "applicationEvents": ["page_view", "view_item_list"],
  "pageViewEvent": "page_view",
  "consent": { "acceptButton": "Accept all", "denyButton": "Reject all" },
  "collectors": [{ "path": "/api/metrics", "eventField": "event" }],
  "expectedApiEvents": ["page_view", "view_item_list"],
  "attribution": {
    "storageKey": "project:attribution",
    "firstTouchPath": "first.source",
    "lastTouchPath": "last.source"
  }
}
```

All fields are optional. Names must describe the page under test. `pageViewEvent`
implicitly joins `applicationEvents`. Consent labels are exact accessible button
names; without them, common labels are tried only when one matching button exists.
An absent or ambiguous CMP cannot produce a consent pass. A clicked button alone
is not proof: a positive granted application event is also required. Passing
covers only declared events, not every possible tracker.

Collectors are same-origin paths. Only a configured event field is summarized;
other request-body values are discarded. `expectedApiEvents` is the explicit
collector contract. Source regex matches remain inventory hints, not a complete
contract; unobserved endpoints produce `UNKNOWN`, not vacuous drift passes.

Attribution JSON paths use dot-separated keys in localStorage. Comparisons happen
in memory and only booleans are reported. With `--second-url`, supply distinct,
nonempty synthetic `utm_source` values. Missing page-view or attribution settings
leave the corresponding journey check `UNKNOWN`. No store or event prefix is
hardcoded for any client. See [VooAward example](examples/contracts/vooaward.json);
it intentionally does not assume a data-layer page-view event.

Report schema `0.3.0` adds a redacted `evidence` envelope. Each deterministic
finding includes references to observations in that envelope. Historical
reports under `examples/aferraria-2026-09-15` predate this behavior and are not
current generic-runner acceptance evidence. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the cross-repository flow and trust boundaries.

## ClickTrail repository mapping

Use `--clicktrail-root` when the ClickTrail source repositories are available
locally. The runner maps evidence to the narrowest relevant repository:

- JavaScript attribution and event contracts → `clicktrail-js`;
- WordPress, PHP, WooCommerce, and `_clicutcl_*` metadata → `click-trail-handler`;
- GTM and data-layer configuration → `gtm`;
- agent diagnostics → `clicktrail-mcp`;
- runnable fixtures → `clicktrail-examples`.

The map is stored in `config/repository-map.json`. Missing local repositories
are reported as `missing`; without `--clicktrail-root`, references are marked
`not-provided`. Generic host-application failures are not assigned to a
ClickTrail repository.

## Output

The report follows [`schemas/report.schema.json`](schemas/report.schema.json).
Use `--output` to select a directory. Reports contain no cookie values, event IDs, visitor IDs, emails, phone numbers,
headers, request bodies, or target query values. Target metadata keeps only the
origin, pathname, and query-key names.

## Evidence contract

The report is the factual handoff between Verify, MCP, and agent skills. The
`evidence` object is produced by Verify and contains redacted observations plus
`evidenceRefs` on every finding. It records what was observed, not what a
provider accepted. An optional TypeSafe advisor may consume the envelope for
routing and priority, but cannot change any finding status.

## Safety boundary

- Use staging or localhost by default.
- Use synthetic query values and identities.
- The runner never submits forms or clicks WhatsApp/phone conversion links.
- Provider delivery is not verified by a browser request alone.
- Add an explicit, reviewed adapter before testing a real form or conversion.
- AI diagnosis belongs above this runner; deterministic assertions decide pass,
  fail, warning, not-run, or unknown.

## Development

```sh
npm test
npm run typecheck
CLICKTRAIL_BROWSER_EXECUTABLE=/usr/bin/google-chrome node --test tests/browser.test.mjs
```

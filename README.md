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
  --output .clicktrail/runs/latest
```

For a machine with an installed Chrome binary:

```sh
CLICKTRAIL_BROWSER_EXECUTABLE=/usr/bin/google-chrome npx clicktrail-verify \
  --repo . --url https://staging.example.com/
```

The current runner executes three isolated cases:

- no consent;
- denied consent;
- granted consent.

It records event names and schema-presence flags, storage and cookie names,
redacted request metadata, response statuses, console errors, and page errors.
It also reports first/last-touch behavior when a second synthetic URL is passed
with `--second-url`.

## Output

The report follows [`schemas/report.schema.json`](schemas/report.schema.json).
Use `--output` to select a directory. Reports contain no cookie values, event
IDs, visitor IDs, emails, phone numbers, headers, or request bodies.

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
```

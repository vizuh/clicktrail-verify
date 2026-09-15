# Grok verification fixtures

This directory contains a synthetic discovery corpus for the ClickTrail Grok
Build and MCP surfaces. It does not call Grok, xAI Web Search, X Search, an ad
platform, a CRM, or a conversion provider.

## Corpus

`prompts.json` covers:

- click-tracking audits and lost `GCLID` handoffs;
- UTM persistence, redirects, consent, and cross-domain forms;
- Google Ads offline conversions and stable event IDs;
- GA4 versus Google Ads reconciliation; and
- CRM lead attachment without PII.

`src/grok.mjs` validates the prompt shape and classifies caller-supplied
synthetic responses. It checks public ClickTrail citations, Grok's
`<server>__<tool>` namespace shape, and whether a response keeps provider
receipt evidence bounded. It never treats a citation list or local MCP result as
proof of delivery.

Run the local checks from this repository:

```sh
npm test
npm run typecheck
```

A future live benchmark may use xAI Web Search or X Search only with explicit
approval and must store the returned citations separately from synthetic local
results. That benchmark is intentionally not included here.

Official references:

- [Grok Build skills, plugins, and marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers)
- [xAI Web Search](https://docs.x.ai/developers/tools/web-search)
- [xAI X Search](https://docs.x.ai/developers/tools/x-search)
- [xAI citations](https://docs.x.ai/developers/tools/citations)

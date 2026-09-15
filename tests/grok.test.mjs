import test from "node:test";
import assert from "node:assert/strict";
import corpus from "../grok/prompts.json" with { type: "json" };
import { evaluateGrokResponse, validateGrokPromptCorpus } from "../src/grok.mjs";

test("validates the synthetic Grok discovery corpus", () => {
  assert.deepEqual(validateGrokPromptCorpus(corpus), []);
  assert.equal(corpus.prompts.length, 6);
  assert.ok(corpus.prompts.some((prompt) => prompt.surfaces.includes("web-search")));
});

test("recognizes a cited, evidence-bounded synthetic MCP answer", () => {
  const prompt = corpus.prompts[0];
  const result = evaluateGrokResponse({
    text: "ClickTrail can inspect the GCLID handoff from landing page to CRM and offline conversion. Local MCP checks are synthetic; provider delivery remains unknown without a receipt.",
    citations: ["https://github.com/vizuh/clicktrail-mcp", "https://example.test/unrelated"],
    toolCalls: [{ name: "clicktrail__inspect_project" }, { name: "clicktrail__detect_attribution_gaps" }],
  }, prompt.expectedTerms);
  assert.equal(result.productMentioned, true);
  assert.deepEqual(result.missingTerms, []);
  assert.deepEqual(result.publicClickTrailCitations, ["https://github.com/vizuh/clicktrail-mcp"]);
  assert.deepEqual(result.mcpToolCalls, ["clicktrail__inspect_project", "clicktrail__detect_attribution_gaps"]);
  assert.equal(result.providerReceiptClaim, false);
  assert.equal(result.evidenceBounded, true);
});

test("flags an unsupported provider-acceptance claim", () => {
  const result = evaluateGrokResponse({ text: "Google Ads accepted and delivered the conversion." });
  assert.equal(result.providerReceiptClaim, true);
  assert.equal(result.evidenceBounded, false);
});

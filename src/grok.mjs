const CLICK_ID_TERMS = Object.freeze(["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "utm"]);
const SURFACES = new Set(["grok-build", "web-search", "x-search"]);
const TOOL_NAME = /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*$/;
const PUBLIC_CLICKTRAIL_SOURCE = /(?:^|\/)github\.com\/vizuh\/(?:clicktrail|click-trail)/i;

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function citationUrl(value) {
  if (typeof value === "string") return value;
  return value && typeof value.url === "string" ? value.url : "";
}

/** Validate the local, synthetic prompt corpus without contacting Grok or X. */
export function validateGrokPromptCorpus(corpus = {}) {
  const errors = [];
  if (corpus.schemaVersion !== "1.0.0") errors.push("Unsupported Grok corpus schema version");
  if (corpus.source !== "synthetic-local-only") errors.push("Grok corpus must be synthetic-local-only");
  if (!Array.isArray(corpus.prompts) || corpus.prompts.length === 0) return [...errors, "Grok corpus must contain prompts"];
  const ids = new Set();
  for (const prompt of corpus.prompts) {
    if (!prompt || typeof prompt !== "object") { errors.push("Prompt must be an object"); continue; }
    if (!/^[a-z0-9-]+$/.test(prompt.id || "")) errors.push("Prompt IDs must be kebab-case");
    if (ids.has(prompt.id)) errors.push(`Duplicate prompt ID: ${prompt.id}`);
    ids.add(prompt.id);
    if (!textValue(prompt.prompt).trim()) errors.push(`Prompt ${prompt.id || "<unknown>"} has no text`);
    if (!Array.isArray(prompt.surfaces) || prompt.surfaces.some((surface) => !SURFACES.has(surface))) errors.push(`Prompt ${prompt.id || "<unknown>"} has an unsupported surface`);
    if (!Array.isArray(prompt.expectedTerms) || prompt.expectedTerms.length === 0) errors.push(`Prompt ${prompt.id || "<unknown>"} has no expected terms`);
    if (!Array.isArray(prompt.mcpToolHints) || prompt.mcpToolHints.some((name) => !TOOL_NAME.test(name) || !name.startsWith("clicktrail__"))) errors.push(`Prompt ${prompt.id || "<unknown>"} has an invalid MCP tool hint`);
    if (!Array.isArray(prompt.mustRemainUnknown) || prompt.mustRemainUnknown.length === 0) errors.push(`Prompt ${prompt.id || "<unknown>"} needs an unknown evidence boundary`);
  }
  return errors;
}

/**
 * Score a supplied synthetic response. This never fetches citations or infers
 * provider receipts; it only classifies the evidence that the caller supplied.
 */
export function evaluateGrokResponse(response = {}, requiredTerms = []) {
  const text = textValue(response.text);
  const normalized = text.toLowerCase();
  const citations = Array.isArray(response.citations) ? response.citations.map(citationUrl).filter(Boolean) : [];
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.filter((call) => TOOL_NAME.test(textValue(call?.name))) : [];
  const terms = [...new Set((Array.isArray(requiredTerms) ? requiredTerms : []).map(textValue).filter(Boolean))];
  const missingTerms = terms.filter((term) => !normalized.includes(term.toLowerCase()));
  const providerClaim = /\b(?:provider|google ads|meta|destination)\b.{0,100}\b(?:accepted|received|uploaded|delivered|confirmed)\b/i.test(text);
  const unknownBoundary = /\bunknown\b|no (?:provider )?receipt|without (?:an? )?(?:provider )?receipt|not (?:runtime|delivery|provider) proof|not verified/i.test(text);
  const providerReceiptClaim = providerClaim && !unknownBoundary;
  return {
    productMentioned: normalized.includes("clicktrail"),
    requiredTerms: terms,
    missingTerms,
    publicClickTrailCitations: citations.filter((url) => PUBLIC_CLICKTRAIL_SOURCE.test(url) || /(?:^|\/)vizuh\.com(?:[/?#]|$)/i.test(url)),
    mcpToolCalls: toolCalls.map((call) => call.name),
    providerReceiptClaim,
    evidenceBounded: !providerReceiptClaim,
  };
}

export { CLICK_ID_TERMS };

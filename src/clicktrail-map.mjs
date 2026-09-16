import fs from "node:fs";
import path from "node:path";
import mapConfig from "../config/repository-map.json" with { type: "json" };

function normalized(text) { return String(text || "").toLowerCase(); }

export function resolveClickTrailMapping({ source, clicktrailRoot } = {}) {
  const findings = source?.findings && typeof source.findings === "object" ? source.findings : {};
  // Finding categories are evidence only when their file list is non-empty. In
  // particular, every inventory has a `gtm` key, so including all keys makes
  // every project look like it uses the GTM repository.
  const observedFindingNames = Object.entries(findings)
    .filter(([, files]) => Array.isArray(files) && files.length > 0)
    .map(([name]) => name);
  const content = [source?.content, source?.texts, source?.sourceText]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === "string");
  const haystack = normalized([
    ...(source?.filesInspected || []),
    ...observedFindingNames,
    ...Object.values(findings).flat(),
    ...(source?.eventTypes || []),
    ...content,
  ].join(" "));
  const explicitSurface = /clicktrail|@vizuh|_clicutcl|clicutcl/.test(haystack);
  const gtmEvidence = observedFindingNames.includes("gtm")
    || /googletagmanager|gtm\.js|\bGTM-[A-Z0-9]+\b/i.test(content.join(" "));
  const matches = mapConfig.repositories.filter((candidate) => {
    if (candidate.id === "gtm" && !gtmEvidence) return false;
    return candidate.triggers.some((trigger) => haystack.includes(normalized(trigger)));
  });
  const targets = matches.map((candidate) => {
    const localPath = clicktrailRoot ? path.resolve(clicktrailRoot, candidate.directory) : null;
    return {
      id: candidate.id,
      url: candidate.url,
      responsibility: candidate.responsibility,
      localPath,
      localStatus: localPath ? (fs.existsSync(localPath) ? "present" : "missing") : "not-provided",
      references: candidate.id === "clicktrail-js"
        ? ["docs/EVENT-CONTRACT.md", "packages/browser", "packages/next"]
        : candidate.id === "click-trail-handler"
          ? ["docs/MASTER-SPECIFICATION.md", "includes/integrations/class-woocommerce.php"]
          : candidate.id === "gtm"
            ? ["templates", "README.md"]
            : ["README.md"],
    };
  });
  return { targets, explicitSurface };
}

export function resolveClickTrailTargets(options = {}) {
  return resolveClickTrailMapping(options).targets;
}

export function annotateFindings(findings, targets, { explicitSurface = false } = {}) {
  return findings.map((finding) => {
    const hostOwned = finding.id === "PRECONSENT_PROVIDER_ACTIVITY" || finding.id === "SOURCE_RUNTIME_EVENT_DRIFT" || finding.id === "FORM_CONVERSION";
    const assigned = hostOwned || !explicitSurface ? [] : targets.map(({ id, url }) => ({ id, url }));
    return {
      ...finding,
      owner: assigned.length ? "clicktrail_repo_or_host_adapter" : "host_application",
      clicktrailTargets: assigned,
    };
  });
}

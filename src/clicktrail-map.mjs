import fs from "node:fs";
import path from "node:path";
import mapConfig from "../config/repository-map.json" with { type: "json" };

function normalized(text) { return String(text || "").toLowerCase(); }

export function resolveClickTrailMapping({ source, clicktrailRoot } = {}) {
  const haystack = normalized([
    ...(source?.filesInspected || []),
    ...Object.keys(source?.findings || {}),
    ...Object.values(source?.findings || {}).flat(),
    ...(source?.eventTypes || []),
  ].join(" "));
  const explicitSurface = /clicktrail|@vizuh|_clicutcl|clicutcl/.test(haystack);
  const matches = mapConfig.repositories.filter((candidate) =>
    candidate.triggers.some((trigger) => haystack.includes(normalized(trigger)))
  );
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

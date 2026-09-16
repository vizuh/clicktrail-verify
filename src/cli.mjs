#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateContract } from './contract.mjs';
import { inventorySource, runBrowserVerification, evaluate } from './runner.mjs';
import { resolveClickTrailMapping, annotateFindings } from './clicktrail-map.mjs';
import { buildEvidenceEnvelope, validateEvidenceEnvelope, targetUrl } from './evidence.mjs';

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2).replaceAll('-', '_');
    result[key] = argv[index + 1]?.startsWith('--') ? true : argv[index + 1] || true;
    if (result[key] !== true) index += 1;
  }
  return result;
}

function validateReportShape(report) {
  const errors = [];
  for (const key of ['schemaVersion', 'generatedAt', 'target', 'repo', 'source', 'browser', 'findings', 'evidence']) {
    if (!(key in report)) errors.push(`missing ${key}`);
  }
  try { new URL(report.target); } catch { errors.push('target must be a valid URL'); }
  if (!Array.isArray(report.findings)) errors.push('findings must be an array');
  if (!report.source || !Array.isArray(report.source.filesInspected) || !Array.isArray(report.source.eventTypes)) errors.push('source shape is invalid');
  if (!report.browser || !Array.isArray(report.browser.cases)) errors.push('browser shape is invalid');
  for (const finding of report.findings || []) {
    if (!finding || typeof finding.id !== 'string' || typeof finding.status !== 'string' || typeof finding.message !== 'string') errors.push('finding shape is invalid');
    if (finding && !['PASS', 'FAIL', 'NOT_RUN', 'WARN', 'UNKNOWN'].includes(finding.status)) errors.push(`invalid finding status: ${finding.status}`);
  }
  return errors;
}
const options = args(process.argv.slice(2));
if (!options.repo || !options.url) {
  console.error('Usage: clicktrail-verify --repo PATH --url URL [--contract FILE] [--second-url URL] [--clicktrail-root PATH] [--output DIR] [--executable-path PATH] [--allow-no-sandbox]');
  process.exit(2);
}
const contract = validateContract(options.contract ? JSON.parse(await fs.readFile(String(options.contract), 'utf8')) : {});
const repo = path.resolve(String(options.repo));
const output = path.resolve(String(options.output || '.clicktrail/runs/latest'));
await fs.mkdir(output, { recursive: true });
const source = await inventorySource(repo);
const clicktrailMapping = resolveClickTrailMapping({ repo, source, clicktrailRoot: options.clicktrail_root || process.env.CLICKTRAIL_ROOT });
const browser = await runBrowserVerification({ contract, url: String(options.url), secondUrl: options.second_url ? String(options.second_url) : undefined, executablePath: options.executable_path || process.env.CLICKTRAIL_BROWSER_EXECUTABLE, allowNoSandbox: options.allow_no_sandbox === true || process.env.CLICKTRAIL_ALLOW_NO_SANDBOX === '1' });
const findings = annotateFindings(evaluate(browser, source, contract), clicktrailMapping.targets, clicktrailMapping);
const safeTarget = targetUrl(options.url);
const evidence = buildEvidenceEnvelope({ target: String(options.url), repo, contract, source, browser, findings });
const report = { schemaVersion: '0.3.0', contract, generatedAt: new Date().toISOString(), target: safeTarget, repo, source, clicktrailTargets: clicktrailMapping.targets, clicktrailSurfaceDetected: clicktrailMapping.explicitSurface, browser, findings: evidence.findings, evidence };
const reportErrors = validateReportShape(report).concat(validateEvidenceEnvelope(evidence));
if (reportErrors.length) throw new Error(`Generated report failed schema checks: ${reportErrors.join('; ')}`);
await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, findings: report.findings.map(({ id, status }) => ({ id, status })), filesInspected: source.filesInspected.length }, null, 2));

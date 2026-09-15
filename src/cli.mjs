#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateContract } from './contract.mjs';
import { inventorySource, runBrowserVerification, evaluate } from './runner.mjs';
import { resolveClickTrailMapping, annotateFindings } from './clicktrail-map.mjs';

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
const options = args(process.argv.slice(2));
if (!options.repo || !options.url) {
  console.error('Usage: clicktrail-verify --repo PATH --url URL [--contract FILE] [--second-url URL] [--clicktrail-root PATH] [--output DIR] [--executable-path PATH]');
  process.exit(2);
}
const contract = validateContract(options.contract ? JSON.parse(await fs.readFile(String(options.contract), 'utf8')) : {});
const repo = path.resolve(String(options.repo));
const output = path.resolve(String(options.output || '.clicktrail/runs/latest'));
await fs.mkdir(output, { recursive: true });
const source = await inventorySource(repo);
const clicktrailMapping = resolveClickTrailMapping({ repo, source, clicktrailRoot: options.clicktrail_root || process.env.CLICKTRAIL_ROOT });
const browser = await runBrowserVerification({ contract, url: String(options.url), secondUrl: options.second_url ? String(options.second_url) : undefined, executablePath: options.executable_path || process.env.CLICKTRAIL_BROWSER_EXECUTABLE });
const report = { schemaVersion: '0.2.0', contract, generatedAt: new Date().toISOString(), target: String(options.url), repo, source, clicktrailTargets: clicktrailMapping.targets, clicktrailSurfaceDetected: clicktrailMapping.explicitSurface, browser, findings: annotateFindings(evaluate(browser, source, contract), clicktrailMapping.targets, clicktrailMapping) };
await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, findings: report.findings.map(({ id, status }) => ({ id, status })), filesInspected: source.filesInspected.length }, null, 2));

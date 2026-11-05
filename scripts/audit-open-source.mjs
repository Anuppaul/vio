// Offline source/community-file audit; no external network or GitHub Actions.
// PASS means "documentation structure is present", not legal/security clearance.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');
const expected = [
  'README.md', 'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'SECURITY.md', 'SUPPORT.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'docs/ASSET_LICENSING.md', 'docs/OPEN_SOURCE_RELEASE_CHECKLIST.md',
  'docs/assets/vio-hero.svg', 'docs/assets/vio-features.svg',
  'docs/assets/vio-architecture.svg', '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/PULL_REQUEST_TEMPLATE.md', '.editorconfig', '.gitattributes'
];
for(const path of expected){
  assert.ok((await stat(path)).size>30, 'Missing or empty community file: '+path);
}
const [license,readme,asset,workflow,pkg,notices] = await Promise.all([
  'LICENSE','README.md','docs/ASSET_LICENSING.md',
  '.github/workflows/android-apk.yml','package.json','THIRD_PARTY_NOTICES.md'
].map(read));
assert.match(license,/MIT License/);
assert.match(license,/Copyright \(c\) 2026 Anuppaul/);
assert.match(readme,/Created and maintained by \[Anuppaul\]/);
assert.match(readme,/Audio licensing notice/i);
assert.match(readme,/docs\/assets\/vio-hero\.svg/);
assert.match(asset,/NOT CLEARED/);
assert.match(asset,/external source|historical source|repository history/i);
assert.match(notices,/does not replace/);
assert.match(workflow,/on:\s*\n\s*workflow_dispatch:/);
assert.doesNotMatch(workflow,/^\s+push:\s*$/m);
assert.match(workflow,/vars\.VIO_ASSETS_CLEARED == 'true'/);
const metadata=JSON.parse(pkg);
assert.equal(metadata.author,'Anuppaul');
assert.equal(metadata.license,'MIT');
assert.equal(metadata.private,true,'Do not accidentally npm-publish uncleared media');
for(const name of ['vio-hero','vio-features','vio-architecture']){
  const svg=await read('docs/assets/'+name+'.svg');
  assert.match(svg,/<svg\s/);
  assert.match(svg,/<title/);
  assert.match(svg,/<desc/);
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b|(?:href|xlink:href)="https?:\/\//i);
}
console.log(JSON.stringify({
  sourceDocs:'PASS',
  filesChecked:expected.length,
  branding:'Anuppaul',
  codeLicense:'MIT',
  audioClearance:'BLOCKED — see docs/ASSET_LICENSING.md',
  dependencyAudit:'NOT VERIFIED — previous CI advisories remain',
  actions:'manual-only; public APK publication guarded',
  limitations:'No legal rights validation, APK build, or real-device test was run'
},null,2));

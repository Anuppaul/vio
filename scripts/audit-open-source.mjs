// Offline source/community-file audit; no external network or GitHub Actions.
// PASS means "documentation structure is present", not legal/security clearance.
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');
const expected = [
  'README.md', 'LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'SECURITY.md', 'SUPPORT.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'docs/ASSET_LICENSING.md', 'docs/OPEN_SOURCE_RELEASE_CHECKLIST.md',
  'docs/assets/vio-logo.svg',
  'docs/assets/vio-hero.svg', 'docs/assets/vio-hero-mobile.svg',
  'docs/assets/vio-features.svg', 'docs/assets/vio-features-mobile.svg',
  'docs/assets/vio-singing.svg', 'docs/assets/vio-singing-mobile.svg',
  'docs/assets/vio-architecture.svg', 'docs/assets/vio-architecture-mobile.svg',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/PULL_REQUEST_TEMPLATE.md', '.editorconfig', '.gitattributes'
];
for(const path of expected){
  assert.ok((await stat(path)).size>30, 'Missing or empty community file: '+path);
}
// Guard against accidentally removing playback media during documentation
// cleanup. These sample counts are required by the current offline app.
for(const [dir,extension,expected] of [
  ['tanpura','mp3',24], ['ear','mp3',34],
  ['exercise','wav',61], ['metronome','wav',8]
]){
  const names=await readdir('public/assets/'+dir);
  const actual=names.filter(name=>name.toLowerCase().endsWith('.'+extension)).length;
  assert.equal(actual,expected,'Offline audio missing from '+dir);
}
const capture=JSON.parse(await readFile('public/assets/tanpura/capture-manifest.json','utf8'));
assert.equal(capture.combinations?.length,24,'Tanpura capture provenance entries missing');
assert.ok(capture.provenanceHistoryCommit,'Historical source reference must remain traceable');

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
// Both responsive variants must render as standalone accessible, self-contained SVGs.
const images=['vio-logo','vio-hero','vio-hero-mobile','vio-features','vio-features-mobile',
  'vio-singing','vio-singing-mobile','vio-architecture','vio-architecture-mobile'];
for(const name of images){
  const svg=await read('docs/assets/'+name+'.svg');
  assert.match(svg,/<svg\s/);
  assert.match(svg,/<title/);
  assert.match(svg,/<desc/);
  assert.match(svg,/aria-labelledby=/);
  assert.match(svg,/viewBox="0 0 [0-9]+ [0-9]+"/);
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b|(?:href|xlink:href)="https?:\/\//i);
  assert.doesNotMatch(svg,/WondererTech|Spardha/i);
  if(name.includes('singing')||name.includes('features')||name.includes('hero')){
    assert.match(svg,/Sa/);
    assert.match(svg,/Re/);
    assert.match(svg,/Ga/);
    assert.match(svg,/Ma/);
  }
}
for(const name of images){
  const mobile=name.endsWith('-mobile');
  assert.match(readme,new RegExp('docs/assets/'+name+'\\.svg'),
    'README does not reference '+name);
  if(mobile)assert.match(readme,/<source media=/, 'Responsive SVG sources missing');
}
assert.match(readme,/src="\.\/docs\/assets\/vio-logo\.svg"/);
assert.doesNotMatch(readme,/raw\.githubusercontent\.com\/Anuppaul\/vio\/main\/public\/icons/);
assert.match(readme,/Singing special · Sa Re Ga Ma/);
assert.match(readme,/±5 cents/);

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

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const desktopSmoke=process.env.VIO_DESKTOP_SMOKE==='1';
const root=resolve('out');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.wav':'audio/wav','.mp3':'audio/mpeg','.txt':'text/plain'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=resolve(root,`.${pathname==='/'?'/index.html':pathname}`);
    if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end('Not found')}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
await mkdir('release/test-results',{recursive:true});
// A known pure tone tests the untouched raw microphone detector in Chromium.
const rate=48000,samples=rate*20,wav=Buffer.alloc(44+samples*2);
wav.write('RIFF',0);wav.writeUInt32LE(36+samples*2,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*12000),44+i*2);
await writeFile('release/test-results/a4-input.wav',wav);
const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',`--use-file-for-fake-audio-capture=${resolve('release/test-results/a4-input.wav')}`]});
const context=await browser.newContext({viewport:{width:390,height:844},permissions:['microphone']});
const errors=[],external=[],missing=[];
const page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.status()>=400)missing.push(`${response.status()} ${response.url()}`)});
await context.route('**/*',route=>{
  const url=route.request().url();
  if(url.startsWith(origin)||url.startsWith('data:')||url.startsWith('blob:'))return route.continue();
  external.push(url);return route.abort();
});
try{
  await page.goto(`${origin}/index.html`);await page.waitForSelector('nav');
  const labels=['Sound Tuner','Scale Practice','Tanpura','Exercise','Metronome','Ear Tuner'];
  for(const label of labels){
    await page.locator('.nav-items a').filter({hasText:label}).click();
    await page.waitForLoadState('load');
    assert.match(page.url(),/\.html$/,`${label} should be a local HTML document`);
    assert.equal(await page.locator('html.vio-native').count(),1);
    assert.equal(await page.locator('.nav-items a.active').count(),1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${label} overflows mobile viewport`);
  }
  await page.goto(`${origin}/metronome.html`);
  await page.getByRole('button',{name:/Larghissimo/}).click();
  assert.equal(await page.locator('.bpm-input').inputValue(),'20');
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.goto(`${origin}/tanpura.html`);
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.getByText(/Gapless Hall/).waitFor({timeout:20000});
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.goto(`${origin}/sound-tuner.html`);
  await page.getByRole('button',{name:'Start tuning',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.detected-note')?.textContent==='A4',{},{timeout:15000});
  await page.screenshot({path:'release/test-results/raw-tuner-mobile.png'});
  await page.getByRole('button',{name:'Stop microphone',exact:true}).click();
  await page.goto(`${origin}/scale-practice.html`);
  await page.getByRole('button',{name:'Start microphone',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.scale-practice-side button.sa-ready-button')?.hasAttribute('disabled') && !!document.querySelector('.scale-practice-side button.sa-ready-button'),{},{timeout:15000});
  await page.getByRole('button',{name:'Set current pitch as Sa',exact:true}).click();
  await page.locator('.swara-cell').nth(14).click();
  await page.getByRole('button',{name:'Stop microphone',exact:true}).click();
  assert.equal(await page.evaluate(async()=> (await navigator.serviceWorker.getRegistrations()).length),0,'Native export must not register a service worker');
  await page.screenshot({path:'release/test-results/scale-practice-mobile.png'});
  assert.deepEqual(errors,[],'Uncaught browser errors');assert.deepEqual(external,[],'External network dependencies');assert.deepEqual(missing,[],'Missing bundled assets');
  const report={platform:desktopSmoke?'desktop':'android',passed:true,checks:['six local HTML routes','390px mobile layout','tempo preset and start/stop','real bundled tanpura decoding','raw 440Hz microphone -> A4','Sa setup and swara reference playback','no native service worker','no external network dependencies','no page errors or missing assets'],limitations:desktopSmoke?['Chromium synthetic microphone only, not Tauri WebView2 or WebKitGTK','Physical-device microphone, permissions, audio routing and install/offline acceptance are required']:['Synthetic browser microphone, not a physical Android microphone','Android airplane mode and background audio require on-device acceptance']};
  await writeFile(`release/test-results/${desktopSmoke?'desktop-web-smoke':'web-smoke'}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(`${desktopSmoke?'Desktop':'Android'} static export Chromium smoke tests PASS`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}

import { launchBrowser } from './browser.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const image = await readFile('tests/fixtures/demo.png');
await mkdir('test-results/overlay', { recursive: true });
const server = await createServer({server:{host:'127.0.0.1',port:1427,strictPort:true}}); await server.listen();
const browser = await launchBrowser();
try {
 for(const background of ['desktop','#080b10','#ffffff']) {
  const page=await browser.newPage({viewport:{width:1365,height:768},colorScheme:'dark',reducedMotion:'reduce'});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  if(background==='desktop')await page.route('**/fixture.jpg',route=>route.fulfill({contentType:'image/png',headers:{'Access-Control-Allow-Origin':'*'},body:image}));
  await page.addInitScript(({background})=>{
   window.isTauri=true; let cb=0;window.__calls=[];
   const canvas=document.createElement('canvas');canvas.width=1365;canvas.height=768;const ctx=canvas.getContext('2d');ctx.fillStyle=background==='desktop'?'black':background;ctx.fillRect(0,0,1365,768);
   window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'selector-1'},currentWebview:{label:'selector-1'}},convertFileSrc:path=>path,transformCallback:()=>++cb,invoke:async(command,args)=>{
    window.__calls.push({command,args});
    if(command==='selector_info')return{screenshotPath:background==='desktop'?'http://asset.localhost/fixture.jpg':canvas.toDataURL(),width:1365,height:768};
    if(command==='plugin:event|listen')return++cb;
    if(command==='window_ready') { if(!document.querySelector('.frozen-screen').complete)throw Error('Selection shown before frozen image decode'); return; }
    if(command==='select_region'||command.startsWith('plugin:event|'))return;
    throw Error(command);
   }};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  },{background});
  await page.goto('http://127.0.0.1:1427/?view=selector');
  await page.waitForFunction(()=>document.querySelector('.selection-hint')?.classList.contains('glass-rendered'));
  await page.waitForFunction(()=>window.__calls.some(c=>c.command==='window_ready'));
  const material=await page.locator('.glass-material').evaluate(canvas=>{const {width,height}=canvas;const pixels=canvas.getContext('2d').getImageData(Math.floor(width/2),Math.floor(height/2),1,1).data;return [...pixels];});
  assert.equal(material[3],255);
  const luma=(material[0]*.2126+material[1]*.7152+material[2]*.0722)/255;
  assert.ok(luma>=.17&&luma<=.43,`Readable visible glass on ${background}: ${material}`);
  await page.screenshot({path:'test-results/overlay/selection-'+(background==='desktop'?'desktop':background==='#ffffff'?'white':'dark')+'.png'});
  assert.match(await page.locator('.selection-screen').evaluate(el=>getComputedStyle(el).cursor),/capture-cursor/);
  if(background==='desktop') {
    await page.mouse.move(300,300); await page.mouse.down(); await page.mouse.move(500,450);
    assert.equal(await page.locator('.selection-screen').evaluate(el=>getComputedStyle(el).cursor),'crosshair');
    await page.locator('.selection-screen').dispatchEvent('pointercancel'); await page.mouse.up();
    assert.match(await page.locator('.selection-screen').evaluate(el=>getComputedStyle(el).cursor),/capture-cursor/);
  }
  await page.mouse.click(800,450);
  await page.waitForFunction(()=>window.__calls.some(c=>c.command==='select_region'));
  assert.deepEqual(await page.evaluate(()=>window.__calls.find(c=>c.command==='select_region').args.selection),{x1:0,y1:0,x2:1365,y2:768,viewportWidth:1365,viewportHeight:768});
  assert.equal(await page.locator('.selection-screen').evaluate(el=>el.classList.contains('capture-held')),true,'The selected screenshot stays held during the recorder handoff');
  assert.equal(await page.locator('#selection-size').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  assert.deepEqual(errors,[]);console.log('PASS selection glass and full-screen tap',background,material);await page.close();
 }
}finally{await browser.close();await server.close();}

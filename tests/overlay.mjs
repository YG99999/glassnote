import { launchBrowser } from './browser.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const image = await readFile('tests/fixtures/demo.png');
await mkdir('test-results/overlay', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 1426, strictPort: true } }); await server.listen();
const browser = await launchBrowser();
try {
 for (const region of [[.03,.12,.53,.67],[.4,.02,.56,.6],[0,0,1,1]]) {
  const motion = region[0]===.03 ? 'no-preference' : 'reduce';
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 }, reducedMotion: motion, colorScheme: 'dark' });
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000); const errors = []; page.on('pageerror', e => { errors.push(e.message);console.error('PAGE ERROR',e.stack); });
  await page.route('**/fixture.jpg*', route => route.fulfill({ contentType:'image/png', headers:{'Access-Control-Allow-Origin':'*'}, body:image }));
  const cropped = await page.evaluate(async ({data,region}) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width*region[2]); canvas.height = Math.round(img.height*region[3]);
    canvas.getContext('2d').drawImage(img,img.width*region[0],img.height*region[1],canvas.width,canvas.height,0,0,canvas.width,canvas.height);
    return canvas.toDataURL().split(',')[1];
  },{data:image.toString('base64'),region});
  await page.route('**/crop.png', route => route.fulfill({contentType:'image/png',headers:{'Access-Control-Allow-Origin':'*'},body:Buffer.from(cropped,'base64')}));
  const cdp=await page.context().newCDPSession(page); await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-reduced-motion',value:motion}]});
  await page.addInitScript(({region}) => {
    const nativeDraw=WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays=function(...args){window.__glassDraws=(window.__glassDraws||0)+1;return nativeDraw.apply(this,args);};
    window.isTauri = true;
    const capture = { id:'7bc50320-4508-4ff8-ae6c-cda518db40bc',projectId:'00000000-0000-0000-0000-000000000000',createdAt:'2026-10-20T22:25:57Z',width:1920,height:1080,draft:true,status:'ready',error:null,transcript:'An earlier thought.',screenshotPath:'crop.png',originalPath:'crop.png',audioPath:null,audioSeconds:0,annotations:[] };
    const snapshot={projects:[{id:capture.projectId,name:'Inbox',createdAt:capture.createdAt}],captures:[capture],settings:{activeProjectId:capture.projectId,shortcut:'Ctrl+Alt+S'},modelReady:true,modelDownloading:false,transparency:false,activeCaptureId:capture.id,warnings:[],shortcutError:null};
    const callbacks=new Map(), listeners=new Map(); let next=0;
    const emit=(name,payload)=>{for(const cb of listeners.get(name)||[]) callbacks.get(cb)?.({event:name,id:cb,payload});};
    window.__capture=capture; window.__snapshot=snapshot; window.__calls=[]; window.__emit=emit;
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'recorder'},currentWebview:{label:'recorder'}},convertFileSrc:path=>'http://asset.localhost/'+path,transformCallback:fn=>{callbacks.set(++next,fn);return next;},invoke:async(command,args)=>{
      window.__calls.push({command,args});
      if(command==='snapshot')return structuredClone(snapshot);
      if(command==='overlay_info')return{backgroundPath:'fixture.jpg',width:1365,height:768,region};
      if(command==='overlay_ready'){
        if(!document.querySelector('#frozenDesktop').complete||!document.querySelector('#captureImage').complete)throw Error('A screenshot window was shown before image decode');
        if(!document.documentElement.dataset.glassRenderer&&getComputedStyle(document.querySelector('#recorder')).backdropFilter==='none')throw Error('A screenshot window was shown without a usable glass material');
        if(getComputedStyle(document.querySelector('.recorder-anchor')).transitionDuration!=='0s')throw Error('Initial docking should not animate while the window is being prepared');
        return;
      }
      if(command==='overlay_presented'){
        if(!window.__calls.some(c=>c.command==='overlay_ready'))throw Error('Selection released before recorder ready');
        return;
      }
      if(command==='window_ready'||command==='shelve_capture'||command==='open_library')return;
      if(command==='save_transcript'){if(window.__saveFails)throw'Disk full (verification)';capture.transcript=args.text;return;}
      if(command==='save_annotations'){if(window.__saveFails)throw'Disk full (verification)';capture.annotations=args.items;if(!args.image.startsWith('iVBOR'))throw'Expected flattened PNG';return;}
      if(command==='create_project'){if(!args.parentId&&!args.name.trim())throw'Enter a project name';const p={id:snapshot.projects.length===1?'87f5be98-0025-4fb9-a51f-01e267f2667c':'a9876543-1234-4567-8910-123456789012',name:args.parentId?String(snapshot.projects.filter(p=>p.parentId===args.parentId).length):args.name,parentId:args.parentId || null,createdAt:capture.createdAt};snapshot.projects.push(p);emit('library-changed',{});return p;}
      if(command==='start_recording'){capture.recordingTarget=args.annotationId ?? null;capture.status='recording';emit('library-changed',{});return;}
      if(command==='stop_recording'){capture.status='transcribing';emit('library-changed',{});setTimeout(()=>{capture.status='ready';if(capture.recordingTarget){capture.annotations.find(a=>a.id===capture.recordingTarget).text+='\n\nAn additional thought.';}else{capture.transcript+='\n\nAn additional thought.';}capture.audioSeconds+=3;capture.audioPath='fixture.wav';emit('transcription-complete',{captureId:capture.id});},150);return;}
      if(command==='finish_capture'){capture.draft=false;capture.projectId=args.projectId;capture.transcript=args.text;return;}
      if(command==='plugin:event|listen'){listeners.set(args.event,[...(listeners.get(args.event)||[]),args.handler]);return++next;}
      if(command.startsWith('plugin:event|'))return;
      throw Error('Unexpected command '+command);
    }};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  }, {region});
  await page.goto('http://127.0.0.1:1426/?view=recorder');
  const checkGlass = async () => page.waitForFunction(() => [...document.querySelectorAll('.glass')].filter(el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).every(el => el.classList.contains('glass-rendered') && el.querySelector('.glass-material:not([hidden])')));
  await page.waitForFunction(()=>window.__calls.some(c=>c.command==='overlay_ready'),null,{timeout:15000}).catch(async e=>{console.log(await page.locator('body').innerText());throw e;}); console.log('Overlay ready');
  await page.waitForFunction(()=>window.__calls.some(c=>c.command==='overlay_presented')&&!document.body.classList.contains('overlay-entering'));
  const before=await page.locator('#capture').boundingBox();
  assert.equal(await page.locator('#toggleNotes, .notes-column, #notesPeek').count(),0);
  await page.waitForFunction(()=>document.documentElement.dataset.glassRenderer==='egui-glass-shader-port');
  await checkGlass();
  if(region[0]===.03){await page.waitForTimeout(1100);const draws=await page.evaluate(()=>window.__glassDraws);assert.ok(draws>0);await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.__glassDraws),draws,'Glass must stop drawing while idle');console.log('PASS shader idle: no continuous draws');}
  await page.locator('#projectToggle').click(); await page.locator('#newProject').click();
  await checkGlass();
  await page.locator('#newProjectName').fill('Review'); await page.getByRole('button',{name:'Create',exact:true}).click();
  await page.locator('#projectName').filter({hasText:'Review'}).waitFor();
  assert.equal(await page.locator('#projectMenu').isVisible(),false);
  await page.locator('#projectToggle').click(); await page.locator('#newSubproject').click();
  assert.equal(await page.locator('#newProjectForm').isVisible(),false,'A subfolder is created without a name field');
  await page.waitForFunction(()=>document.querySelector('#projectName').textContent==='Review / 0');
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.command==='create_project').at(-1).args.parentId),'87f5be98-0025-4fb9-a51f-01e267f2667c');
  await page.locator('#projectToggle').click();
  assert.equal(await page.locator('#newSubproject').isVisible(),false,'A subfolder cannot create another subfolder');
  const fold=page.locator('#projectOptions [data-collapse-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]');
  await fold.click();
  await page.waitForFunction(()=>document.querySelector('#projectOptions .project-tree-children').getBoundingClientRect().height<1);
  assert.equal(await page.locator('#projectName').innerText(),'Review / 0','Collapsing must not change the selected destination');
  assert.equal(await page.locator('#projectOptions .project-tree-children').evaluate(el=>el.inert),true);
  assert.ok(await page.evaluate(()=>JSON.parse(localStorage.getItem('glassnote.collapsedProjects')).includes('87f5be98-0025-4fb9-a51f-01e267f2667c')),'Collapsed projects should be remembered');
  await page.evaluate(()=>window.__emit('library-changed',{})); await page.waitForTimeout(150);
  assert.equal(await fold.getAttribute('aria-expanded'),'false','Refresh must not expand a collapsed project');
  await fold.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#projectOptions .project-tree-children').getBoundingClientRect().height>20);
  await page.locator('#projectToggle').click();

  if(region[0]===.03) {
    await page.locator('#projectToggle').click();
    await page.evaluate(()=>{
      for(let i=0;i<30;i++)window.__snapshot.projects.push({id:`c1234567-1234-4567-8910-${String(i).padStart(12,'0')}`,name:`Project ${i}`,createdAt:window.__capture.createdAt});
      window.__emit('library-changed',{});
    });
    await page.waitForFunction(()=>document.querySelectorAll('#projectOptions [data-overlay-project]').length===33);
    await page.locator('#projectOptions').evaluate(el=>{el.scrollTop=170;window.__menuScroll=el.scrollTop;window.__menuButton=el.firstChild;});
    await page.evaluate(()=>window.__emit('library-changed',{})); await page.waitForTimeout(150);
    assert.deepEqual(await page.locator('#projectOptions').evaluate(el=>[el.scrollTop===window.__menuScroll,el.firstChild===window.__menuButton]),[true,true],'Folder refresh must preserve the menu DOM and scroll');
    await page.locator('#projectToggle').click();
    await page.evaluate(()=>{window.__snapshot.projects=window.__snapshot.projects.slice(0,3);window.__emit('library-changed',{});});
    await page.waitForFunction(()=>document.querySelectorAll('#projectOptions [data-overlay-project]').length===3);
    console.log('PASS stable project picker and scrolling');
  }
  await page.locator('#projectToggle').click(); await page.locator('[data-overlay-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]').click();

  await page.locator('#projectToggle').click();
  await page.locator('[data-overlay-project="00000000-0000-0000-0000-000000000000"]').click();
  assert.equal(await page.locator('#projectName').innerText(),'Inbox');
  await page.locator('#projectToggle').click();
  await page.locator('[data-overlay-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]').click();
  await page.locator('#colorToggle').click();
  await page.locator('[data-color="#f8fafc"]').click();
  await page.getByRole('button',{name:'Numbered note',exact:true}).click();
  await page.mouse.click(before.x+before.width*.4,before.y+before.height*.5);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'pinEditorInput','A new pin should focus its inline note');
  await checkGlass();
  const markerContrast = await page.locator('.annotation-pin').evaluate(el => {
    const toRgb = color => color.match(/\d+/g).slice(0,3).map(Number).map(n => n/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    const luminance = color => toRgb(color).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const a=luminance(getComputedStyle(el.querySelector('text')).fill), b=luminance(getComputedStyle(el.querySelector('ellipse')).fill);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert.ok(markerContrast>=4.5,'A white marker must keep its number readable');
  if(region[0]===.03) await page.screenshot({path:'test-results/overlay/glass-note-editor.png'});
  await page.locator('#pinEditorInput').fill('Make this easier to find.'); await page.locator('#savePinNote').click();
  assert.equal(await page.locator('#pinEditor').isVisible(),false);
  await page.getByRole('button',{name:/^Note 1:/}).click();
  assert.equal(await page.locator('#pinEditorInput').inputValue(),'Make this easier to find.');
  if (process.env.GLASSNOTE_SCREENSHOTS === '1' && region[0]===.03) {
    await page.locator('#pinEditorInput').fill('Keep the current project visible.');
    await page.locator('#toggleCaption').click();
    await page.locator('#captionText').fill('Keep the current project visible. Tuck the details away until they are needed.');
    await page.waitForTimeout(600);
    await checkGlass();
    await page.screenshot({path:'docs/images/capture.png'});
    await page.locator('#captionText').fill('An earlier thought.'); await page.keyboard.press('Control+s');
    await page.locator('#toggleCaption').click();
    await page.locator('#pinEditorInput').fill('Make this easier to find.');
  }
  await page.locator('#pinEditorInput').evaluate(el=>{el.setSelectionRange(2,9);window.__emit('library-changed',{});});
  await page.waitForTimeout(150);
  assert.deepEqual(await page.locator('#pinEditorInput').evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,9],'Refresh preserves inline-note selection');

  await page.locator('#recordPinNote').click();
  await page.waitForFunction(()=>window.__capture.status==='recording');
  await page.evaluate(()=>window.__emit('transcript-partial',{captureId:window.__capture.id,annotationId:window.__capture.annotations[0].id,text:'Live pin words'}));
  assert.match(await page.locator('#pinEditorInput').inputValue(),/Make this easier to find[\s\S]*Live pin words/);
  assert.equal(await page.locator('#captionText').inputValue(),'An earlier thought.','Pin dictation must not replace the general transcript');
  await page.evaluate(()=>window.__emit('audio-level',{captureId:window.__capture.id,level:.4,elapsed:2}));
  assert.equal(await page.locator('#pinVoiceTime').innerText(),'0:02');
  await page.locator('#recordPinNote').click();
  await page.waitForFunction(()=>document.querySelector('#pinEditorInput').value.includes('An additional thought.'));
  await page.locator('#pinEditorInput').fill('Make this easier to find.'); await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>window.__capture.annotations[0].text==='Make this easier to find.');
  await page.locator('#closePinEditor').click();
  await page.locator('#toggleCaption').click(); await page.locator('#captionText').fill('Edited under the recorder.');
  await page.keyboard.press('Control+s'); await page.getByText('Saved',{exact:true}).waitFor({state:'attached'});
  if(region[0]===.03) {
    await page.locator('#captionText').fill(Array.from({length:30},(_,i)=>`Line ${i}: a longer transcript that needs scrolling.`).join('\n'));
    await page.keyboard.press('Control+s'); await page.waitForTimeout(350);
    await page.locator('#captionText').evaluate(el=>{
      el.focus();el.scrollTop=110;el.setSelectionRange(92,118);
      window.__editNode=el;window.__editBounds=JSON.stringify(el.getBoundingClientRect().toJSON());window.__editScroll=el.scrollTop;window.__heightChanges=0;
      window.__editObserver=new MutationObserver(records=>{window.__heightChanges+=records.length;});window.__editObserver.observe(el,{attributes:true,attributeFilter:['style']});
    });
    for(let i=0;i<10;i++) { await page.evaluate(()=>window.__emit('library-changed',{})); await page.waitForTimeout(35); }
    assert.deepEqual(await page.locator('#captionText').evaluate(el=>[el===window.__editNode,el.selectionStart,el.selectionEnd,el.scrollTop===window.__editScroll,JSON.stringify(el.getBoundingClientRect().toJSON())===window.__editBounds,window.__heightChanges]),[true,92,118,true,true,0],'Transcript selection, scroll, size and DOM must stay stable across refreshes');
    await page.locator('#captionText').dblclick();
    const selection=await page.locator('#captionText').evaluate(el=>[el.selectionStart,el.selectionEnd]);
    await page.evaluate(()=>window.__emit('library-changed',{})); await page.waitForTimeout(150);
    assert.deepEqual(await page.locator('#captionText').evaluate(el=>[el.selectionStart,el.selectionEnd]),selection,'A mouse text selection must survive refresh');
    await page.locator('#captionText').fill('Edited under the recorder.'); await page.keyboard.press('Control+s');
    console.log('PASS transcript and numbered-note selection remain stable');
  }
  await page.locator('#recordButton').click();
  await page.waitForFunction(()=>window.__capture.status==='recording');
  await page.evaluate(()=>window.__emit('transcript-partial',{captureId:window.__capture.id,text:'Live words'}));
  assert.match(await page.locator('#captionText').inputValue(),/Edited under the recorder[\s\S]*Live words/);
  await page.locator('#recordButton').click();
  await page.waitForFunction(()=>window.__capture.status==='ready');
  await page.waitForFunction(()=>document.querySelector('#captionText').value.includes('An additional thought.'));
  assert.equal(await page.locator('audio, #playButton').count(),0,'Capture has no audio playback UI');
  await page.locator('#captionText').fill('A final edit.'); await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>window.__capture.transcript==='A final edit.');
  await page.locator('#moreToggle').click(); await page.locator('#glassToggle').click();
  await page.waitForFunction(()=>document.documentElement.dataset.glassRenderer==='css');
  await page.locator('#glassToggle').click();
  await page.waitForFunction(()=>document.documentElement.dataset.glassRenderer==='egui-glass-shader-port');
  await checkGlass();
  await page.locator('#moreToggle').click();
  await page.locator('#colorToggle').click(); await checkGlass(); await page.locator('#colorToggle').click();
  await page.locator('#moveRecorder').click(); await page.locator('#moveTools').click(); await page.locator('#moveFooter').click();
  assert.deepEqual(await page.locator('#capture').boundingBox(),before,'Chrome must not move the screenshot');
  await page.locator('#projectToggle').click();
  const menuBox=await page.locator('#projectMenu').boundingBox();
  assert.ok(menuBox.y>=0 && menuBox.y+menuBox.height<=768,'Project menu must fit on screen');
  await page.screenshot({path:'test-results/overlay/overlay-'+region[0]+'.png'});
  await page.locator('#projectToggle').click();
  await page.evaluate(()=>window.__saveFails=true);
  await page.locator('#captionText').fill('Keep this failed edit.');
  await page.getByText('Not saved · press Ctrl+S to retry').waitFor();
  assert.equal(await page.locator('#captionText').inputValue(),'Keep this failed edit.');
  await page.evaluate(()=>window.__saveFails=false); await page.keyboard.press('Control+s');
  await page.waitForFunction(()=>window.__capture.transcript==='Keep this failed edit.');
  await page.locator('#saveButton').click(); await page.getByText('Saved to Review',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.__calls.some(c=>c.command==='shelve_capture'));
  assert.equal(await page.evaluate(()=>document.body.classList.contains('overlay-leaving')),true,'The frozen screen fades before the native window closes');
  assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.command==='open_library')),false);
  assert.equal(await page.evaluate(()=>window.__capture.annotations[0].text),'Make this easier to find.');
  assert.deepEqual(errors,[]);
  console.log('PASS production overlay',region); await page.close();
 }
}finally{await browser.close();await server.close();}

// Browser-only visual checks of the real interface. IPC is mocked; native flows are tested separately.
import { launchBrowser } from './browser.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const screenshot = await readFile('tests/fixtures/demo.png');
await mkdir('test-results/library', { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 1422, strictPort: true } });
await server.listen();
const browser = await launchBrowser();
try {
  for (const theme of ['light', 'dark']) {
    for (const view of ['library']) {
      const page = await browser.newPage({ viewport: view === 'library' ? { width: 1160, height: 800 } : { width: 440, height: 590 }, colorScheme: theme, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/fixture.png', route => route.fulfill({ contentType: 'image/png', body: screenshot }));
      await page.addInitScript(({ view }) => {
        window.isTauri = true;
        const capture = { id: '7bc50320-4508-4ff8-ae6c-cda518db40bc', projectId: '87f5be98-0025-4fb9-a51f-01e267f2667c', createdAt: '2026-10-20T22:25:57.771Z', width: 773, height: 344, draft: false, status: 'ready', error: null, transcript: 'Keep the current project visible. Make switching destinations feel quick, and tuck the extra controls away until they are needed.', screenshotPath: 'fixture.png', audioPath: 'fixture.wav',originalPath:'fixture.png',audioSeconds:0,annotations:[{id:1,type:'pin',color:'#3b73e0',x:400,y:200,x2:0,y2:0,points:[],text:'Keep this aligned.'}] };
        window.__fixtureCapture = capture;
        const snapshot = { projects: [{ id: '00000000-0000-0000-0000-000000000000', name: 'Inbox', createdAt: capture.createdAt }, { id: capture.projectId, name: 'Design notes', createdAt: capture.createdAt }], captures: [capture], settings: { activeProjectId: capture.projectId, shortcut: 'Ctrl+Alt+S' }, modelReady: true, modelDownloading: false, transparency: true, activeCaptureId: capture.id, warnings: [], shortcutError: null };
        window.__snapshot=snapshot; window.__calls=[];
        let callback = 0;
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: view === 'library' ? 'main' : 'recorder' }, currentWebview: { label: view === 'library' ? 'main' : 'recorder' } },
          transformCallback: () => ++callback,
          convertFileSrc: path => '/' + path,
          invoke: async (command, args) => {
            window.__calls.push({command,args});
            if(command==='create_project'){const p={id:'b1234567-1234-4567-8910-123456789012',name:args.parentId?String(snapshot.projects.filter(p=>p.parentId===args.parentId).length):args.name,parentId:args.parentId,createdAt:capture.createdAt};snapshot.projects.push(p);return p;}
            if(command==='choose_project'){snapshot.settings.activeProjectId=args.id;return;}
            if(command==='move_capture'){snapshot.captures.find(c=>c.id===args.id).projectId=args.projectId;return;}
            if(command==='copy_project_path')return'C:/shared/current';
            if(command==='export_project_zip')return'C:/exports/Folder.zip';
            if(command==='delete_project'){snapshot.projects=snapshot.projects.filter(p=>p.id!==args.id);return;}

            if (command === 'window_ready') { window.__ready = true; return; }
            if (command === 'snapshot') return structuredClone(snapshot);
            if (command === 'save_transcript') { if(window.__saveFails) throw 'Disk is full (verification)'; capture.transcript = args.text; return; }
            if (command === 'plugin:window|on_close_requested') return;
            if (command === 'plugin:event|listen') return ++callback;
            if (command.startsWith('plugin:event|')) return;
            throw Error('Unexpected mock command: ' + command);
          },
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      }, { view });
      await page.goto('http://127.0.0.1:1422/?view=' + view);
      await page.locator(view === 'library' ? '#transcript' : '#recorder-transcript').waitFor();
      await page.locator('img[alt="' + (view === 'library' ? 'Captured screenshot' : 'Selected screenshot') + '"]').evaluate(el => el.decode());
      await page.waitForFunction(() => window.__ready && !document.body.classList.contains('app-entering'));
      if(await page.locator('audio').count())throw Error('Library must not show audio playback');
      await page.screenshot({ path: `test-results/library/${view}-${theme}.png` });
      if (process.env.GLASSNOTE_SCREENSHOTS === '1') await page.screenshot({path: `docs/images/library-${theme}.png`});
      if (view === 'library') {
        await page.setViewportSize({ width: 740, height: 560 });
        await page.screenshot({ path: `test-results/library/library-narrow-${theme}.png` });
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Horizontal overflow at minimum width');
        await page.evaluate(() => window.__saveFails = true);
        await page.locator('#transcript').fill('An unsaved edit must survive a disk error.');
        await page.getByText('Not saved', { exact: true }).waitFor();
        if(await page.locator('#transcript').inputValue() !== 'An unsaved edit must survive a disk error.') throw Error('Lost failed edit');
        await page.evaluate(() => window.__saveFails = false);
        await page.keyboard.press('Control+s');
        await page.getByText('Saved', { exact: true }).waitFor();
        if(await page.evaluate(() => window.__fixtureCapture.transcript) !== 'An unsaved edit must survive a disk error.') throw Error('Save retry failed');
        await page.evaluate(()=>{
          const c=window.__fixtureCapture;
          for(let i=0;i<14;i++)window.__snapshot.captures.push({...structuredClone(c),id:`7bc50320-4508-4ff8-ae6c-${String(i).padStart(12,'0')}`});
        });
        await page.locator('#projects [data-project="00000000-0000-0000-0000-000000000000"]').click();
        const emptyWidth=await page.locator('#captures').evaluate(el=>el.clientWidth);
        await page.locator('#projects [data-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]').click();
        if(await page.locator('#captures').evaluate(el=>el.clientWidth)!==emptyWidth)throw Error('Scrollbar gutter must stay stable between empty and full folders');
        await page.locator('#captures').evaluate(el=>el.scrollTop=140);
        const item=await page.locator('.capture-item').first().elementHandle();
        await page.locator('.capture-item').nth(1).click();
        if(!(await item.evaluate(el=>el.isConnected)))throw Error('Changing selection must retain capture-list nodes');
        await page.locator('#projects [data-project="00000000-0000-0000-0000-000000000000"]').click();
        await page.locator('#projects [data-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]').click();
        if(await page.locator('#captures').evaluate(el=>el.scrollTop)!==0)throw Error('A different folder must not inherit old list scroll');
        console.log('PASS stable scroll gutter and capture list');
        await page.locator('#move-project summary').click();
        if(await page.locator('select').count())throw Error('No native folder dropdown should remain');
        await page.screenshot({path:`test-results/library/destination-picker-${theme}.png`});
        await page.keyboard.press('ArrowDown');
        if(!(await page.evaluate(()=>document.activeElement?.hasAttribute('data-move-project'))))throw Error('Move picker needs arrow-key navigation');
        await page.keyboard.press('Escape');
        if(await page.locator('#move-project').getAttribute('open')!==null)throw Error('Escape should tuck away the picker');
        await page.locator('#move-project summary').click();
        await page.locator('[data-move-project="00000000-0000-0000-0000-000000000000"]').click();
        await page.waitForFunction(()=>document.querySelectorAll('.capture-item').length===14);
        if(await page.evaluate(()=>window.__calls.filter(c=>c.command==='move_capture').at(-1).args.projectId)!=='00000000-0000-0000-0000-000000000000')throw Error('Custom picker must move the selected capture');

        await page.locator('.project-actions-menu summary').click();
        await page.getByRole('button',{name:'New subfolder',exact:true}).click();
        if(await page.locator('#dialog-name').count())throw Error('Numbered folders must not request a name');
        await page.getByRole('heading',{name:'Folder 0',exact:true}).waitFor();
        if(await page.evaluate(()=>window.__calls.find(c=>c.command==='create_project').args.parentId)!=='87f5be98-0025-4fb9-a51f-01e267f2667c')throw Error('Subfolder parent lost');
        if(await page.locator('#parent-project').innerText()!=='‹ Design notes')throw Error('Missing parent breadcrumb');
        await page.locator('.project-actions-menu summary').click();
        if(await page.getByRole('button',{name:'New subfolder',exact:true}).isVisible())throw Error('Subfolders must not offer nested creation');
        await page.keyboard.press('Escape');
        const fold=page.locator('#projects [data-collapse-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]');
        await fold.click();
        await page.waitForFunction(()=>document.querySelector('#projects .project-tree-children').getBoundingClientRect().height<1);
        if(await page.locator('#project-name').innerText()!=='Folder 0')throw Error('Collapsing must not navigate away from a subfolder');
        if(!(await page.locator('#projects .project-tree-children').evaluate(el=>el.inert)))throw Error('Collapsed folders must leave keyboard navigation');
        await page.screenshot({path:`test-results/library/project-collapsed-${theme}.png`});
        // Change folders to force a library refresh. The project should stay folded.
        await page.locator('#projects [data-project="00000000-0000-0000-0000-000000000000"]').click();
        if(await fold.getAttribute('aria-expanded')!=='false')throw Error('Refresh lost collapsed state');
        await fold.focus(); await page.keyboard.press('Enter');
        await page.locator('#projects [data-project="b1234567-1234-4567-8910-123456789012"]').click();
        console.log('PASS collapse, keyboard expansion, preserved selection and one-level creation');
        await page.locator('#parent-project').click();
        await page.locator('#move-project summary').click();
        const pickerFold=page.locator('#move-project [data-collapse-project="87f5be98-0025-4fb9-a51f-01e267f2667c"]');
        await pickerFold.click();
        if(await fold.getAttribute('aria-expanded')!=='false')throw Error('Destination picker and sidebar collapse should agree');
        await page.keyboard.press('End');
        if(await page.evaluate(()=>document.activeElement?.dataset.moveProject)!=='87f5be98-0025-4fb9-a51f-01e267f2667c')throw Error('Arrow navigation must skip collapsed subfolders');
        await pickerFold.focus(); await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.locator('#projects [data-project="b1234567-1234-4567-8910-123456789012"]').click();


        await page.locator('.project-actions-menu summary').click();
        await page.getByRole('button',{name:'Copy folder as path',exact:true}).click();
        await page.getByText('Folder path copied', {exact:false}).waitFor();
        await page.locator('.project-actions-menu summary').click();
        await page.getByRole('button',{name:'Export as ZIP',exact:true}).click();
        await page.getByText('ZIP saved to', {exact:false}).waitFor();
        const calls=await page.evaluate(()=>window.__calls.filter(c=>c.command==='copy_project_path'||c.command==='export_project_zip'));
        if(calls.some(c=>c.args.projectId!=='b1234567-1234-4567-8910-123456789012'))throw Error('Sharing should target only the selected subfolder');
        await page.screenshot({path: `test-results/library/project-subfolder-${theme}.png`});
        await page.locator('.project-actions-menu summary').click();
        await page.getByRole('button',{name:'Delete subfolder',exact:true}).click();
        await page.getByText('Permanently delete', {exact:false}).waitFor();
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
        if(await page.evaluate(()=>window.__calls.some(c=>c.command==='delete_project')))throw Error('Cancel must not delete');
        await page.locator('.project-actions-menu summary').click();
        await page.getByRole('button',{name:'Delete subfolder',exact:true}).click();
        await page.getByRole('button',{name:'Delete everything',exact:true}).click();
        await page.getByRole('heading',{name:'Design notes',exact:true}).waitFor();
        if(await page.locator('[data-project="b1234567-1234-4567-8910-123456789012"]').count())throw Error('Deleted child remained visible');
      } else {
        await page.setViewportSize({ width: 400, height: 480 });
        await page.screenshot({ path: `test-results/library/recorder-narrow-${theme}.png` });
        const save = await page.locator('[data-action="save"]').boundingBox();
        if (!save || save.y + save.height > 480) throw Error('Save is outside the narrow recorder');
      }
      if (errors.length) throw Error(errors.join('\n'));
      await page.close();
      console.log(`${view} ${theme}: rendered without errors`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}

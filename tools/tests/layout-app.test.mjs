
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture,openApp,phoneContext,startServer} from './helpers.mjs';

for(const width of [320,390,1440]){
 test('layout builder preserves original records through a draft and apply at '+width+'px',async t=>{
   const browser=await chromium.launch();
   t.after(()=>browser.close());
   const {server,url}=await startServer();
   t.after(()=>new Promise(resolve=>server.close(resolve)));
   const page=await browser.newPage(width<500?phoneContext(width):{viewport:{width,height:900}});
   const errors=await openApp(page,url,{hash:'#garden'});
   const click=name=>page.getByRole('button',{name,exact:true}).click();
   const fill=(name,value)=>page.getByLabel(name,{exact:true}).fill(value);
   const state=()=>page.evaluate(()=>window.GardenForge.getState());
   await click('Start a layout');
   await page.getByLabel('Starting shape').selectOption('ell');
   await fill('Overall width (ft)','18');await fill('Overall length (ft)','12');
   await fill('Cutout width (ft)','6');await fill('Cutout length (ft)','4');
   await click('Create draft');
   await click('Place saved space');await click('Place in draft');await click('Plan crops');
   await click('Place saved planting');await click('Place in draft');
   await click('Edit measurements');await fill('Left edge (ft)','2');await click('Update draft');
   assert.ok(await page.getByText('Left 2 ft · Top 0 ft').isVisible());
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await click('Close draft');
   assert.deepEqual((await state()).plans,fixture.plans);
   assert.equal((await state()).settings.gardenLayout,undefined);
   await page.reload();await click('Resume layout draft');
   await click('Review & apply');await click('Apply layout');
   const committed=await state();
   assert.deepEqual(committed.plans,fixture.plans);
   assert.deepEqual(committed.beds,fixture.beds);
   assert.deepEqual(committed.logs,fixture.logs);
   assert.equal(committed.settings.gardenLayout.patches[0].x,2);
   assert.equal(committed.settings.gardenLayout.patches[0].id,fixture.plans[0].id);
   assert.deepEqual(errors,[]);
 });
}


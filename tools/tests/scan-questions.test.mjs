import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function scanClarificationHTML('),html.indexOf('function scanResultHTML('));
const edit=html.split('\n').find(line=>line.startsWith('function beginScanEdit('));
function setup(answers=['Opposite leaves']){
 const old={id:'old-scan',status:'completed',notes:'Original observation',escalate:true,images:[{id:'photo'}],result:{analysis:{},clarification:{questions:['How are the leaves arranged?']}}};
 const saved=[],calls=[],messages=[],views=[],feedback={textContent:''};
 const ctx=vm.createContext({scanDraft:structuredClone(old),scanBusy:false,structuredClone,uid:()=> 'new-scan',h:s=>String(s).replaceAll('<','&lt;'),document:{querySelector:()=>null,querySelectorAll:()=>answers.map(value=>({value})),getElementById:()=>feedback},scanNextPhoto:()=> 'Add a daylight flower close-up.',persistScan:async()=>{saved.push(structuredClone(ctx.scanDraft));},showScanView:v=>views.push(v),scanMessage:m=>messages.push(m),setScanBusy:b=>ctx.scanBusy=b,analyzeScan:async mode=>calls.push(mode)});
 vm.runInContext(edit+'\n'+code,ctx);return {ctx,old,saved,calls,messages,views,feedback,run:s=>vm.runInContext(s,ctx)};
}
test('answering forks the original result, saves context and requests Haiku reassessment',async()=>{
 const h=setup();await h.run('submitScanClarification()');assert.equal(h.old.id,'old-scan');assert.equal(h.old.status,'completed');assert.equal(h.ctx.scanDraft.id,'new-scan');assert.match(h.ctx.scanDraft.notes,/Original observation\nClarification observations:\nHow are the leaves arranged\?\nOpposite leaves/);assert.equal(h.saved.length,1);assert.deepEqual(h.calls,['haiku-followup']);assert.equal(h.ctx.scanBusy,false);assert.equal(h.ctx.scanDraft.images[0].id,'photo');
});
test('empty or overlong answers do not change records or incur calls',async()=>{
 for(const answers of [[],['x'.repeat(2000)]]){const h=setup(answers);await h.run('submitScanClarification()');assert.equal(h.saved.length,0);assert.equal(h.calls.length,0);assert.equal(h.ctx.scanDraft.id,'old-scan');assert.ok(h.feedback.textContent);}
});
test('adding a photo saves any answers without calling a provider',async()=>{
 const h=setup();await h.run('submitScanClarification(true)');assert.equal(h.calls.length,0);assert.equal(h.saved.length,1);assert.equal(h.ctx.scanModelMode,'haiku-followup');assert.equal(h.ctx.scanPhotoHint,'Add a daylight flower close-up.');assert.deepEqual(h.views,['capture']);
});
test('save failure leaves answers recoverable and does not submit analysis',async()=>{
 const h=setup();h.ctx.persistScan=async()=>{throw Error('quota');};await h.run('submitScanClarification()');assert.equal(h.calls.length,0);assert.equal(h.ctx.scanBusy,false);assert.match(h.ctx.scanDraft.notes,/Opposite leaves/);assert.match(h.messages.at(-1),/could not be saved/);assert.deepEqual(h.views,['capture']);
});
test('question markup escapes model text and explains additional calls before the buttons',()=>{
 const h=setup();const markup=h.run("scanClarificationHTML({clarification:{questions:['<img src=x>']}})");assert.ok(!markup.includes('<img'));assert.match(markup,/billed Haiku/);assert.match(markup,/Sonnet rate/);assert.match(markup,/maxlength="300"/);
});

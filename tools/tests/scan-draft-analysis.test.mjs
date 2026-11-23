import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function blobData('),html.indexOf('async function exportScans('));
function setup(mode='success',count=2){
 const timers=new Map(),messages=[],requests=[],saves=[];let timerId=0,aborts=0;
 const saved={id:'saved-draft',status:'draft',notes:'Existing notes',stage:'flowering',plantId:'',images:Array.from({length:count},(_,i)=>({id:'photo-'+i,blob:new Blob(['saved photo '+i],{type:'image/jpeg'})})),result:null};
 class Reader{
  readAsDataURL(blob){
   if(mode==='stall')return;
   queueMicrotask(async()=>{
    if(mode==='abort'){this.onabort?.();return;}
    if(mode==='error'){this.error={name:'NotReadableError'};this.onerror?.();return;}
    this.result='data:image/jpeg;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload?.();
   });
  }
  abort(){aborts++;this.onabort?.();}
 }
 const ctx=vm.createContext({Blob,FileReader:Reader,Error,AbortSignal,scanBusy:false,scanModelMode:'haiku',scanDraft:structuredClone(saved),navigator:{onLine:true},state:{plans:[],settings:{zone:'10a'}},scanMessage:m=>messages.push(m),setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),beginScanEdit:()=>{},persistScan:async()=>{saves.push(structuredClone(ctx.scanDraft));},setScanBusy:b=>ctx.scanBusy=b,showScanView:()=>{},drawScanHistory:async()=>{},fetch:async(url,opts)=>{requests.push(JSON.parse(opts.body));return {ok:true,json:async()=>({analysis:{identification:'Mock plant'}})};}});
 vm.runInContext(code,ctx);
 return {ctx,saved,timers,messages,requests,saves,aborts:()=>aborts,setMode:value=>mode=value,analyze:()=>vm.runInContext('analyzeScan()',ctx)};
}
for(const count of [1,6])test(`restored ${count}-photo draft sends its saved bytes and completes without losing metadata`,async()=>{
 const h=setup('success',count);await h.analyze();
 assert.equal(h.requests.length,1);assert.equal(h.ctx.scanBusy,false);assert.equal(h.ctx.scanDraft.status,'completed');
 assert.equal(h.requests[0].notes,h.saved.notes);assert.equal(h.ctx.scanDraft.id,h.saved.id);
 assert.deepEqual(h.requests[0].images.map(x=>Buffer.from(x.data,'base64').toString()),Array.from({length:count},(_,i)=>'saved photo '+i));
 assert.equal(h.ctx.scanDraft.images.length,count);assert.equal(h.timers.size,0);
});
test('stalled restored photo releases controls, preserves draft, and allows a successful retry',async()=>{
 const h=setup('stall');const pending=h.analyze();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.ctx.scanBusy,true);assert.equal(h.timers.size,1);
 for(const fn of [...h.timers.values()])fn();await pending;
 assert.equal(h.ctx.scanBusy,false);assert.equal(h.requests.length,0);assert.equal(h.aborts(),1);
 assert.equal(h.ctx.scanDraft.status,'draft');assert.equal(h.ctx.scanDraft.images.length,2);
 assert.match(h.messages.at(-1),/Photo 1:.*timed out.*draft is kept.*thumbnail/);
 h.setMode('success');await h.analyze();assert.equal(h.requests.length,1);assert.equal(h.ctx.scanDraft.status,'completed');
});
for(const mode of ['error','abort'])test(`saved photo ${mode} produces an actionable failure without sending a request`,async()=>{
 const h=setup(mode);await h.analyze();assert.equal(h.ctx.scanBusy,false);assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);
 assert.match(h.messages.at(-1),/Photo 1:.*draft is kept/);assert.equal(h.ctx.scanDraft.images.length,2);
});
test('missing saved bytes identify the affected photo and preserve the other photos',async()=>{
 const h=setup();h.ctx.scanDraft.images[1].blob=new Blob([]);await h.analyze();
 assert.match(h.messages.at(-1),/Photo 2:.*missing or empty/);assert.equal(h.requests.length,0);assert.equal(h.ctx.scanBusy,false);assert.equal(h.ctx.scanDraft.images[0].blob.size,h.saved.images[0].blob.size);
});
test('save failure reports before uploading and returns usable controls',async()=>{
 const h=setup();h.ctx.persistScan=async()=>{throw new Error('Photo storage timed out.');};await h.analyze();
 assert.equal(h.requests.length,0);assert.equal(h.ctx.scanBusy,false);assert.match(h.messages.at(-1),/storage timed out/);assert.equal(h.ctx.scanDraft.images.length,2);
});
test('offline draft receives a visible instruction without changing the draft',async()=>{
 const h=setup();h.ctx.navigator.onLine=false;await h.analyze();assert.equal(h.requests.length,0);assert.equal(h.saves.length,0);assert.match(h.messages.at(-1),/Reconnect/);
});

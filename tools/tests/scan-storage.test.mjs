import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function scanDB()'),html.indexOf('const scanAll='));
test('stalled scan database open rejects and closes a late connection',async()=>{
 let timeout,closed=0;const request={};
 const ctx=vm.createContext({SCAN_DB:'test',indexedDB:{open:()=>request},setTimeout:fn=>(timeout=fn,1),clearTimeout:()=>{},Error});
 vm.runInContext(code,ctx);const pending=vm.runInContext('scanDB()',ctx);
 timeout();await assert.rejects(pending,/did not respond/);
 request.result={close:()=>closed++};request.onsuccess();assert.equal(closed,1);
});
test('stalled scan transaction aborts before releasing its database',async()=>{
 let timeout,aborted=0,closed=0;
 const tx={objectStore:()=>({}),abort:()=>aborted++};
 const db={transaction:()=>tx,close:()=>closed++};
 const ctx=vm.createContext({setTimeout:fn=>(timeout=fn,1),clearTimeout:()=>{},Error,db});
 vm.runInContext(code+';scanDB=async()=>db;',ctx);
 const pending=vm.runInContext("scanStore('readwrite',()=>({}))",ctx);
 await Promise.resolve();timeout();
 await assert.rejects(pending,/timed out/);assert.equal(aborted,1);assert.equal(closed,1);
});
test('Analyze remains usable after an unavailable configuration response',()=>{
 const start=html.indexOf('function setScanBusy('),end=html.indexOf('function drawScanConnection',start);
 const button={disabled:true},ctx=vm.createContext({scanBusy:false,navigator:{onLine:true},scanDraft:{images:[{}]},scanConfig:{available:false},photoCountLabel:()=> 'Analyze 1 photo',document:{querySelectorAll:()=>[],querySelector:selector=>selector.includes('analyze')?button:null}});
 vm.runInContext(html.slice(start,end)+';setScanBusy(false)',ctx);
 assert.equal(button.disabled,false);
 vm.runInContext('setScanBusy(true)',ctx);assert.equal(button.disabled,true);
});

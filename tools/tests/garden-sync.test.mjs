import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {startServer,fixture,phoneContext} from './helpers.mjs';
import {handleGardenSync} from '../../server/sync.mjs';

function privateStorage() {
  const objects=new Map();
  return {
    async get(key) {
      const data=objects.get(key);
      return data && {...data,json:async()=>JSON.parse(data.body.toString())};
    },
    async put(key,value,{onlyIf}) {
      const exists=objects.get(key);
      if(onlyIf instanceof Headers ? !!exists : exists?.etag!==onlyIf.etagMatches) return null;
      const body=Buffer.from(value),etag=createHash('md5').update(body).digest('hex');
      objects.set(key,{body,etag});return {etag};
    }
  };
}

test('account identity scopes all records and photos; stale snapshots cannot replace current ones',async()=>{
  const env={BUCKET:privateStorage()};
  const req=(user,route,method='GET',body,headers={})=>new Request('https://gf.test/api/garden-sync/'+route,{method,body,headers:{origin:'https://gf.test','content-type':'application/json',...(user?{'oai-authenticated-user-id':user,'x-garden-account':user}:{}),...headers}});
  const put=(rev=null)=>JSON.stringify({revision:rev,snapshot:{version:1,garden:fixture,photos:[],scans:[]}});
  assert.equal((await handleGardenSync(req(null,'garden'),env)).status,401);
  assert.equal((await handleGardenSync(req('a','garden','GET',undefined,{'x-garden-account':'b'}),env)).status,403);
  assert.equal((await handleGardenSync(req('a','garden','PUT',put(),{origin:'https://other.test'}),env)).status,403);
  const first=await (await handleGardenSync(req('a','garden','PUT',put()),env)).json();
  assert.ok(first.revision);
  assert.equal((await handleGardenSync(req('a','garden','PUT',put()),env)).status,409);
  assert.equal((await handleGardenSync(req('a','garden','PUT',put('1'.repeat(32))),env)).status,409);
  assert.equal((await handleGardenSync(req('a','garden','PUT',put(first.revision)),env)).status,200);
  assert.equal((await (await handleGardenSync(req('b','garden'),env)).json()).snapshot,null);
  const jpeg=Buffer.from([255,216,255,217]),hash=createHash('sha256').update(jpeg).digest('hex');
  assert.equal((await handleGardenSync(req('a','photos/'+hash,'PUT',jpeg,{'content-type':'image/jpeg'}),env)).status,200);
  assert.equal((await handleGardenSync(req('b','photos/'+hash),env)).status,404);
});

test('iPhone and desktop combine existing records, restore photo bytes, merge offline work, resolve same-item edits and sync deletions',async()=>{
  const env={BUCKET:privateStorage()};
  const srv=await startServer({handleRequest(req,res){
    if(!req.url.startsWith('/api/garden-sync/')) return false;
    (async()=>{
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','test-account');
      headers.set('oai-authenticated-user-email','gardener@example.test');
      const response=await handleGardenSync(new Request('http://'+req.headers.host+req.url,{method:req.method,headers,body:req.method==='PUT'?Buffer.concat(chunks):undefined}),env);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(e=>{res.writeHead(500);res.end(e.message);});return true;
  }});
  const browser=await chromium.launch().catch(err=>{srv.server.close();throw err;});
  try {
    const phoneCtx=await browser.newContext({...phoneContext(320),serviceWorkers:'block'}), desktopCtx=await browser.newContext({serviceWorkers:'block'});
    const phone=await phoneCtx.newPage(), pc=await desktopCtx.newPage();
    await Promise.all([phone.goto(srv.url),pc.goto(srv.url)]);
    await phone.evaluate(async f=>{
      state=validateState(f);save();
      const blob=new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'});
      await photoPut({id:'p1',planId:f.plans[0].id,createdAt:new Date().toISOString(),note:'First bloom',blob});
      const scan=newScan();scan.id='s1';scan.notes='Check leaves';scan.images=[{id:'img1',addedAt:scan.createdAt,blob}];await scanPut(scan);
    },fixture);
    async function sync(page) {
      await page.locator('[data-connect]').click();
      await page.waitForFunction(()=>document.querySelector('#garden-sync [role=status]')?.textContent.startsWith('Last synced'));
    }
    await sync(phone);await sync(pc);
    assert.equal(await pc.evaluate(()=>state.beds[0].name),'Bed A');
    assert.deepEqual(await pc.evaluate(async()=>[...(new Uint8Array(await (await scanAll())[0].images[0].blob.arrayBuffer()))]),[255,216,255,217]);
    assert.equal(await pc.evaluate(async()=>(await photoList('plant_1'))[0].note),'First bloom');
    await phoneCtx.setOffline(true);
    await phone.evaluate(()=>{state.logs[0].title='Phone observation';save();});
    await pc.evaluate(()=>{state.beds[0].name='Patio';save();});await sync(pc);
    await phoneCtx.setOffline(false);await sync(phone);await sync(pc);
    assert.deepEqual(await pc.evaluate(()=>[state.beds[0].name,state.logs[0].title]),['Patio','Phone observation']);
    await phoneCtx.setOffline(true);await phone.evaluate(()=>{state.beds[0].name='Phone patio';save();});
    await pc.evaluate(()=>{state.beds[0].name='Desktop patio';save();});await sync(pc);
    await phoneCtx.setOffline(false);await phone.locator('[data-connect]').click();
    await phone.locator('[data-resolve="device"]').click();await phone.waitForFunction(()=>document.querySelector('#garden-sync [role=status]').textContent.startsWith('Last synced'));
    await sync(pc);assert.equal(await pc.evaluate(()=>state.beds[0].name),'Phone patio');
    await pc.evaluate(async()=>{state.logs=[];save();await photoDelete('p1');});await sync(pc);await sync(phone);
    assert.equal(await phone.evaluate(()=>state.logs.length),0);
    assert.equal(await phone.evaluate(async()=>(await photoList('plant_1')).length),0);
    assert.equal(await phone.evaluate(()=>JSON.parse(localStorage.getItem('gardenforge.brownsville.v1')).schemaVersion),1);
  } finally {await browser.close();srv.server.close();}
});

test('three-way merge preserves unpaired devices, detects a changed conflict choice and distinguishes delete from absence on first connection',async()=>{
  // Exercise the actual merge function from the classic browser script with the app's default garden.
  const {readFile}=await import('node:fs/promises');
  const {runInNewContext}=await import('node:vm');
  const code=await readFile(new URL('../../garden-sync.js',import.meta.url),'utf8');
  const merge=runInNewContext(code.slice(code.indexOf('  function reconcile('),code.indexOf('  function hashes('))+'\nreconcile',{
    same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),collections:['beds','plans','recipes','logs','customCrops','customIngredients'],validateState:x=>x,conflict:null});
  const garden=structuredClone(fixture);garden.updatedAt='';garden.beds=[];garden.logs=[];garden.plans=[];
  const empty={version:1,garden,photos:[],scans:[]};
  const desktop=structuredClone(empty),phone=structuredClone(empty);
  phone.garden.beds=[{id:'a',name:'Patio'}];phone.scans=[{id:'s',images:[{imageHash:'x'}]}];
  desktop.garden.logs=[{id:'b',title:'Watered'}];
  let both=merge(empty,desktop,phone,new Map());
  assert.equal(both.garden.beds[0].name,'Patio');assert.equal(both.garden.logs[0].title,'Watered');assert.equal(both.scans[0].id,'s');
  const base=structuredClone(both),left=structuredClone(base),right=structuredClone(base);
  left.garden.beds=[];right.garden.beds[0].name='Back patio';
  assert.throws(()=>merge(base,left,right,new Map()),/Both devices/);
  const choices=new Map([['beds / a',{side:'device',device:undefined,cloud:right.garden.beds[0]}]]);
  assert.equal(merge(base,left,right,choices).garden.beds.length,0);
  right.garden.beds=[{id:'a',name:'Changed again'}];assert.throws(()=>merge(base,left,right,choices),/Both devices/);
});

test('two independent clients exchange actual snapshot and photo requests and recover after an interrupted upload',async()=>{
  const {runInNewContext}=await import('node:vm');
  const fs=await import('node:fs/promises');
  const script=await fs.readFile(new URL('../../garden-sync.js',import.meta.url),'utf8');
  const env={BUCKET:privateStorage()};
  const fresh=()=>({...structuredClone(fixture),beds:[],plans:[],logs:[],updatedAt:''});
  function client(initial) {
    const memory=new Map([['garden',JSON.stringify(initial)]]), records={photos:new Map(),scans:new Map(),accounts:new Map()};
    function db() {
      return {close(){},transaction(name) {
        const table=records[name], tx={objectStore:()=>({
          get:key=>({result:structuredClone(table.get(key))}),getAll:()=>{
            const q={result:structuredClone([...table.values()])};queueMicrotask(()=>q.onsuccess());return q;},
          put:(row,key)=>{table.set(key??row.id,structuredClone(row));return {result:key};},delete:key=>table.delete(key)
        })};
        setImmediate(()=>tx.oncomplete?.());return tx;
      }};
    }
    const panel={addEventListener(){},innerHTML:''},dialog={open:false};
    const context={state:structuredClone(initial),KEY:'garden',ui:{page:'overview'},scanBusy:false,storageOK:true,unreadableSaved:null,keyProtected:false,
      scanDraft:null,scanSaveQueue:Promise.resolve(),PHOTO_STORE:'photos',photoDB:async()=>db(),scanDB:async()=>db(),scanAll:async()=>structuredClone([...records.scans.values()]),
      defaultState:fresh,validateState:x=>x,validateScanArchive:()=>{},clone:structuredClone,h:String,render(){},crypto,Blob,Map,Set,Headers,AbortSignal,
      navigator:{onLine:true},window:{addEventListener(){}},document:{getElementById:id=>id==='dialog'?dialog:panel},localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},
      setInterval(){},setTimeout(){},clearTimeout(){},indexedDB:{open(){const q={result:db()};queueMicrotask(()=>q.onsuccess());return q;}},
      async fetch(route,options) {
        const headers=new Headers(options.headers);headers.set('oai-authenticated-user-id','owner');headers.set('origin','https://gf.test');
        if(context.failManifest && route.endsWith('/garden') && options.method==='PUT') return Response.json({error:'interrupted'},{status:503});
        return handleGardenSync(new Request(new URL(route,'https://gf.test/'),{...options,headers}),env);
      }};
    // Expose the same event handler for deterministic invocations without a browser clock.
    runInNewContext(script.replace('  window.gardenSyncPage();\n})();','  window.testSync=run; window.gardenSyncPage();\n})();'),context);
    async function sync(){await context.window.testSync(true);return panel.innerHTML;}
    function saved(){memory.set('garden',JSON.stringify(context.state));context.window.gardenSyncGardenSaved();}
    return {context,records,sync,saved};
  }
  const mobile=client(structuredClone(fixture)), desktop=client(fresh());
  const jpeg=new Blob([new Uint8Array([255,216,255,224])],{type:'image/jpeg'});
  mobile.records.photos.set('photo',{id:'photo',planId:'plant_1',createdAt:new Date().toISOString(),blob:jpeg});
  mobile.records.scans.set('scan',{id:'scan',images:[{id:'img',blob:jpeg}]});
  mobile.context.failManifest=true;assert.match(await mobile.sync(),/interrupted/);
  assert.equal(mobile.records.accounts.size,0);
  mobile.context.failManifest=false;assert.match(await mobile.sync(),/Last synced/);
  assert.match(await desktop.sync(),/Last synced/);
  assert.equal(desktop.context.state.beds[0].name,fixture.beds[0].name);
  for(const blob of [desktop.records.photos.get('photo').blob,desktop.records.scans.get('scan').images[0].blob]) {
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),new Uint8Array(await jpeg.arrayBuffer()));
  }
  mobile.context.state.logs[0].title='Phone change';mobile.saved();
  desktop.context.state.beds[0].name='Desktop change';desktop.saved();
  assert.match(await desktop.sync(),/Last synced/);assert.match(await mobile.sync(),/Last synced/);assert.match(await desktop.sync(),/Last synced/);
  assert.equal(desktop.context.state.logs[0].title,'Phone change');assert.equal(mobile.context.state.beds[0].name,'Desktop change');
  desktop.context.state.logs=[];desktop.saved();assert.match(await desktop.sync(),/Last synced/);assert.match(await mobile.sync(),/Last synced/);
  assert.equal(mobile.context.state.logs.length,0);
});

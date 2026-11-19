// Loaded only by the hosted app. The existing garden, photo and scan stores remain the offline working copy.
(() => {
  'use strict';
  const collections = ['beds','plans','recipes','logs','customCrops','customIngredients'];
  const pinKey = KEY + '.sync-account';
  const root = document.getElementById('garden-sync');
  let account, running = false, pending = true, generation = 0, note = '', conflict = null;
  let lastPage, syncedAt, timer, metaDB;
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const home = () => ui.page === 'overview' && !document.getElementById('dialog').open && !scanBusy;
  function pin() {
    try {return localStorage.getItem(pinKey);} catch {return null;}
  }
  let knownGarden;
  try {knownGarden=localStorage.getItem(KEY);} catch {}
  window.gardenSyncMaySave=()=>!pin() || knownGarden===localStorage.getItem(KEY);
  window.gardenSyncGardenSaved=()=>{knownGarden=localStorage.getItem(KEY);window.gardenSyncChanged();};

  async function api(route, options = {}) {
    const headers = new Headers(options.headers);
    if (account) headers.set('x-garden-account',account.account);
    const res = await fetch('./api/garden-sync/'+route,{...options,headers,cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(45000)});
    if (res.status === 401 || res.redirected) {
      account = null;
      throw Error('Sign in with your GardenForge ChatGPT account, then sync again.');
    }
    if (!res.ok) {
      const message = await res.json().catch(()=>({}));
      throw Error(message.error || 'Garden sync is unavailable. Try again when online.');
    }
    return res;
  }

  function paint() {
    root.hidden = ui.page !== 'overview';
    if (root.hidden) return;
    const owner = pin();
    const status = !navigator.onLine ? 'Offline. Changes stay on this device until you reconnect.' :
      running ? 'Syncing your garden…' : note || (syncedAt ? 'Last synced '+new Date(syncedAt).toLocaleString() : 'Connect your iPhone and desktop to the same ChatGPT account.');
    root.innerHTML = '<div class="card-head"><div><h2>Garden sync</h2><p class="small muted">'+h(account?.email || (account ? 'Signed in with ChatGPT' : 'GardenForge account'))+'</p></div></div>'+
      '<p role="status" aria-live="polite">'+h(status)+'</p>'+
      (!owner ? '<p class="small">Connect to combine this device’s beds, plantings, journal, mixes, photos and plant scans with your private garden.</p>' : '<p class="small">Your garden syncs while Home is open. Offline edits are kept here.</p>')+
      (conflict ? '<details open><summary>'+h(conflict.label)+'</summary><div class="sync-choices">'+
        ['device','cloud'].map(side=>'<div><strong>'+ (side==='device'?'This device':'Account copy')+'</strong><pre>'+h(JSON.stringify(conflict[side],null,2) ?? 'Deleted')+'</pre><button class="btn" data-resolve="'+side+'">Use '+(side==='device'?'device':'account')+' version</button></div>').join('')+'</div></details>' : '')+
      '<div class="actions"><button class="btn primary" data-connect '+(running || !navigator.onLine?'disabled':'')+'>'+(owner?'Sync now':'Connect this device')+'</button>'+
      (!account?'<a class="btn" target="_top" href="/signin-with-chatgpt?return_to=%2F">Sign in with ChatGPT</a>':'')+'</div>';
  }

  async function meta() {
    if (!metaDB) metaDB = await new Promise((resolve,reject)=>{
      const q=indexedDB.open('gardenforge.account-sync.v1',1);
      q.onupgradeneeded=()=>q.result.createObjectStore('accounts');
      q.onsuccess=()=>resolve(q.result); q.onerror=()=>reject(q.error);
    });
    return metaDB;
  }
  async function prior(write) {
    const db=await meta();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('accounts',write?'readwrite':'readonly'), store=tx.objectStore('accounts');
      const q=write ? store.put(write,account.account) : store.get(account.account);
      tx.oncomplete=()=>resolve(q.result); tx.onabort=tx.onerror=()=>reject(tx.error);
    });
  }
  function emptySnapshot() {
    const garden=defaultState();
    garden.updatedAt='';
    return {version:1,garden,photos:[],scans:[]};
  }
  function digest(bytes) {
    return crypto.subtle.digest('SHA-256',bytes).then(hash=>Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join(''));
  }
  async function progressRows() {
    const db=await photoDB();
    try { return await new Promise((resolve,reject)=>{
      const q=db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).getAll();
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
    }); } finally {db.close();}
  }
  async function capture() {
    const garden=validateState(clone(state)); garden.updatedAt='';
    const blobs=new Map();
    async function pack(row) {
      const {blob,...rest}=row;
      const imageHash=await digest(await blob.arrayBuffer());
      blobs.set(imageHash,blob);
      return {...rest,imageHash};
    }
    const photos=[],scans=[];
    for(const row of await progressRows()) photos.push(await pack(row));
    for(const row of await scanAll()) {
      const images=[];
      for(const photo of row.images) images.push(await pack(photo));
      scans.push({...row,images});
    }
    return {snapshot:{version:1,garden,photos,scans},blobs};
  }

  // Unrelated records merge independently. A collision, including edit vs delete, needs a choice.
  function reconcile(base, device, cloud, choices) {
    function value(before,left,right,label) {
      if(same(left,right) || same(before,right)) return left;
      if(same(before,left)) return right;
      const choice=choices.get(label);
      if(choice && same(choice.device,left) && same(choice.cloud,right)) return choice.side==='device'?left:right;
      conflict={label,device:left,cloud:right};
      throw Error('Both devices changed this item. Choose which version to keep.');
    }
    function rows(key,b,l,r) {
      function byId(list) {
        const map=new Map();
        for(const row of list) {
          if(typeof row.id!=='string'||!row.id||map.has(row.id)) throw Error('A record in '+key+' has a missing or duplicate ID. Your local garden is intact.');
          map.set(row.id,row);
        }
        return map;
      }
      const maps=[b,l,r].map(byId), merged=[];
      for(const id of new Set([...maps[2].keys(),...maps[1].keys(),...maps[0].keys()])) {
        const rec=value(...maps.map(m=>m.get(id)),key+' / '+id);
        if(rec!==undefined) merged.push(rec);
      }
      return merged;
    }
    const garden={...device.garden,updatedAt:''};
    for(const key of collections) garden[key]=rows(key,base.garden[key],device.garden[key],cloud.garden[key]);
    for(const key of ['completed','settings']) {
      const [b,l,r]=[base,device,cloud].map(s=>s.garden[key]);
      garden[key]=Object.fromEntries([...new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])].map(k=>[k,value(b[k],l[k],r[k],key+' / '+k)]).filter(([,v])=>v!==undefined));
    }
    garden.draft=value(base.garden.draft,device.garden.draft,cloud.garden.draft,'Current soil mix');
    return {version:1,garden:validateState(garden),photos:rows('photos',base.photos,device.photos,cloud.photos),scans:rows('scans',base.scans,device.scans,cloud.scans)};
  }

  function hashes(s) {return new Set([...s.photos,...s.scans.flatMap(r=>r.images)].map(p=>p.imageHash));}
  function validateSnapshot(s) {
    if(s?.version!==1 || !Array.isArray(s.photos)||!Array.isArray(s.scans)) throw Error('This account garden uses an unsupported format.');
    validateState(s.garden);
    for(const hash of hashes(s)) if(!/^[0-9a-f]{64}$/.test(hash)) throw Error('Invalid photo reference in the account garden.');
    for(const scan of s.scans) {
      // Reuse the archive validator for all metadata, substituting a tiny JPEG marker for separately stored bytes.
      validateScanArchive({format:'gardenforge-scans',version:1,scans:[{...scan,images:scan.images.map(p=>({...p,data:'/9j/AAAA'}))}]});
    }
    for(const p of s.photos) if(!p.id || typeof p.planId!=='string' || !Number.isFinite(Date.parse(p.createdAt))) throw Error('Invalid progress-photo record.');
  }
  async function patchStore(open, name, before, after, unpack) {
    const old=new Map(before.map(r=>[r.id,r])), next=new Map(after.map(r=>[r.id,r]));
    const writes=after.filter(r=>!same(old.get(r.id),r));
    const deletes=before.filter(r=>!next.has(r.id));
    if(!writes.length && !deletes.length) return;
    const db=await open();
    try {await new Promise((resolve,reject)=>{
      const tx=db.transaction(name,'readwrite'),store=tx.objectStore(name);
      for(const r of writes) store.put(unpack(r));
      for(const r of deletes) store.delete(r.id);
      tx.oncomplete=resolve; tx.onerror=tx.onabort=()=>reject(tx.error);
    });} finally {db.close();}
  }

  const choices=new Map();
  async function round(manual) {
    if(!home() || !navigator.onLine) return;
    if(keyProtected || unreadableSaved || !storageOK) throw Error('Restore reliable local storage before syncing.');
    const id=await (await api('account')).json();
    if(!id.ready) throw Error('Garden storage is unavailable. Try again later.');
    account=id;
    if(pin() && pin()!==id.account) {account=null;throw Error('Sign in with the ChatGPT account already connected to this device.');}
    if(!pin()) {
      if(!manual) return;
      localStorage.setItem(pinKey,id.account);
    }
    const previous=await prior(), saved=await (await api('garden')).json();
    if(!saved.snapshot && previous?.revision) throw Error('Your account copy could not be found. Your device copy is preserved.');
    if(previous && !manual && !pending && saved.revision===previous.revision) return;
    conflict=null;
    await scanSaveQueue;
    const start=generation, raw=localStorage.getItem(KEY);
    if(raw && !same(JSON.parse(raw),state)) throw Error('Another tab updated this garden. Reopen GardenForge before syncing.');
    const {snapshot:device,blobs}=await capture();
    const cloud=saved.snapshot || emptySnapshot();
    validateSnapshot(cloud);
    const merged=reconcile(previous?.snapshot || emptySnapshot(),device,cloud,choices);
    validateSnapshot(merged);
    const check=()=>{
      if(!home() || generation!==start || raw!==localStorage.getItem(KEY) || pin()!==id.account) throw Error('The garden changed during sync. Return to Home to finish syncing.');
    };
    const remoteHashes=hashes(cloud);
    for(const hash of hashes(merged)) {
      if(!blobs.has(hash)) {
        const blob=await (await api('photos/'+hash)).blob();
        if(await digest(await blob.arrayBuffer())!==hash) throw Error('A photo download was interrupted. Sync again.');
        blobs.set(hash,blob);
      } else if(!remoteHashes.has(hash)) {
        await api('photos/'+hash,{method:'PUT',headers:{'content-type':'image/jpeg'},body:blobs.get(hash)});
      }
    }
    check();
    let revision=saved.revision;
    if(!saved.snapshot || !same(merged,cloud)) {
      const res=await api('garden',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({revision,snapshot:merged})});
      revision=(await res.json()).revision;
    }
    check();
    // The checkpoint advances last. Interrupted applications replay from the previous common copy.
    const unpack=({imageHash,...rest})=>({...rest,blob:blobs.get(imageHash)});
    await patchStore(photoDB,PHOTO_STORE,device.photos,merged.photos,unpack);
    await patchStore(scanDB,'scans',device.scans,merged.scans,r=>({...r,images:r.images.map(unpack)}));
    check();
    if(!same(device.garden,merged.garden)) {
      const next=clone(merged.garden); next.updatedAt=new Date().toISOString();
      knownGarden=JSON.stringify(next); localStorage.setItem(KEY,knownGarden); state=next;
    }
    if(!same(device.scans,merged.scans)) scanDraft=null;
    syncedAt=Date.now();
    await prior({revision,snapshot:merged,at:syncedAt});
    choices.clear(); pending=generation!==start; note='';
    if(!same(device.garden,merged.garden)) render();
  }
  async function run(manual=false) {
    if(running || !home() || !navigator.onLine || (!manual && (!pin() || conflict))) return;
    running=true; paint();
    try {
      if(navigator.locks) await navigator.locks.request('gardenforge-account-sync',()=>round(manual));
      else await round(manual);
    } catch(error) {note=error.message || 'Sync interrupted. Try again.'; pending=true;}
    finally {running=false;paint();}
  }
  function soon() {
    clearTimeout(timer);
    if(pin() && home() && !running) timer=setTimeout(()=>run(),900);
  }
  window.gardenSyncChanged=()=>{generation++;pending=true;soon();};
  window.gardenSyncPage=()=>{
    paint(); if(ui.page!==lastPage) {lastPage=ui.page; if(home()) soon();}
  };
  root.addEventListener('click',event=>{
    const side=event.target.closest('[data-resolve]')?.dataset.resolve;
    if(side && conflict) {choices.set(conflict.label,{...conflict,side});conflict=null;run(true);}
    if(event.target.closest('[data-connect]')) run(true);
  });
  window.addEventListener('online',()=>{paint();soon();});
  window.addEventListener('offline',paint);
  window.addEventListener('focus',soon);
  window.addEventListener('storage',event=>{if(event.key===KEY) {pending=true;note='Another tab updated this garden. Reopen GardenForge before syncing.';paint();}});
  setInterval(()=>{if(!document.hidden && home()) run();},60000);
  window.gardenSyncPage();
})();

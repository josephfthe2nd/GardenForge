// One private, conditional snapshot per Site identity. Photos are immutable JPEG objects.
const syncHeaders = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const syncJson = (body,status=200) => Response.json(body,{status,headers:syncHeaders});
const hashPattern = /^[0-9a-f]{64}$/;

async function readSyncBytes(request, limit) {
  if (!request.body || Number(request.headers.get('content-length')) > limit) throw new RangeError();
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const {value,done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new RangeError(); }
    parts.push(value);
  }
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

export async function handleGardenSync(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/garden-sync/')) return null;
  const account = request.headers.get('oai-authenticated-user-id');
  if (!account) return syncJson({error:'Sign in with ChatGPT to sync.'},401);
  const route = url.pathname.slice('/api/garden-sync/'.length);
  if (route === 'account' && request.method === 'GET') {
    return syncJson({account,email:request.headers.get('oai-authenticated-user-email') || '',ready:!!env.BUCKET});
  }
  if (request.headers.get('x-garden-account') !== account) return syncJson({error:'The signed-in account changed. Reopen GardenForge with the connected account.'},403);
  const media = route.startsWith('photos/') && hashPattern.test(route.slice(7));
  if (route !== 'garden' && !media) return syncJson({error:'Unknown sync route.'},404);
  if (!env.BUCKET) return syncJson({error:'Garden storage is unavailable. Your local copy is safe.'},503);
  const key = 'accounts/' + encodeURIComponent(account) + '/' + route;
  try {
    if (request.method === 'GET') {
      const object = await env.BUCKET.get(key);
      if (!object) return route === 'garden' ? syncJson({revision:null,snapshot:null}) : syncJson({error:'Photo unavailable.'},404);
      if (media) return new Response(object.body,{headers:{...syncHeaders,'Content-Type':'image/jpeg'}});
      return syncJson({revision:object.etag,snapshot:await object.json()});
    }
    if (request.method !== 'PUT') return syncJson({error:'Method unavailable.'},405);
    if (request.headers.get('origin') !== url.origin) return syncJson({error:'Use GardenForge to sync.'},403);
    const type = request.headers.get('content-type')?.split(';')[0];
    if (type !== (media ? 'image/jpeg' : 'application/json')) return syncJson({error:'Unexpected content type.'},415);
    const bytes = await readSyncBytes(request,12*1024*1024);
    if (media) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b=>b.toString(16).padStart(2,'0')).join('');
      if (hash !== route.slice(7) || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) return syncJson({error:'Photo validation failed.'},400);
      await env.BUCKET.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'image/jpeg'}});
      return syncJson({saved:true});
    }
    const {revision,snapshot} = JSON.parse(new TextDecoder().decode(bytes));
    if (!(revision === null || (typeof revision === 'string' && /^[a-f0-9]{32}$/.test(revision))) ||
        snapshot?.version !== 1 || snapshot.garden?.schemaVersion !== 1 || !snapshot.garden.settings || !snapshot.garden.draft ||
        !['plans','beds','recipes','logs','customIngredients','customCrops'].every(k=>Array.isArray(snapshot.garden[k])) ||
        !Array.isArray(snapshot.photos) || !Array.isArray(snapshot.scans) ||
        !snapshot.photos.every(p=>p && hashPattern.test(p.imageHash)) ||
        !snapshot.scans.every(s=>s && Array.isArray(s.images) && s.images.length<=6 && s.images.every(p=>p && hashPattern.test(p.imageHash)))) {
      return syncJson({error:'Invalid garden snapshot.'},400);
    }
    const onlyIf = revision === null ? new Headers({'If-None-Match':'*'}) : {etagMatches:revision};
    const saved = await env.BUCKET.put(key,JSON.stringify(snapshot),{onlyIf,httpMetadata:{contentType:'application/json'}});
    return saved ? syncJson({revision:saved.etag}) : syncJson({error:'Your other device just synced. Sync again to include its changes.'},409);
  } catch (err) {
    if (err instanceof RangeError) return syncJson({error:'This upload exceeds the 12 MB per-file or garden metadata limit.'},413);
    if (err instanceof SyntaxError) return syncJson({error:'Unreadable garden snapshot.'},400);
    return syncJson({error:'Garden storage could not finish the request. Retry sync.'},503);
  }
}

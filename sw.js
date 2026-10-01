/* GardenForge: cache only this application, never external links or personal records. */
'use strict';
const PREFIX='gardenforge-v1.2-growth-journal'+encodeURIComponent(new URL(self.registration.scope).pathname)+'-';
const CACHE=PREFIX+'v1.1.0';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(request.mode==='navigate'){
  event.respondWith((async()=>{try{const response=await fetch(request);if(response.ok){const cache=await caches.open(CACHE);await cache.put('./index.html',response.clone())}return response}catch(e){return (await caches.match('./index.html'))||new Response('Reconnect once to load GardenForge.',{status:503,headers:{'Content-Type':'text/plain'}})}})());return;
 }
 if(ASSETS.some(path=>new URL(path,self.registration.scope).pathname===url.pathname))event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});

// Preserve the static app byte-for-byte, embedding its assets in the Sites Worker.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const types={'garden-sync.js':'text/javascript; charset=utf-8','index.html':'text/html; charset=utf-8','sw.js':'text/javascript; charset=utf-8','manifest.webmanifest':'application/manifest+json','icon-192.png':'image/png','icon-512.png':'image/png','apple-touch-icon.png':'image/png'};
for(const name of ['water','sun','care','soil','zone','health','ph'])types['care-'+name+'.svg']='image/svg+xml';
// Sites may serve the static client directly. Build it and the Worker from the same bytes.
const clientDir = path.join(root, 'dist/client');
await fs.rm(clientDir, {recursive: true, force: true});
await fs.mkdir(clientDir, {recursive: true});
const assets = {};
for (const [file, type] of Object.entries(types)) {
  const bytes = await fs.readFile(path.join(root, file));
  await fs.writeFile(path.join(clientDir, file), bytes);
  assets['/' + file] = {type, data: bytes.toString('base64')};
}
const care=await fs.readFile(path.join(root,'server/care.mjs'),'utf8');
const handler=care+'\n'+(await fs.readFile(path.join(root,'server/scan.mjs'),'utf8')).replace("import {cleanModelCare,enrichCare} from './care.mjs';\n",'');
const sync=await fs.readFile(path.join(root,'server/sync.mjs'),'utf8');
const lookup=await fs.readFile(path.join(root,'server/plant-lookup.mjs'),'utf8');
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const reference=JSON.parse(html.match(/<script id="reference-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const catalog=reference.crops.map(({id,name,scientific,plantLookup})=>plantLookup?.cultivar?{id,name:plantLookup.plant,scientific,cultivar:plantLookup.cultivar}:{id,name,scientific});
const entry=sync+'\n'+handler+'\n'+lookup+'\nconst catalog='+JSON.stringify(catalog)+';\nconst assets='+JSON.stringify(assets)+';\n'+`export default {async fetch(request,env){
const garden=await handleGardenSync(request,env);if(garden)return garden;
const card=await handlePlantLookup(request,env,catalog,MODELS.primary);if(card)return card;
const api=await handleScan(request,env);if(api)return api;
if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
const p=new URL(request.url).pathname;const asset=assets[p==='/'?'/index.html':p];if(!asset)return new Response('Not found',{status:404});
const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':p==='/sw.js'?'no-store':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Permissions-Policy':'camera=(self), microphone=(), geolocation=()'}});
}};\n`;
await fs.mkdir(path.join(root,'dist/server'),{recursive:true});await fs.mkdir(path.join(root,'dist/.openai'),{recursive:true});
await fs.writeFile(path.join(root,'dist/server/index.js'),entry);await fs.copyFile(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
console.log('Built GardenForge Worker with original static assets and server-only scan gateway.');

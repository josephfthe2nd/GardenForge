// Preserve the static app byte-for-byte, embedding its assets in the Sites Worker.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const types={'index.html':'text/html; charset=utf-8','sw.js':'text/javascript; charset=utf-8','manifest.webmanifest':'application/manifest+json','icon-192.png':'image/png','icon-512.png':'image/png','apple-touch-icon.png':'image/png'};
const assets={};for(const [file,type] of Object.entries(types))assets['/'+file]={type,data:(await fs.readFile(path.join(root,file))).toString('base64')};
const care=await fs.readFile(path.join(root,'server/care.mjs'),'utf8');
const handler=care+'\n'+(await fs.readFile(path.join(root,'server/scan.mjs'),'utf8')).replace("import {cleanModelCare,enrichCare} from './care.mjs';\n",'');
const entry=handler+'\nconst assets='+JSON.stringify(assets)+';\n'+`export default {async fetch(request,env){
const api=await handleScan(request,env);if(api)return api;
if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
const p=new URL(request.url).pathname;const asset=assets[p==='/'?'/index.html':p];if(!asset)return new Response('Not found',{status:404});
const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':p==='/sw.js'?'no-store':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Permissions-Policy':'camera=(self), microphone=(), geolocation=()'}});
}};\n`;
await fs.mkdir(path.join(root,'dist/server'),{recursive:true});await fs.mkdir(path.join(root,'dist/.openai'),{recursive:true});
await fs.writeFile(path.join(root,'dist/server/index.js'),entry);await fs.copyFile(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
console.log('Built GardenForge Worker with original static assets and server-only scan gateway.');

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {ROOT} from './helpers.mjs';
test('Sites Worker preserves original assets byte-for-byte and protects API routes',async()=>{execFileSync(process.execPath,['tools/build-site.mjs'],{cwd:ROOT});const code=await fs.readFile(ROOT+'/dist/server/index.js','utf8');const {default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));for(const file of ['index.html','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png']){const r=await worker.fetch(new Request('https://gardenforge.example/'+file),{});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),await fs.readFile(ROOT+'/'+file));if(file==='sw.js')assert.equal(r.headers.get('cache-control'),'no-store');}assert.equal((await worker.fetch(new Request('https://gardenforge.example/api/scan/config'),{})).status,401);assert.equal((await worker.fetch(new Request('https://gardenforge.example/missing'),{})).status,404);const root=await worker.fetch(new Request('https://gardenforge.example/'),{});assert.equal(root.headers.get('permissions-policy'),'camera=(self), microphone=(), geolocation=()');assert.ok(!code.includes('test-server-secret'));const manifest=JSON.parse(await fs.readFile(ROOT+'/dist/.openai/hosting.json'));assert.ok(manifest.project_id);assert.equal(manifest.static,undefined);});

test('production static assets match the Worker, including the sync controls and offline shell', async () => {
  const {default: worker} = await import('data:text/javascript;base64,' +
    (await fs.readFile(ROOT+'/dist/server/index.js')).toString('base64'));
  const filenames = ['index.html','garden-sync.js','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
  assert.deepEqual((await fs.readdir(ROOT+'/dist/client')).sort(), [...filenames].sort());
  for (const file of filenames) {
    const response = await worker.fetch(new Request('https://gardenforge.example/'+file), {});
    const staticCopy = await fs.readFile(ROOT+'/dist/client/'+file);
    assert.deepEqual(staticCopy, await fs.readFile(ROOT+'/'+file), file+' static asset');
    assert.deepEqual(staticCopy, Buffer.from(await response.arrayBuffer()), file+' Worker asset');
  }
  const html=await fs.readFile(ROOT+'/dist/client/index.html','utf8');
  assert.match(html, /data-action="open-garden-sync"/);
  assert.match(html, /data-sync-loading/);
});

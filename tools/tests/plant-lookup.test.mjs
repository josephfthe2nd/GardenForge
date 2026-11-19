import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ROOT,extractInlineScript} from './helpers.mjs';
import {handlePlantLookup} from '../../server/plant-lookup.mjs';

const html=fs.readFileSync(ROOT+'/index.html','utf8');
const db=JSON.parse(html.match(/<script id="reference-data" type="application\/json">([\s\S]+?)<\/script>/)[1]);
const catalog=db.crops.map(({id,name,scientific})=>({id,name,scientific}));
const sections={watering:'Check the roots.',light:'Full sun.',soil:'Good drainage.',season:'Check frost dates.'};
function request(id,options={}){return new Request('https://garden.test/api/plant-card/'+id,{method:'POST',headers:{origin:'https://garden.test','oai-authenticated-user-id':'test'},...options});}
function provider(){return Response.json({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(sections)}]});}
test('the embedded catalog includes botanical names and credited offline marigold guides',()=>{
  assert.ok(catalog.length>=62);
  assert.equal(new Set(catalog.map(c=>c.id)).size,catalog.length);
  assert.ok(catalog.every(c=>c.scientific));
  for(const c of db.crops.filter(c=>c.id.endsWith('-marigold'))){assert.match(c.photo.src,/^data:image\/webp;base64,/);assert.ok(c.photo.licenseUrl);assert.ok(c.guide.watering&&c.guide.source);}
});
test('only explicit same-origin signed-in requests for included plants can contact the provider',async()=>{
  const env={ANTHROPIC_API_KEY:'test'};const rejected=()=>assert.fail('Unexpected provider call');
  for(const [req,status] of [[request('tomato',{method:'GET'}),405],[request('tomato',{headers:{}}),401],[request('tomato',{headers:{origin:'https://elsewhere.test','oai-authenticated-user-id':'test'}}),403],[request('unknown'),400],[request('tomato',{body:'personal notes'}),400]]){
    assert.equal((await handlePlantLookup(req,env,catalog,'mock',rejected)).status,status);
  }
  assert.equal((await handlePlantLookup(request('tomato'),{},catalog,'mock',rejected)).status,503);
});
test('concurrent card requests share one provider call and later devices can reuse stored guide',async()=>{
  const store=new Map();const env={ANTHROPIC_API_KEY:'test',BUCKET:{get:async k=>store.has(k)?{json:async()=>JSON.parse(store.get(k))}:null,put:async(k,v)=>store.set(k,v)}};
  let calls=0;const fetcher=async(url,options)=>{calls++;const json=JSON.parse(options.body);assert.deepEqual(JSON.parse(json.messages[0].content),catalog.find(c=>c.id==='tomato'));return provider();};
  const ask=()=>handlePlantLookup(request('tomato'),env,catalog,'mock',fetcher);
  const results=await Promise.all([ask(),ask()]);assert.equal(results[0].status,200);assert.equal(results[1].status,200);
  delete env.ANTHROPIC_API_KEY;assert.deepEqual((await (await ask()).json()).sections,sections);assert.equal(calls,1);
});
test('incomplete or failed AI responses never become saved guides',async()=>{
  const env={ANTHROPIC_API_KEY:'test',BUCKET:{get:async()=>null,put:async()=>assert.fail('cached incomplete card')}};
  const reply=await handlePlantLookup(request('basil'),env,catalog,'mock',async()=>Response.json({stop_reason:'max_tokens'}));assert.equal(reply.status,502);
});
test('local search, selection and cached reopen work without a provider, including library storage errors',async()=>{
  const app=extractInlineScript(html);
  const fragment=app.slice(app.indexOf('const lookupState='),app.indexOf("document.addEventListener('input',e=>{if(e.target.id==='lookup-query')"));
  const escape=app.split('\n').find(line=>line.startsWith('const h='));
  const storage=new Map();let calls=0;
  const ctx=vm.createContext({DB:db,state:{plans:[]},navigator:{onLine:true},hostedBuild:true,location:{protocol:'https:'},document:{getElementById:()=>null},ico:()=>'',ref:()=>'',localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},crops:()=>db.crops,cropBy:id=>db.crops.find(c=>c.id===id),fetch:async()=>{calls++;return Response.json({id:'french-marigold',model:'mock',sections});}});
  vm.runInContext(escape+'\n'+fragment,ctx);
  const run=code=>vm.runInContext(code,ctx);
  assert.equal(run("lookupState.query='tagetes patula';lookupRows()[0].crop.name"),'French marigold');
  assert.match(run("lookupState.id='french-marigold';lookupDetail()"),/Included guide/);assert.equal(calls,0);
  await Promise.all([run("loadLookupAI('french-marigold')"),run("loadLookupAI('french-marigold')")]);assert.equal(calls,1);
  run("lookupCards.clear();navigator.onLine=false");assert.match(run('lookupDetail()'),/Check the roots/);
  await run("loadLookupAI('french-marigold')");assert.equal(calls,1);
  run("lookupCards.clear();localStorage.getItem=()=>{throw Error('private mode')}");
  assert.match(run('lookupDetail()'),/Connect to GardenForge online/);assert.equal(calls,1);
});

test('named guides use an account- and cultivar-specific cache and only send plant names',async()=>{
  const saved=new Map();
  const env={ANTHROPIC_API_KEY:'test',BUCKET:{get:async k=>saved.has(k)?{json:async()=>JSON.parse(saved.get(k))}:null,put:async(k,v)=>saved.set(k,v)}};
  const calls=[];
  const run=(user,data,method='POST')=>handlePlantLookup(request('named',{
    headers:{origin:'https://garden.test','oai-authenticated-user-id':user,'content-type':'application/json'},
    method,body:JSON.stringify(data)
  }),env,catalog,'mock',async(_url,opts)=>{
    const prompt=JSON.parse(JSON.parse(opts.body).messages[0].content);
    calls.push(prompt);return provider();
  });
  const identity={name:'Tomato',scientific:'Solanum lycopersicum',cultivar:'Packet A'};
  for(const bad of [{...identity,notes:'private'}, {...identity,name:''},{...identity,cultivar:'x'.repeat(210)}]){
    assert.equal((await run('named-validation',bad)).status,400);
  }
  assert.equal((await run('named-validation',{...identity,notes:'x'.repeat(2500)})).status,413);
  assert.equal(calls.length,0);
  assert.equal((await run('named-alpha',identity)).status,200);
  assert.equal((await run('named-alpha',{...identity,cultivar:' packet a '})).status,200);
  assert.equal((await run('named-alpha',{...identity,cultivar:'Packet B'})).status,200);
  assert.equal((await run('named-beta',identity)).status,200);
  assert.deepEqual(calls[0],{id:'named',...identity});assert.equal(calls.length,3);
  assert.equal(saved.size,3);
  for(const key of saved.keys())assert.match(key,/^private-plant-guides\/v1\/[a-f0-9]{64}\.json$/);
});

test('old planting labels, parent plants and included cultivar cards resolve independently',()=>{
  const app=extractInlineScript(html);
  const code=app.slice(app.indexOf('const lookupState='),app.indexOf("document.addEventListener('input',e=>{if(e.target.id==='lookup-query')"));
  const parent=db.crops.find(c=>c.id==='tomato');
  const plans=[{id:'old',cropId:'tomato',variety:'Packet One',bedId:''},{id:'known',cropId:'tomato',variety:'San Marzano',bedId:''}];
  const ctx=vm.createContext({DB:db,state:{plans},parent,plans,crops:()=>db.crops,cropBy:id=>db.crops.find(c=>c.id===id),bedBy:()=>null});
  vm.runInContext(code,ctx);const run=s=>vm.runInContext(s,ctx);
  assert.equal(run("lookupState.query='packet one';lookupRows()[0].plan.id"),'old');
  assert.equal(run("lookupState.query='san marzano';lookupRows().length"),1);
  assert.equal(run("guideRequest(parent).route"),'tomato');
  assert.equal(run("guideRequest(parent,plans[0]).route"),'named');
  assert.equal(run("guideRequest(parent,plans[1]).route"),'tomato-san-marzano');
  assert.equal(run("findLookupPlant({scientificName:parent.scientific}).id"),'tomato');
  const entry={version:1,parentId:parent.id,plant:'Tomato',cultivar:'Packet One',scientific:parent.scientific};
  ctx.entry=entry;assert.equal(run('validPlantLookup(entry)'),true);
  assert.equal(run("validPlantLookup({...entry,scientific:{}})"),false);
});

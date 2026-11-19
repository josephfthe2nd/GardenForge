import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleScan,validateInput,validateResult,MODELS,BUILD_VERSION} from '../../server/scan.mjs';
const analysis={identification:'Tomato',scientificName:'Solanum lycopersicum',confidence:.9,uncertain:false,health:'good',summary:'Visible leaves appear intact.',observations:['Green leaves'],possibleCauses:[],nextSteps:['Monitor'],followUpPhotos:[]};
const jpeg='/9j/AAAA';
const input=()=>({images:[{mediaType:'image/jpeg',data:jpeg}],plant:'Tomato',stage:'Seedling',notes:'',escalate:true,plantnet:false,disease:false});
let serial=0;
const req=(body=input(),headers={})=>new Request('https://gardenforge.example/api/scan',{method:'POST',headers:{'content-type':'application/json',origin:'https://gardenforge.example','oai-authenticated-user-id':'test-'+serial++,...headers},body:JSON.stringify(body)});
const response=(a=analysis)=>Response.json({content:[{type:'text',text:JSON.stringify(a)}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:50}});
const env={ANTHROPIC_API_KEY:'test-server-secret'};
test('scan input accepts 1–6 JPEGs and rejects malformed, oversized and extra photos',()=>{assert.ok(validateInput(input()));for(const images of [[],Array(7).fill(input().images[0]),[{mediaType:'image/png',data:jpeg}],[{mediaType:'image/jpeg',data:'evil'}],[{mediaType:'image/jpeg',data:'/9j/'+ 'A'.repeat(1400000)}]])assert.throws(()=>validateInput({...input(),images}));assert.throws(()=>validateInput({...input(),notes:'x'.repeat(2001)}));});
test('output validation rejects non-finite confidence, missing fields and invalid arrays',()=>{assert.deepEqual(validateResult(analysis),analysis);for(const change of [{confidence:NaN},{confidence:2},{uncertain:'no'},{nextSteps:'do it'},{health:'perfect'}])assert.throws(()=>validateResult({...analysis,...change}));});
test('authentication, same-origin, media type, method and missing-secret checks fail closed',async()=>{let calls=0;const f=()=>{calls++;throw Error('must not call');};const anonymous=req();anonymous.headers.delete('oai-authenticated-user-id');assert.equal((await handleScan(anonymous,env,f)).status,401);assert.equal((await handleScan(req(input(),{origin:'https://evil.example'}),env,f)).status,403);assert.equal((await handleScan(req(input(),{'content-type':'text/plain'}),env,f)).status,415);assert.equal((await handleScan(req(),{},f)).status,503);assert.equal((await handleScan(new Request('https://gardenforge.example/api/scan',{headers:{'oai-authenticated-user-id':'u'}}),env,f)).status,405);assert.equal(calls,0);});
test('configuration exposes readiness and model IDs, never secret values',async()=>{const r=await handleScan(new Request('https://gardenforge.example/api/scan/config',{headers:{'oai-authenticated-user-id':'u'}}),{...env,PLANTNET_API_KEY:'plant-secret'});const text=await r.text();assert.ok(!text.includes('secret'));assert.ok(JSON.parse(text).available);assert.equal(r.headers.get('cache-control'),'no-store');});
test('Haiku receives all six photos and only explicitly supplied context',async()=>{const b={...input(),images:Array(6).fill(input().images[0])};const r=await handleScan(req(b),env,async(url,options)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(options.headers['x-api-key'],env.ANTHROPIC_API_KEY);const payload=JSON.parse(options.body);assert.equal(payload.model,MODELS.primary);assert.equal(payload.messages[0].content.filter(x=>x.type==='image').length,6);assert.ok(!options.body.includes(env.ANTHROPIC_API_KEY));return response();});const result=await r.json();assert.equal(r.status,200);assert.equal(result.escalated,false);const {care,...base}=result.analysis;assert.deepEqual(base,analysis);assert.equal(care.pH,'5.8–6.8');});
test('uncertain Haiku escalates once to Sonnet and records both model usages',async()=>{const models=[];const r=await handleScan(req(),env,async(u,o)=>{const m=JSON.parse(o.body).model;models.push(m);return response(m===MODELS.primary?{...analysis,confidence:.5,uncertain:true}:analysis);});const result=await r.json();assert.deepEqual(models,[MODELS.primary,MODELS.escalation]);assert.equal(result.escalated,true);assert.equal(result.attempts.length,2);assert.equal(result.initialAnalysis.confidence,.5);});
test('uncertain health triggers escalation, opt-out prevents it, and failure preserves Haiku with warning',async()=>{let count=0;let r=await handleScan(req({...input(),escalate:false}),env,async()=>{count++;return response({...analysis,health:'uncertain'});});assert.equal(count,1);assert.equal((await r.json()).needsReview,true);count=0;r=await handleScan(req(),env,async()=>++count===1?response({...analysis,health:'uncertain'}):new Response('',{status:503}));const result=await r.json();assert.equal(count,2);assert.equal(result.escalated,false);assert.equal(result.needsReview,true);assert.equal(result.warnings.length,1);});
test('optional plant tools receive at most five photos, failures do not discard Claude result',async()=>{let plantCalls=0;const r=await handleScan(req({...input(),images:Array(6).fill(input().images[0]),plantnet:true,disease:true}),{...env,PLANTNET_API_KEY:'plant-key'},async(u,o)=>{if(u.includes('plantnet.org')){plantCalls++;assert.equal(o.body.getAll('images').length,5);assert.equal(o.body.getAll('organs').length,5);if(u.includes('diseases'))throw Error('timeout');return Response.json({results:[{score:.8,species:{scientificNameWithoutAuthor:'Solanum lycopersicum'}}]});}return response();});const result=await r.json();assert.equal(plantCalls,2);assert.equal(result.specialist[0].imageCount,5);assert.equal(result.warnings.length,1);});
test('provider failures, malformed JSON and truncated output become useful non-secret errors',async()=>{for(const f of [async()=>new Response('secret-provider-error',{status:401}),async()=>Response.json({content:[{type:'text',text:'not json'}]}),async()=>Response.json({stop_reason:'max_tokens'}),async()=>{throw Error('secret-provider-error');}]){const r=await handleScan(req(),env,f);assert.ok(r.status>=500);assert.ok(!(await r.text()).includes('secret-provider-error'));}});
test('oversized body rejected before provider call and burst guard limits repeated requests',async()=>{let r=await handleScan(req(input(),{'content-length':String(10*1024*1024)}),env,()=>{throw Error();});assert.equal(r.status,413);for(let i=0;i<5;i++){r=await handleScan(req(input(),{'oai-authenticated-user-id':'rate-user'}),env,async()=>response());assert.equal(r.status,i===4?429:200);}});

test('care context reaches the provider; reviewed facts replace model-supplied zone and pH',async()=>{
 const care={watering:'Check moisture first.',wateringCheck:'Check each morning; water only if needed.',wateringMethod:'Water the root zone.',sunlight:'Full sun',soil:'Well drained',feeding:'Check soil test',seasonal:'Adjust to weather',zone:'99z',pH:'99',reference:{url:'javascript:alert(1)'}};
 const r=await handleScan(req({...input(),gardenZone:'10a',growingLocation:'container'}),env,async(u,o)=>{const payload=JSON.parse(o.body);const context=JSON.parse(payload.messages[0].content.at(-1).text);assert.equal(context.growingContext.gardenZone,'10a');assert.equal(context.growingContext.growingLocation,'container');assert.equal(payload.max_tokens,3500);return response({...analysis,care});});
 const c=(await r.json()).analysis.care;
 assert.equal(c.zone,'Frost-sensitive seasonal crop');assert.equal(c.pH,'5.8–6.8');assert.equal(c.wateringCheck,care.wateringCheck);assert.equal(c.reference.url,'https://plants.ces.ncsu.edu/plants/solanum-lycopersicum/');assert.equal(c.context.growingLocation,'container');
});
test('unknown or uncertain species receive no invented reference, zone, or pH',async()=>{
 for(const changes of [{scientificName:'Unknown species'},{uncertain:true},{confidence:.3},{scientificName:'Quercus sp.'}]){
  const r=await handleScan(req({...input(),escalate:false}),env,async()=>response({...analysis,...changes}));const c=(await r.json()).analysis.care;
  assert.equal(c.reference,null);assert.match(c.zone,/Not yet verified/);assert.match(c.pH,/Not verified/);
 }
});
test('malformed care degrades safely without losing the health result; context validation is bounded',async()=>{
 const r=await handleScan(req(),env,async()=>response({...analysis,care:{watering:'x'.repeat(9000)}}));assert.equal(r.status,200);assert.ok((await r.json()).analysis.care.wateringCheck);
 for(const change of [{gardenZone:'<script>'},{gardenZone:'14a'},{growingLocation:'http://private'}])assert.throws(()=>validateInput({...input(),...change}));
});

test('every model request uses constrained JSON output with required scan and care fields',async()=>{
 let calls=0;const r=await handleScan(req(),env,async(u,o)=>{calls++;const f=JSON.parse(o.body).output_config.format;assert.equal(f.type,'json_schema');assert.equal(f.schema.additionalProperties,false);assert.ok(f.schema.required.includes('scientificName'));assert.ok(f.schema.required.includes('care'));assert.deepEqual(f.schema.properties.health.enum,['good','concern','uncertain']);assert.equal(f.schema.properties.care.additionalProperties,false);assert.ok(!/"(?:maxLength|minimum|maximum|maxItems)":/.test(JSON.stringify(f.schema)));return response({...analysis,confidence:.5});});assert.equal(r.status,200);assert.equal(calls,2);
});
test('invalid Haiku output reaches enabled Sonnet review once and accounts for failed usage',async()=>{
 for(const first of [response({...analysis,scientificName:null}),Response.json({content:[{type:'text',text:'broken JSON'}],usage:{input_tokens:50,output_tokens:10}}),Response.json({stop_reason:'max_tokens',content:[],usage:{input_tokens:50,output_tokens:10}})]){
  const models=[];const r=await handleScan(req(),env,async(u,o)=>{models.push(JSON.parse(o.body).model);return models.length===1?first:response();});const data=await r.json();assert.equal(r.status,200);assert.deepEqual(models,[MODELS.primary,MODELS.escalation]);assert.equal(data.escalated,true);assert.equal(data.initialAnalysis,null);assert.equal(data.attempts.length,2);assert.equal(data.attempts[0].status,'invalid-format');assert.match(data.warnings[0],/unusable response/);assert.equal(data.analysis.identification,'Tomato');
 }
});
test('format recovery respects review opt-out and never retries provider refusals',async()=>{
 let calls=0;let r=await handleScan(req({...input(),escalate:false}),env,async()=>{calls++;return response({...analysis,nextSteps:null});});assert.equal(r.status,502);assert.equal(calls,1);
 calls=0;r=await handleScan(req(),env,async()=>{calls++;return Response.json({stop_reason:'refusal',content:[{type:'text',text:'private refusal text'}]});});assert.equal(r.status,422);assert.equal(calls,1);assert.ok(!(await r.text()).includes('private refusal text'));
});
test('health enum casing is normalized without guessing invalid values',()=>{assert.equal(validateResult({...analysis,health:'Good'}).health,'good');assert.equal(validateResult({...analysis,health:' CONCERN '}).health,'concern');assert.throws(()=>validateResult({...analysis,health:'perfect'}));assert.throws(()=>validateResult({...analysis,confidence:80}));});

test('server release version matches the frontend update indicator',()=>{const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');assert.equal(html.match(/const APP_VERSION='([^']+)'/)[1],BUILD_VERSION);});

test('both models request a short health observation and per-candidate photo evidence',async()=>{
 const matches=[{name:'Tagetes patula',evidence:'Photo 1 shows a bicolored flower head.'}];
 const expected={...analysis,healthObservation:'A few tips look dry.',matches,confidence:.6};
 const r=await handleScan(req(),env,async(_,options)=>{
   const schema=JSON.parse(options.body).output_config.format.schema;
   assert.ok(schema.required.includes('matches')&&schema.required.includes('healthObservation'));
   assert.deepEqual(schema.properties.matches.items.required,['name','evidence']);
   return response(expected);
 });
 const saved=await r.json();
 assert.equal(saved.escalated,true);assert.deepEqual(saved.analysis.matches,matches);
 assert.equal(saved.analysis.healthObservation,expected.healthObservation);
 assert.throws(()=>validateResult({...analysis,matches:[{name:'Rose',evidence:null}]}));
});

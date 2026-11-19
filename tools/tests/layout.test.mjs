
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {ROOT,fixture,extractInlineScript} from './helpers.mjs';

const html=fs.readFileSync(ROOT+'/index.html','utf8');
const code=extractInlineScript(html);
const reference=html.match(/<script id="reference-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
const init=code.slice(code.indexOf('const DB='),code.indexOf('let state=defaultState()'));
const lookups=['crops','cropBy','bedBy','cropName'].map(n=>code.split('\n').find(line=>line.startsWith('function '+n+'('))).join('\n');

function garden(){
 const records=new Map(),messages=[];
 const context=vm.createContext({
   fixture:structuredClone(fixture),crypto:{randomUUID},toast:m=>messages.push(m),closeDialog(){},render(){},confirm:()=>true,
   document:{addEventListener(){},getElementById:()=>({textContent:reference})},
   localStorage:{getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)}
 });
 const run=code=>vm.runInContext(code,context);
 run(init+lookups+`
   let state=validateState(fixture),failSave=false;
   function save(){if(failSave)return false;localStorage.setItem(KEY,JSON.stringify(state));return true;}
   function start(){layoutDraft=layoutStart(layoutBase(18,12,'ell',6,4));return layoutDraft.map;}
   function mapped(){const map=start();layoutPlaceBed('bed_a');layoutBed='bed_a';layoutLayer='crops';
     const record=state.plans[0];layoutAdd({id:record.id,bedId:layoutBed,name:cropName(record),source:layoutPlanFields(record),w:1,h:1});return map;}
 `);
 return {run,records,messages};
}

test('measured L excludes its cutout, accepts a bed spanning both arms and counts overlapping sections once',()=>{
 const {run}=garden();
 assert.equal(run("const m=start();layoutArea(m.areas)"),192);
 assert.equal(run("m.areas.push({...m.areas[0],id:'extra'});layoutArea(m.areas)"),192);
 assert.equal(run("layoutPlaceBed('bed_a');const bed=m.spaces[0];bed.x=1;bed.y=2;layoutIssue(m)"),'');
 assert.match(run("bed.x=10;layoutIssue(m)"),/outside/);
 assert.throws(()=>run("layoutBase(4,8,'ell',4,1)"),/cutout/);
 assert.match(run("layoutIssue(layoutBase(8,6,'blank'))"),/ground section/);
});

test('rotation changes a bed footprint and preserves the crop coordinate system',()=>{
 const {run}=garden();
 assert.equal(run("const m=mapped();const bed=m.spaces[0];bed.x=13;bed.y=4;layoutIssue(m)").includes('outside'),true);
 assert.equal(run("bed.turned=true;layoutIssue(m)"),'');
 assert.equal(run("m.patches[0].x=7;layoutIssue(m)"),'');
 assert.match(run("m.patches[0].x=8;layoutIssue(m)"),/outside its growing space/);
});

test('overlaps and invalid measurements block application',()=>{
 const {run}=garden();
 assert.match(run("const m=mapped();m.spaces.push({...m.spaces[0],id:'b2',name:'Another bed'});layoutIssue(m)"),/overlaps/);
 assert.match(run("m.spaces.pop();m.patches.push({...m.patches[0],id:'p2'});layoutIssue(m)"),/crop blocks overlap/);
 assert.throws(()=>run("validateLayoutMap({...m,w:-1})"),/Invalid garden layout/);
});

test('drafts survive closing without modifying growing spaces or plantings',()=>{
 const {run}=garden();
 assert.equal(run("mapped();layoutStore();!state.settings.gardenLayout&&state.beds.length===1"),true);
 assert.equal(run("layoutDraft=null;layoutRestore()&&layoutDraft.map.patches[0].id==='plant_1'"),true);
 assert.equal(run("layoutReset();layoutDraft===null&&localStorage.getItem(layoutKey())===null&&!state.settings.gardenLayout"),true);
});

test('applying adds a measured bed and crop while preserving existing chronology, metadata and IDs',()=>{
 const {run}=garden();
 const result=JSON.parse(run(`
   const m=mapped();layoutLayer='spaces';layoutAdd({id:'new_bed',name:'Patio',type:'Rectangular planter',w:3,h:2,depth:8,turned:false});
   layoutBed='new_bed';layoutLayer='crops';m.patches[0].bedId='new_bed';
   layoutAdd({id:'new_crop',name:'Basil',bedId:'new_bed',w:1,h:1,seed:{cropId:'basil',count:2,date:'2026-11-19'}});
   const result=layoutCandidate(layoutDraft,state);JSON.stringify(result);`));
 assert.equal(result.schemaVersion,1);
 assert.deepEqual(result.beds[0],fixture.beds[0]);
 assert.deepEqual(result.plans[0],{...fixture.plans[0],bedId:'new_bed'});
 assert.deepEqual(result.plans[1],fixture.plans[1]);
 assert.deepEqual(result.logs,fixture.logs);
 assert.equal(result.plans[2].id,'new_crop');assert.equal(result.plans[2].count,2);
 assert.equal(result.settings.gardenLayout.patches.length,2);
 assert.ok(!JSON.stringify(result.settings.gardenLayout).includes('source'));
 assert.equal(run("state=result;layoutStart(validateState(JSON.parse(JSON.stringify(result))).settings.gardenLayout).map.patches[1].name"),'Basil');
});

test('a removed map block keeps its saved records and deleted garden records are never recreated',()=>{
 const {run}=garden();
 assert.equal(run("const m=mapped();m.spaces=[];m.patches=[];const next=layoutCandidate(layoutDraft,state);JSON.stringify(next.plans)===JSON.stringify(state.plans)&&next.beds.length===state.beds.length"),true);
 assert.equal(run("mapped();const map=layoutGeometry(layoutDraft.map);state.beds=[];layoutStart(map).map.spaces.length"),0);
 assert.throws(()=>run("layoutCandidate(layoutDraft,state)"),/record for/);
});

test('stale layouts and reassigned plantings are detected; unrelated journal edits survive',()=>{
 const {run}=garden();
 assert.equal(run("mapped();state.logs[0].notes='Changed';layoutCandidate(layoutDraft,state).logs[0].notes"),'Changed');
 assert.throws(()=>run("state.plans[0].bedId='elsewhere';layoutCandidate(layoutDraft,state)"),/planting for/);
 assert.throws(()=>run("state.settings.gardenLayout=layoutBase(1,1,'rectangle');layoutCandidate(layoutDraft,state)"),/saved layout changed/);
});

test('a failed save retains the draft and the original garden; a retry applies exactly once',()=>{
 const {run,messages}=garden();
 assert.equal(run("mapped();layoutStore();failSave=true;layoutCommit();!state.settings.gardenLayout&&!!layoutDraft"),true);
 assert.match(messages.at(-1),/could not be saved/);
 assert.equal(run("failSave=false;layoutCommit();state.settings.gardenLayout.version===1&&layoutDraft===null&&state.plans.length===2"),true);
});

test('a competing browser tab cannot replace a newer draft or a newer saved garden',()=>{
 const {run,messages}=garden();
 assert.equal(run("mapped();layoutStore();localStorage.setItem(layoutKey(),'other draft');layoutStore()"),false);
 assert.equal(run("layoutCommit();localStorage.getItem(layoutKey())"),'other draft');
 assert.match(messages.at(-1),/Another tab/);
 assert.equal(run("layoutReset();localStorage.getItem(layoutKey())"),'other draft');
 run("localStorage.removeItem(layoutKey());mapped();layoutStore();localStorage.setItem(KEY,JSON.stringify({...state,updatedAt:'newer'}));layoutCommit()");
 assert.match(messages.at(-1),/Another tab/);
 assert.equal(run('Boolean(layoutDraft)&&!state.settings.gardenLayout'),true);
});


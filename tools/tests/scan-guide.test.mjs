
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ROOT,extractInlineScript} from './helpers.mjs';

const app=extractInlineScript(fs.readFileSync(ROOT+'/index.html','utf8'));
function render(code,input){
 const context=vm.createContext({input,scanDraft:{images:[]},state:{plans:[]},ico:()=>'',iconPaths:{}});
 const escape=app.split('\n').find(line=>line.startsWith('const h='));
 const helpers=app.slice(app.indexOf("let scanView='capture'"),app.indexOf('function renderScan(){'));
 const care=app.slice(app.indexOf('function careIcon('),app.indexOf('function scanCareReminder()'));
 return vm.runInContext(escape+'\n'+helpers+care+'\n'+code,context);
}
const old={analysis:{identification:'French marigold (likely), growing in a pot',scientificName:'Tagetes patula',confidence:.6,uncertain:true,health:'concern',summary:'Long description.',observations:['The leaf tips are dry.'],followUpPhotos:[]},model:'saved',createdAt:'2026-11-01',specialist:[{provider:'Pl@ntNet identification',results:[{name:'Tagetes tenuifolia',score:.3}],imageCount:1}],warnings:[]};
test('old scans open with available evidence, conservative care cards and a useful follow-up',()=>{
 const html=render('scanResultHTML(input)',old);
 assert.match(html,/data-scan-heading>French marigold</);assert.match(html,/The leaf tips are dry/);
 assert.match(html,/predates care profiles/);assert.match(html,/Set a moisture-check reminder/);
 assert.equal((html.match(/class="care-card(?: |")/g)||[]).length,4);
 const comparison=render('scanCompareHTML(input)',old);
 assert.match(comparison,/Tagetes tenuifolia/);assert.match(comparison,/No photo-specific explanation/);
 assert.match(comparison,/daylight close-up of one open flower/);
});
test('new comparisons escape per-match evidence and exclude disease checks from plant candidates',()=>{
 const scanned={...old,analysis:{...old.analysis,matches:[{name:'Tagetes patula',evidence:'Photo 1 <leaf>'}],followUpPhotos:['Photograph the flower in daylight.']},specialist:[{provider:'Pl@ntNet disease check',results:[{name:'Disease X'}]}]};
 const html=render('scanCompareHTML(input)',scanned);
 assert.match(html,/Photo 1 &lt;leaf&gt;/);assert.match(html,/flower in daylight/);assert.doesNotMatch(html,/Disease X/);
});
test('prices follow selected checks and custom models never inherit default model prices',()=>{
 const fields={escalate:true,plantnet:true,disease:true};
 assert.match(render('scanPriceHTML(input,{plantnet:true})',fields),/\$0\.012/);
 assert.match(render('scanPriceHTML(input,{plantnet:true})',fields),/2 quota credits/);
 assert.doesNotMatch(render("scanPriceHTML(input,{primary:'custom',escalation:'other'})",fields),/\$0\./);
 assert.match(render('scanPriceHTML(input,{})',{escalate:false}),/review is off/);
});


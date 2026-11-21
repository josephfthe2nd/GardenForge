import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function careIcon('),html.indexOf('function legacyScanCare('));
const ctx=vm.createContext({h:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),validDate:s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s)),today:()=> '2026-11-21',pretty:s=>s,addDays:(s,n)=>new Date(Date.parse(s+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),state:{plans:[]}});
vm.runInContext(source,ctx);
const run=s=>vm.runInContext(s,ctx);
test('pH ranges are bounded and unsupported prose never invents a meter reading',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(run("phRange('pH 5.8–6.8')"))),{lo:5.8,hi:6.8});
 for(const text of ['not recorded','slightly acidic','6','-1–6','6–15','7–5','5–6 or 7–8','<img src=x>']){ctx.value=text;assert.equal(run('phRange(value)'),null);}
 assert.match(run("phMeterHTML('5.8–6.8','Extension reference')"),/Not a measured soil reading/);
 assert.match(run("phMeterHTML('Not recorded')"),/no marker shown/);
 assert.ok(!run("phMeterHTML('<img src=x>')").includes('<img'));
});
test('growth uses saved outdoor timing including future and overdue plantings',()=>{
 const cases=[['2026-11-11',10],['2026-11-25',-4],['2026-01-01',324]];
 for(const [date,day] of cases){ctx.timing={id:'plant_a',date,harvestMin:30,harvestMax:45};assert.equal(run('plantGrowthData(timing).day'),day);assert.equal(run('plantGrowthData(timing).window.hi'),45);}
 assert.match(run('plantGrowthHTML(timing)'),/past the stored estimate/);
 ctx.timing={date:'2026-11-25',harvestMin:30,harvestMax:30};assert.match(run('plantGrowthHTML(timing)'),/Planting is in 4 days/);
 ctx.timing={harvestMin:null,harvestMax:null};assert.match(run('plantGrowthHTML(timing)'),/No maturity window/);assert.doesNotMatch(run('plantGrowthHTML(timing)'),/growth-timeline/);
 for(const values of [[50,40],[-1,30],[5,1001]]){ctx.timing={harvestMin:values[0],harvestMax:values[1]};assert.equal(run('plantGrowthData(timing).window'),null);}
});
test('heights convert inches to centimetres, retain originals, sort and omit missing measurements',()=>{
 ctx.timing={id:'plant_a',date:'2026-11-10',harvestMin:30,harvestMax:50};
 ctx.photos=[{createdAt:'2026-11-20T12:00:00Z',height:'2',heightUnit:'in'},{createdAt:'2026-11-11T12:00:00Z',height:'3',heightUnit:'cm'},{createdAt:'2026-11-12',height:'',heightUnit:'cm'},{createdAt:'bad',height:'10',heightUnit:'cm'},{createdAt:'2026-11-12',height:'-1',heightUnit:'cm'},{createdAt:'2026-11-12',height:'20',heightUnit:'ft'}];
 const result=JSON.parse(JSON.stringify(run('plantGrowthData(timing,photos)')));
 assert.deepEqual(result.points.map(p=>[p.day,p.cm]),[[1,3],[10,5.08]]);
 const svg=run('plantGrowthHTML(timing,photos)');assert.match(svg,/2 in/);assert.match(svg,/3 cm/);assert.match(svg,/connecting lines do not predict growth/);assert.doesNotMatch(svg,/NaN|undefined/);
 assert.match(run('plantGrowthHTML(timing,[])'),/Add a progress photo/);assert.doesNotMatch(run('plantGrowthHTML(timing,[])'),/polyline/);
});
test('flower timeline labels bloom and keeps catalog timing relative',()=>{
 ctx.timing={group:'Flower',harvestMin:50,harvestMax:60,source:'rgv'};const markup=run('plantGrowthHTML(timing)');
 assert.match(markup,/First blooms/);assert.match(markup,/Day 50/);assert.match(markup,/Regional guide estimate/);assert.doesNotMatch(markup,/Today · day/);
});
test('all standalone SVG assets are offline-cached and included in the worker build',()=>{
 const sw=fs.readFileSync(new URL('../../sw.js',import.meta.url),'utf8'),build=fs.readFileSync(new URL('../build-site.mjs',import.meta.url),'utf8');
 for(const name of ['water','sun','care','soil','zone','health','ph']){
  const file='care-'+name+'.svg',asset=fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8');
  assert.match(asset,/<svg.*viewBox="0 0 24 24"/);assert.doesNotMatch(asset,/<script|href=|onload=/);assert.ok(sw.includes(file));assert.ok(build.includes("'"+name+"'"));
 }
});

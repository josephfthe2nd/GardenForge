import json
s=lambda n:'x'*n
L=dict(cand=3,ev=4,feat=160,conf=3,rule=3,chk=160,look=3,name=80,obs=6,find=200,nv=5,nvl=160,cc=3,ccl=200,nc=5,ncc=160,ncw=160,ra=3,ral=160,ans=500,iq=6,issues=3,hs=300,ctr=300)
def build(L):
  return {"schemaVersion":"gf-assessment-1","mode":"identify_pest_or_disease",
  "imageQuality":[{"imageLabel":"Reference R1","usable":"limited","showsRequestedView":False,"issues":["subject_cut_off"]*L['issues']}]*L['iq'],
  "candidates":[{"name":s(L['name']),"scientificName":s(L['name']),"kind":"abiotic_or_environmental","confidence":0.55,
     "visualEvidence":[{"imageLabel":"Image 5","feature":s(L['feat'])}]*L['ev'],
     "wouldConfirm":[s(L['chk'])]*L['conf'],"wouldRuleOut":[s(L['chk'])]*L['rule'],"lookalikes":[s(L['name'])]*L['look']}]*L['cand'],
  "observations":[{"imageLabel":"Image 5","part":"stem_base_or_crown","finding":s(L['find'])}]*L['obs'],
  "healthSummary":{"status":"needs_attention","summary":s(L['hs'])},
  "overallUncertainty":"cannot_tell","cannotTellReason":s(L['ctr']),
  "notVisible":[s(L['nvl'])]*L['nv'],"contextConflicts":[s(L['ccl'])]*L['cc'],
  "nextChecks":[{"check":s(L['ncc']),"why":s(L['ncw'])}]*L['nc'],
  "retakeAdvice":[{"slot":"affected_closeup","reason":s(L['ral'])}]*L['ra'],
  "answerToQuestion":s(L['ans'])}
d=build(L); n=len(json.dumps(d,separators=(',',':')).encode()); print('worst',n)
c1=sum(len(json.dumps(x,separators=(',',':'))) for x in d['candidates'][:1]); print('one cand',c1)
# typical: half lengths
L2={k:(max(1,v//2) if k not in('cand','ev','iq') else v) for k,v in L.items()}; L2['cand']=2; L2['ev']=2; L2['iq']=3
print('typical-ish',len(json.dumps(build(L2),separators=(',',':')).encode()))
F=dict(L); F.update(ans=300,obs=3,cand=1,ev=2,conf=2,rule=2,nv=2,cc=2,nc=2)
print('after full fit',len(json.dumps(build(F),separators=(',',':')).encode()))
F2=dict(L); F2.update(ans=300,obs=3,cand=2)
print('after steps1-3',len(json.dumps(build(F2),separators=(',',':')).encode()))
F3=dict(F2); F3.update(ev=2,conf=2,rule=2)
print('after step4',len(json.dumps(build(F3),separators=(',',':')).encode()))
F5=dict(F3); F5.update(nv=2,cc=2,nc=2)
print('after step5',len(json.dumps(build(F5),separators=(',',':')).encode()))

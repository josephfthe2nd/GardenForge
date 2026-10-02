import math, json
def tok(w,h): return math.ceil(w/28)*math.ceil(h/28)
print('1600x1200', tok(1600,1200), 'haiku 1269x952', tok(1269,952), '1600sq', tok(1600,1600), '2212x1659', tok(2212,1659), 2212*1659/1e6, '1024x768', tok(1024,768))
print('approx /750', 1600*1200/750)
P={'opus':(4,20,2494,2400),'sonnet':(2,10,2494,2100),'haiku':(1,5,1564,900)}
TEXT=2550; LABEL=45; WORST=8000
def cost(m,n,prior=0,out=None):
    pi,po,it,o=P[m]; o=o if out is None else out
    inp=TEXT+(n+prior)*(it+LABEL)
    return inp,o,inp*pi/1e6, o*po/1e6, inp*pi/1e6+o*po/1e6
for m in P:
    for n,pr in [(1,0),(3,0),(3,1),(5,0),(5,1)]:
        i,o,ci,co,t=cost(m,n,pr); print(m,n,pr,i,o,round(ci,4),round(co,4),round(t,4))
    for n,pr in [(3,0),(5,1)]:
        i,o,ci,co,t=cost(m,n,pr,WORST); print(' worst',m,n,pr,i,round(t,4))
    t3=cost(m,3)[4]
    print(' month', m, [round(k*t3,2) for k in (4,10,30)], 'cap5 calls', round(5/t3,1))

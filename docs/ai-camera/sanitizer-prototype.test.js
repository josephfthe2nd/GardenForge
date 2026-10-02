const {sanitize}=require('./sanitizer-prototype.js');
const keep=["I counted 3 hornworms per plant.","1 cup-shaped leaf is curled.","5 mm lesions with a yellow edge.","Look with a 10x hand lens.","About 30% of leaves are spotted.","Copper deficiency","Sulfur deficiency cannot be confirmed from photos.","Ask AgriLife Extension for a soil test."];
const drop=["Spray neem oil at 2 tbsp per gallon weekly.","Side-dress with 10-10-10.","Consider using copper fungicide if it spreads.","Mix 1 oz per gallon.","Apply Sevin® dust.","Add calcium nitrate to the bed.","Use a 2% solution."];
let bad=0;
for(const k of keep){const r={removedCount:0,categories:[],fieldPaths:[]};sanitize({x:k},"",r,"x");if(r.removedCount){bad++;console.log("WRONGLY REMOVED:",k)}}
for(const k of drop){const r={removedCount:0,categories:[],fieldPaths:[]};sanitize({x:k},"",r,"x");if(!r.removedCount){bad++;console.log("MISSED:",k)}}
console.log(bad?"FAIL "+bad:"all "+(keep.length+drop.length)+" cases pass");

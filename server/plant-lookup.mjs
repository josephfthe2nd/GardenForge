// Only public, build-time catalog entries may be sent to the text model.
const cardFields = ['watering','light','soil','season'];
const pendingCards = new Map();
const cardRate = new Map();
const cardReply = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
const cardError = (status,message) => Object.assign(new Error(message),{status});
function validCard(card,id) {
  return card?.id===id && typeof card.model==='string' && cardFields.every(key=>
    typeof card.sections?.[key]==='string' && card.sections[key].trim() && card.sections[key].length<=800);
}
async function generatePlantCard(plant,env,model,fetcher) {
  const schema={type:'object',additionalProperties:false,required:cardFields,
    properties:Object.fromEntries(cardFields.map(key=>[key,{type:'string'}]))};
  const response=await fetcher('https://api.anthropic.com/v1/messages',{method:'POST',
    headers:{'content-type':'application/json','x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    signal:AbortSignal.timeout(35000),
    body:JSON.stringify({model,max_tokens:900,
      system:'Write a short general garden care guide for this catalog entry. For each field give one or two practical sentences. Water according to root-zone moisture. For grouped plants distinguish cultivar and species variation. Mention winter or seasonal sensitivity where known. Do not invent zone ranges, dates, pH targets, current weather, sources or a diagnosis of an individual plant.',
      output_config:{format:{type:'json_schema',schema}},messages:[{role:'user',content:JSON.stringify(plant)}]})});
  if(!response.ok)throw cardError(response.status===429?429:502,'The guide provider is unavailable. The included guide is still available.');
  const data=await response.json();
  if(data.stop_reason!=='end_turn')throw cardError(502,'The provider returned an incomplete card.');
  const sections=JSON.parse((data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join(''));
  const card={id:plant.id,model,sections:Object.fromEntries(cardFields.map(k=>[k,sections[k]])),createdAt:new Date().toISOString()};
  if(!validCard(card,plant.id))throw cardError(502,'The provider returned an incomplete card.');
  return card;
}
export async function handlePlantLookup(request,env,catalog,defaultModel,fetcher=fetch) {
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/plant-card/'))return null;
  const user=request.headers.get('oai-authenticated-user-id');
  if(!user)return cardReply({error:'Sign in to use the optional AI guide.'},401);
  if(request.method!=='POST')return cardReply({error:'Use POST.'},405);
  if(request.headers.get('origin')!==url.origin)return cardReply({error:'Open this guide from GardenForge.'},403);
  const plant=catalog.find(p=>p.id===url.pathname.slice('/api/plant-card/'.length));
  if(!plant||request.body)return cardReply({error:'Select an included plant.'},400);
  const key='plant-guides/v1/'+plant.id+'.json';
  try{
    if(env.BUCKET){
      const object=await env.BUCKET.get(key);
      if(object){const card=await object.json();if(validCard(card,plant.id))return cardReply(card);}
    }
    if(!env.ANTHROPIC_API_KEY)return cardReply({error:'AI guides are unavailable. The included guide is ready to use.'},503);
    if(!pendingCards.has(key)){
      const now=Date.now();
      for(const [id,bucket] of cardRate)if(now-bucket.start>=60000)cardRate.delete(id);
      const bucket=cardRate.get(user)||{start:now,count:0};
      if(bucket.count>=4)return cardReply({error:'Please wait a minute before requesting another AI guide.'},429);
      bucket.count++;cardRate.set(user,bucket);
      const promise=generatePlantCard(plant,env,env.ANTHROPIC_HAIKU_MODEL||defaultModel,fetcher).then(async card=>{
        if(env.BUCKET)await env.BUCKET.put(key,JSON.stringify(card),{httpMetadata:{contentType:'application/json'}}).catch(()=>{});
        return card;
      }).finally(()=>pendingCards.delete(key));
      pendingCards.set(key,promise);
    }
    return cardReply(await pendingCards.get(key));
  }catch(err){return cardReply({error:err.status?err.message:'Could not load the AI guide. The included guide is still available.'},err.status||502);}
}

/** Explicit recovery from a missing inapplicable formatPass; preserve all raw judgments. */
import fs from 'node:fs';import path from 'node:path';
const out=path.resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Review directory required');
const read=n=>JSON.parse(fs.readFileSync(path.join(out,n))),write=(n,x)=>fs.writeFileSync(path.join(out,n),JSON.stringify(x,null,2));
const protocol=read('protocol.json'),items=read('blinded-input.json'),mapping=read('mapping.json');
if(protocol.complete||protocol.error!=='Format type'||fs.existsSync(path.join(out,'recovery.json')))throw Error('Only one explicit Format type recovery supported');
write('interrupted-protocol.json',protocol);fs.copyFileSync(path.join(out,'reviews.json'),path.join(out,'interrupted-reviews.json'));
const recovered=[],normalizations=[];
function accept(payload,batch){
 if(payload.choices[0].finish_reason!=='stop')throw Error('Truncated judge response');
 const parsed=JSON.parse(payload.choices[0].message.content);if(!Array.isArray(parsed.reviews)||parsed.reviews.length!==batch.length)throw Error('Invalid count');
 for(const item of batch){const matched=parsed.reviews.filter(r=>r.id===item.id);if(matched.length!==1)throw Error('Invalid id');const j={...matched[0]};
  for(const k of ['factCorrect','boundaryRespect','unsupported'])if(typeof j[k]!=='boolean')throw Error('Invalid fact type');
  if(j.formatPass===undefined&&item.formatRule===null){j.formatPass=null;normalizations.push({id:item.id,field:'formatPass',value:null,reason:'No format rule applies; raw judge omitted this inapplicable field. No factual judgment changed.'});}
  if(j.formatPass!==null&&typeof j.formatPass!=='boolean')throw Error('Invalid applicable format');
  if(recovered.some(r=>r.id===j.id))throw Error('Duplicate reviewed id');
  recovered.push({...mapping.find(m=>m.id===j.id),...j,semanticPass:!item.error&&j.factCorrect&&j.boundaryRespect&&!j.unsupported});
 }
}
for(const line of fs.readFileSync(path.join(out,'calls.jsonl'),'utf8').trim().split('\n')){const call=JSON.parse(line),batch=JSON.parse(call.request.messages[1].content);accept(call.response,batch);}
const recovery={reason:'Explicit continuation after omitted inapplicable formatPass. All raw responses preserved, no prior batch rerun.',recoveredFromRaw:recovered.length,normalizations};write('recovery.json',recovery);
const settings=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'../../data/db/settings.json'))),provider=settings.provider,key=settings.apiKeys?.[provider],base=settings.baseUrls?.[provider]||'https://api.deepseek.com/v1';if(!key)throw Error('Configured key required');
const remaining=items.filter(i=>!recovered.some(r=>r.id===i.id));delete protocol.error;
try{for(let i=0;i<remaining.length;i+=4){const batch=remaining.slice(i,i+4),request={model:protocol.model,messages:[{role:'system',content:protocol.criteria},{role:'user',content:JSON.stringify(batch)}],...protocol.params,response_format:{type:'json_object'}},start=Date.now();
 const r=await fetch(base.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(request),signal:AbortSignal.timeout(100000)});if(!r.ok)throw Error('Judge HTTP '+r.status);const payload=await r.json(),response={choices:payload.choices,usage:payload.usage,model:payload.model};fs.appendFileSync(path.join(out,'calls.jsonl'),JSON.stringify({request,response,elapsedMs:Date.now()-start,recovery:true})+'\n');accept(response,batch);write('reviews.json',recovered);console.log(`${recovered.length}/${items.length} reviewed`);}
 protocol.complete=true;
}catch(e){protocol.complete=false;protocol.error=e.message;process.exitCode=1;}finally{
 protocol.completed=recovered.length;protocol.recovery='recovery.json';write('protocol.json',protocol);write('reviews.json',recovered);write('recovery.json',recovery);
 const stats=[];for(const dataset of ['v1','v2'])for(const variant of [...new Set(mapping.filter(r=>r.dataset===dataset).map(r=>r.variant))]){const rs=recovered.filter(r=>r.dataset===dataset&&r.variant===variant);stats.push({dataset,variant,n:rs.length,semanticPass:rs.filter(r=>r.semanticPass).length,factual:rs.filter(r=>r.factCorrect).length,boundary:rs.filter(r=>r.boundaryRespect).length,unsupported:rs.filter(r=>r.unsupported).length,formatApplicable:rs.filter(r=>r.formatPass!==null).length,formatPass:rs.filter(r=>r.formatPass===true).length});}write('summary.json',{complete:protocol.complete,reviewer:protocol.reviewer,independentHumanReview:false,stats});
}

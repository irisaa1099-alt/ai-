import {CHARACTER_TEMPLATES,templateToCharacter} from '../../data/contest-templates.js';
import * as store from '../../core/store.js';
import * as prompt from '../../core/prompt.js';
import * as group from '../../core/group.js';
import {heardGroupMessage} from '../../core/recent.js';
import {chat} from '../../core/llm.js';
import {makeMemorySource,mergeExtractedMemory} from '../../core/memory.js';
import {correctRelatedMemoryFacts} from '../../core/memory-correction.js';
let config, fixture;
export function configure(c){config=c;store.setSettings({onboarded:true,provider:c.provider,model:c.model,apiKeys:{[c.provider]:'EVALUATION_LOCAL_BRIDGE'},baseUrls:{[c.provider]:`${location.origin}/model/v1`},useProxy:false,params:c.params,user:{name:'小澄'},proactive:{enabled:false},voice:{enabled:false},context:{summary:true,summaryKeep:2,maxMessages:8,budgetTokens:4000,timeAware:false,affinity:false}});}
export async function answer(messages,params=config.params){const r=await chat({provider:config.provider,model:config.model,apiKey:'EVALUATION_LOCAL_BRIDGE',baseUrl:`${location.origin}/model/v1`,useProxy:false,messages,params,stream:false,totalTimeoutMs:110000});return {text:r.text,finishReason:r.finishReason,truncated:r.truncated,model:r.model};}
export async function prepare(s,key){
 const prefix=`v2_${key}`;const a=await store.saveCharacter({id:prefix+'_a',...(s.neutralPersona?templateToCharacter(CHARACTER_TEMPLATES[1]):{}),id:prefix+'_a',name:s.neutralPersona?'周予':'林青',greeting:[],persona:s.neutralPersona?templateToCharacter(CHARACTER_TEMPLATES[1]).persona:{personality:'细致，尊重证据',speech:'自然简洁地回应当前问题，不替别人发言。'}}),b=await store.saveCharacter({id:prefix+'_b',name:s.neutralPersona?'林青':'周予',greeting:[],persona:{personality:'直率，尊重证据',speech:'自然简洁地回应当前问题，不替别人发言。'}});
 const target=s.target==='b'?b:a, settings=store.getSettings();const g=await store.saveGroup({id:prefix+'_g',name:'周末交流与桌游',members:[a.id,b.id]});const special=s.baseId.split('-').slice(1).join('-');const rows=[];const now=Date.now();
 for(const [i,raw] of s.messages.entries()){
  const x=typeof raw==='string'?{role:'user',content:raw}:raw;const privateSource=x.source==='group'?false:x.source==='private'||special==='private_boundary'||(special==='public_after_private'&&i===0)||s.category==='chat';
  const m={id:prefix+'_s'+i,role:x.role,content:x.content,charId:privateSource?a.id:g.id,at:now-86400000+i*1000,game:x.game};
  if(!privateSource)Object.assign(m,{groupId:g.id,speakerId:x.role==='user'?'user':x.speaker==='b'?b.id:a.id,speakerName:x.role==='user'?'小澄':x.speaker==='b'?'周予':'林青',audienceIds:special==='new_member'?[a.id]:[a.id,b.id]});
  rows.push(m);if(m.groupId)await store.putGroupMessagesLocal([m]);else await store.putMessagesLocal([m]);
 }
 const visible=rows.filter(m=>!m.game&&(m.groupId?heardGroupMessage(m,target.id,g):m.charId===target.id));
 const filler=Array.from({length:10},(_,i)=>({id:prefix+'_f'+i,role:i%2?'assistant':'user',content:`普通闲聊${i+1}：今天随便聊聊日常，没有更新安排。`,at:now-10000+i,charId:s.category==='group'?g.id:target.id,...(s.category==='group'?{groupId:g.id,speakerId:i%2?target.id:'user',audienceIds:[a.id,b.id]}:{})}));
 if(s.category==='group')await store.putGroupMessagesLocal(filler);else await store.putMessagesLocal(filler);
 // Extract each visible conversation independently via the product's real memory extractor.
 const buckets=new Map();for(const m of visible){const k=m.groupId?'group:'+m.groupId:'private';if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(m);}
 const extractions=[];const batches=[...buckets].flatMap(([source,ms])=>s.incremental?ms.map(m=>[source,[m]]):[[source,ms]]);for(const [source,ms] of (s.legacyFacts?[]:batches)){const tail=Array.from({length:6},(_,i)=>({...ms[0],id:prefix+'_extract_'+source+'_'+ms[0].id+'_'+i,content:'普通闲聊，没有新的安排。',at:ms.at(-1).at+1+i}));if(ms[0].groupId)await store.putGroupMessagesLocal(tail);else await store.putMessagesLocal(tail);extractions.push(await prompt.summarizeIfNeeded(target,[...ms,...tail],{settings,force:true,source}));}
 if(s.legacyFacts){const sources=new Map(visible.map((m,i)=>[String(i),makeMemorySource(m,target.id)]));await store.saveMemory(target.id,mergeExtractedMemory({}, {facts:s.legacyFacts},sources));}
 const before=await store.getMemory(target.id);const actions=[];
 if(s.action==='correct'||s.action==='retract'){
  const needle=s.needle||(s.action==='correct'?'星河厅':'九点');const candidates=before.factRecords.filter(r=>r.status==='active'&&r.text.includes(needle)&&(!s.subject||r.text.includes(s.subject)));
  for(const f of (s.action==='correct'?candidates.slice(0,1):candidates)){let linked;if(s.action==='correct')linked=await correctRelatedMemoryFacts(target.id,f.id,s.replacement,{settings});else await store.retractMemoryFact(target.id,f.id);actions.push({type:s.action,recordId:f.id,linked});}
 }
 if(s.action==='edit'){await store.updateGroupMessage(rows[0].id,{content:'更正：晚餐素食份数尚未确认。'});actions.push({type:'edit',id:rows[0].id});}
 let rebuilt=null;if(s.rebuildAfterCorrection){rebuilt=await prompt.rebuildMemory(target,[],settings);if(!rebuilt.summarized)throw Error('correction rebuild failed');}
 const notices=s.action==='correct'?['用户通过记忆管理明确更正：'+s.replacement]:s.action==='retract'?['用户通过记忆管理撤回了九点接人的安排，目前没有新的确定时间。']:[];
 const baselineEvidence=visible.map(m=>({speaker:m.speakerId==='user'||m.role==='user'?'小澄':m.speakerName||target.name,content:s.action==='edit'&&m.id===rows[0].id?'更正：晚餐素食份数尚未确认。':m.content}));
 const summary=await answer([{role:'system',content:'你为一个角色整理独立的聊天摘要。只依据提供给该角色的可见记录与管理通知，保留人物归属、否定、暂定和最后有效安排。用户更正或撤回优先于旧记录。不猜测、不补全。用简洁中文，不超过450字。'},{role:'user',content:JSON.stringify({character:target.name,messages:baselineEvidence,managementNotices:notices})}],{...config.params,temperature:0.3,maxTokens:1100});
 const q={id:prefix+'_q',role:'user',content:s.question,charId:s.category==='group'?g.id:target.id,at:now+1,...(s.category==='group'?{groupId:g.id,speakerId:'user',audienceIds:[a.id,b.id]}:{})};
 fixture={s,a,b,target,g,filler,q,settings,historyEcho:s.historyEcho?visible.filter(m=>s.category==='group'?m.groupId:!m.groupId):[],summary:summary.text};
 sessionStorage.setItem('core-evaluation-fixture',JSON.stringify({fixture,config}));
 return {extractionSucceeded:extractions.every(x=>x.summarized),extractedTargetFacts:before.factRecords.filter(x=>x.status==='active').length,targetExtractionExpected:visible.length>0&&!s.legacyFacts,legacyFixture:Boolean(s.legacyFacts),rebuiltAfterCorrection:rebuilt,beforeMemory:before,afterMemory:await store.getMemory(target.id),actions,baselineEvidence,managementNotices:notices,baselineSummary:summary.text,summaryTruncated:summary.truncated};
}
export async function assemble(variant){const {s,a,b,target,g,filler,q,settings,summary,historyEcho=[]}=fixture;let memory=await store.getMemory(target.id),experiences=await store.getRecentExperiences(target.id,{source:s.category==='group'?`group:${g.id}`:`private:${target.id}`});
 if(variant==='role_summary'){memory={summary,facts:[]};experiences=[];}if(variant==='no_memory'){memory={};experiences=[];}
 const r=s.category==='group'?group.buildGroupMessages({group:g,speaker:target,members:[a,b],history:[...filler,...historyEcho,q],settings,runtime:{},memory,recentExperiences:experiences,budgetTokens:s.budgetTokens,maxMessages:8,userName:'小澄'}):prompt.buildMessages(target,[...filler,...historyEcho,q],{settings,runtime:{},memory,recentExperiences:experiences,userText:s.question,budgetTokens:s.budgetTokens});
 return {messages:r.messages,meta:r.meta,memory,recentExperiences:experiences};
}
export function restore(){const saved=JSON.parse(sessionStorage.getItem('core-evaluation-fixture'));fixture=saved.fixture;config=saved.config;return true;}
window.coreEvaluation={configure,prepare,assemble,answer,restore};

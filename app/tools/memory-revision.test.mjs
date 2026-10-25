import test from 'node:test';import assert from 'node:assert/strict';
import {makeMemorySource,mergeExtractedMemory,correctFact,selectMemoryFacts,filterMemoryContext} from '../core/memory.js';
import {validateCorrectionLinks} from '../core/memory-correction.js';
const message=(id,at,content,groupId)=>({id,at,content,role:'user',charId:'a',...(groupId?{groupId,audienceIds:['a']}:{})});
const old=message('o',1,'周五七点'),middle=message('m',2,'周六两点'),latest=message('n',3,'最终周日四点');
const map=new Map([old,middle,latest].map(m=>[m.id,makeMemorySource(m,'a')]));
for(const reverse of [false,true])test(`同批连续改期淘汰旧事实与原文，返回顺序${reverse}`,()=>{
 const facts=[{text:'周五七点',sourceIds:['o']},{text:'周六两点',sourceIds:['m']},{text:'周日四点',sourceIds:['n'],change:'confirmed_update',obsoleteSourceIds:['o','m']}];
 const m=mergeExtractedMemory({}, {facts:reverse?facts.reverse():facts},map);
 assert.deepEqual(selectMemoryFacts(m),['周日四点']);assert.deepEqual(filterMemoryContext([old,middle,latest],m,{charId:'a'}),[latest]);
});
test('跨批明确更新淘汰旧记录',()=>{
 let m=mergeExtractedMemory({}, {facts:[{text:'旧时间',sourceIds:['o']}]},map);const id=m.factRecords[0].id;
 m=mergeExtractedMemory(m,{facts:[{text:'最新时间',sourceIds:['n'],change:'confirmed_update',supersedes:[id]}]},map);
 assert.equal(m.factRecords.find(r=>r.id===id).status,'superseded');

});
test('错误来源、倒序和不同会话不能淘汰旧事实',()=>{
 const start=mergeExtractedMemory({}, {facts:[{text:'保留',sourceIds:['n']}]},map),id=start.factRecords[0].id;
 for(const sourceIds of [['o'],['fake']]){
  const m=mergeExtractedMemory(start,{facts:[{text:'坏覆盖',sourceIds,change:'confirmed_update',supersedes:[id],obsoleteSourceIds:['n']}]},map);
  assert.equal(m.factRecords.find(r=>r.id===id).status,'active');
 }
 const foreign=makeMemorySource(message('foreign',100,'另一个群的安排','other-group'),'a');
 const foreignMap=new Map([...map,['foreign',foreign]]);
 const separate=mergeExtractedMemory(start,{facts:[{text:'另群新时间',sourceIds:['foreign'],change:'confirmed_update',supersedes:[id]}]},foreignMap);
 assert.equal(separate.factRecords.find(r=>r.id===id).status,'active');
 const manual=correctFact(start,id,'人工安排'),mid=manual.factRecords.find(r=>r.origin==='manual').id;
 const m=mergeExtractedMemory(manual,{facts:[{text:'覆盖人工',sourceIds:['n'],change:'confirmed_update',supersedes:[mid]}]},map);
 assert.equal(m.factRecords.find(r=>r.id===mid).status,'active');
});
test('一次纠正关联多个来源，保留无关事实，且重提旧来源不会复活',()=>{
 const input={facts:[{text:'原地点',sourceIds:['o']},{text:'同义复述',sourceIds:['m']},{text:'无关活动',sourceIds:['n']}]};
 const start=mergeExtractedMemory({},input,map);const [a,b,c]=start.factRecords;
 const m=correctFact(start,a.id,'新地点',{relatedIds:[b.id],blockedSources:[map.get('o'),map.get('m')]});
 assert.deepEqual(new Set(selectMemoryFacts(m)),new Set(['新地点','无关活动']));assert.equal(start.factRecords[0].status,'active');
 const again=mergeExtractedMemory(m,{facts:[{text:'旧地点的再次改写',sourceIds:['m']}]},map);
 assert(!selectMemoryFacts(again).includes('旧地点的再次改写'));assert.equal(again.factRecords.find(r=>r.id===c.id).status,'active');
});
test('关联分析必须返回已提供的ID，出错不写入',()=>{
 assert.throws(()=>validateCorrectionLinks({factIds:['foreign'],messageIds:[]},[{id:'a'}],[]));
 assert.throws(()=>validateCorrectionLinks({factIds:[]},[],[]));
 assert.deepEqual(validateCorrectionLinks({factIds:['a','a'],messageIds:['m']},[{id:'a'}],[{id:'m'}]),{factIds:['a'],messageIds:['m'],retainedFacts:[]});
});

test('混合旧条目仅替换地点，保留时间且保留原来源历史',()=>{
 const start=mergeExtractedMemory({}, {facts:[{text:'读书会旧地点',sourceIds:['o']},{text:'读书会旧地点，三点开始',sourceIds:['m']}]},map);
 const [a,b]=start.factRecords;const m=correctFact(start,a.id,'读书会新地点',{relatedIds:[b.id],retainedFacts:[{id:b.id,text:'读书会三点开始'}]});
 assert.deepEqual(new Set(selectMemoryFacts(m)),new Set(['读书会新地点','读书会三点开始']));assert.equal(m.factRecords.find(r=>r.id===b.id).status,'superseded');
 const rebuilt=mergeExtractedMemory(m,{facts:[]},map,{rebuild:true});assert.deepEqual(new Set(selectMemoryFacts(rebuilt)),new Set(['读书会新地点','读书会三点开始']));
});

test('未关联事实的多余保留建议被忽略，不能改写无关事实',()=>{
 assert.deepEqual(validateCorrectionLinks({factIds:[],messageIds:[],retainedFacts:[{id:'safe',text:'模型建议的其他值'}]},[{id:'safe',text:'原值'}],[]),{factIds:[],messageIds:[],retainedFacts:[]});
});

test('共享被屏蔽原文的独立时间也能重建保留，未来明确改期仍可替换',()=>{
 const start=mergeExtractedMemory({}, {facts:[{text:'旧地点',sourceIds:['o']},{text:'三点开始',sourceIds:['o']}]},map);const [venue,time]=start.factRecords;
 const corrected=correctFact(start,venue.id,'新地点');const rebuilt=mergeExtractedMemory(corrected,{facts:[]},map,{rebuild:true});
 assert(selectMemoryFacts(rebuilt).includes('三点开始'));
 const updated=mergeExtractedMemory(rebuilt,{facts:[{text:'四点开始',sourceIds:['n'],change:'confirmed_update',supersedes:[time.id]}]},map);
 assert(!selectMemoryFacts(updated).includes('三点开始'));assert(selectMemoryFacts(updated).includes('四点开始'));
});

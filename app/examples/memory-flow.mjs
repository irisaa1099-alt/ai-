/** Run: node examples/memory-flow.mjs. No browser, server, model, key or database. */
import assert from 'node:assert/strict';
import {heardGroupMessage} from '../core/recent.js';
import {makeMemorySource,mergeExtractedMemory,correctFact,retractFact,filterMemoryContext,selectMemoryFacts} from '../core/memory.js';

const actor='lin',newcomer='zhou';
const source={id:'m1',groupId:'reading',role:'user',speakerId:'user',content:'周末集合地点是青栎书屋。',audienceIds:[actor],at:1};
// The storage adapter must supply only messages this actor actually heard.
assert(heardGroupMessage(source,actor));assert(!heardGroupMessage(source,newcomer));
const sourceMap=new Map([['m1',makeMemorySource(source,actor,'group:reading')]]);
// This explicit fixture stands for extraction output; it is NOT a model-quality demonstration.
const extracted={summary:'周末集合地点是青栎书屋。',facts:[{text:'周末集合地点是青栎书屋。',sourceIds:['m1']}]};
let memory=mergeExtractedMemory({},extracted,sourceMap);
assert.equal(memory.factRecords[0].sourceStatus,'verified');
const invalid=mergeExtractedMemory({}, {facts:[{text:'伪造事实',sourceIds:['missing']}]}, sourceMap);
assert.equal(invalid.factRecords.length,0);
const originalId=memory.factRecords[0].id;
memory=correctFact(memory,originalId,'周末集合地点改为蓝鲸书屋。');
const context=filterMemoryContext([source],memory,{charId:actor,source:'group:reading'});
assert.equal(context.length,0); // The old raw source cannot bypass correction.
assert.deepEqual(selectMemoryFacts(memory,'集合地点'),['周末集合地点改为蓝鲸书屋。']);
assert.equal(memory.factRecords.find(r=>r.id===originalId).status,'superseded');
memory=retractFact(memory,memory.factRecords.find(r=>r.status==='active').id);
assert.deepEqual(selectMemoryFacts(memory,'集合地点'),[]);
console.log(JSON.stringify({checks:8,heardByOriginalActor:true,heardByNewcomer:false,oldSourceAfterCorrection:context.length,activeFactsAfterWithdrawal:selectMemoryFacts(memory),note:'Uses actual product modules; synthetic extraction fixture; no model or storage writes.'},null,2));

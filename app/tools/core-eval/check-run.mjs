import fs from 'node:fs';import assert from 'node:assert/strict';import path from 'node:path';
const d=path.resolve(process.argv[2]||'');const r=JSON.parse(fs.readFileSync(path.join(d,'results.json')));let n=0;const ok=(x,m)=>{assert(x,m);n++};
ok(r.protocol.complete,'complete');ok(r.rows.length===r.protocol.expectedCells,'all cells');
for(const p of r.preparations){for(const m of p.baselineEvidence||[]){if(m.content.includes('公开通知所有成员')||m.content.includes('我现在向群内所有人公开'))ok(m.speaker==='小澄','user source ownership');}}
for(const row of r.rows){const text=JSON.stringify(row.messages);ok(row.messages.length>0,'assembled');ok(!text.includes('EVALUATION_LOCAL_BRIDGE'),'no key in messages');
 if(row.scenarioId.includes('private_boundary'))ok(!text.includes('青松七号'),'private fact excluded for every baseline');
 if(row.scenarioId.includes('new_member'))ok(!text.includes('八百元'),'join-time boundary for every baseline');
 if(row.variant==='no_memory')ok(!row.injectedMemory.summary,'window baseline empty');
 if(row.variant==='role_summary')ok(row.recentExperiences.length===0,'independent summary baseline');
 if(row.scenarioId.includes('game_separation'))ok(!text.includes('今晚要刀掉三号'),'game utterance excluded');
}
const out={checks:n,passed:true,kind:'assembly-only-not-model-quality'};fs.writeFileSync(path.join(d,'pipeline-validation.json'),JSON.stringify(out,null,2));console.log(out);

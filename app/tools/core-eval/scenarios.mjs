/** Frozen before live calls. New task shapes, not substitutions of the old location fixture. */
export const VERSION='core-eval-v3.2';
export const VARIANTS={no_memory:'仅当前窗口',role_summary:'角色独立摘要（同听众边界、同预算）',current:'当前实际机制'};
export const CATEGORY_LABELS={chat:'私聊',group:'群聊'};
const cases=[
 ['chat','multi_fact',['周六手作活动在云杉工坊，下午三点开始。请带蓝色围裙。'],'活动几点开始，我该带什么？','三点开始，带蓝色围裙。',[['三点','3点','15:00'],['蓝色围裙']],[]],
 ['chat','successive_change',['最初约周五晚上七点开会。','改到周六下午两点。','最终确定周日下午四点，之前两个时间都取消。'],'最终哪天几点开会？','周日下午四点，不能沿用周五或周六。',[['周日','星期日'],['四点','4点','16:00']],['周五晚上七点开会','周六下午两点开会']],
 ['chat','tentative',['我只是在考虑把交流会放在周二，也可能改周四。日期还没有定。'],'交流会已经确定哪天了吗？','尚未确定，周二和周四仅为备选。',[['没定','未定','没有确定','未确定','还没','尚未']],[]],
 ['chat','negation',['我不喝咖啡，也不喝酒；我喜欢无糖热茶。'],'给我选一种我喜欢的饮品。','无糖热茶；不能推荐咖啡或酒。',[['茶']],['推荐咖啡','推荐酒']],
 ['chat','attribution',['我叫小澄，我的朋友小禾喜欢红色。我自己喜欢绿色。'],'我和小禾分别喜欢什么颜色？','用户小澄绿色，小禾红色。',[['绿'],['红']],[]],
 ['chat','uncertain_claim',[{role:'assistant',content:'我猜小林可能是摄影师，这只是猜测。'},{role:'user',content:'我也不知道他做什么，没有可靠消息。'}],'小林已经确认的职业是什么？','不知道，摄影师只是猜测，不得认定职业。',[['不知道','不确定','未确认','没有','不清楚']],[]],
 ['chat','correction',['明晚聚会的地点是星河厅，开始时间是六点。'],'聚会现在在哪里，几点开始？','纠正后地点青石厅；六点仍有效。',[['青石厅'],['六点','6点','18:00']],['星河厅']],
 ['chat','retracted',[{role:'assistant',content:'我准备在九点接你。'}],'你现在能确认几点接我吗？','该安排被撤回，接人时间未知。',[['不知道','未定','不确定','没有','不能','无法']],['九点']],
 ['chat','game_separation',[{role:'assistant',content:'我是狼人，今晚要刀掉三号。',game:{type:'werewolf'}},{role:'user',content:'刚才是狼人杀发言。现实里的我喜欢种花，明天想聊园艺。'}],'离开游戏后，我们原本准备聊什么？','聊园艺、种花；游戏身份不是现实身份。',[['园艺','种花']],['现实里是狼人']],
 ['group','two_speakers',[{role:'assistant',speaker:'a',content:'我负责打印海报。'},{role:'assistant',speaker:'b',content:'我负责准备茶水。'}],'林青和周予各负责什么？','林青打印海报，周予准备茶水。',[['海报'],['茶水']],[]],
 ['group','public_change',['先约周六在东门见。','公开通知所有成员：改为周日在西门见，以这条为准。'],'现在集合安排是什么？','周日西门。',[['周日','星期日'],['西门']],['周六在东门']],
 ['group','private_boundary',['我只在林青私聊说过：门禁口令是青松七号。'],'周予，你知道门禁口令吗？','周予未参加林青私聊，不知道口令。',[['不知道','不清楚','没有','没听','未获知']],['青松七号']],
 ['group','new_member',['在周予入群之前，我们确定预算为八百元。'],'周予，你能确认之前公布的预算吗？','周予未听到入群前消息，预算未知。',[['不知道','不清楚','没有','没听','未获知']],['八百','800']],
 ['group','public_after_private',['活动暗号是白鹭，请只在这个私聊里记住。','我现在向群内所有人公开：这次活动暗号为白鹭。'],'周予，现在活动暗号是什么？','公开后周予可知道白鹭。',[['白鹭']],[]],
 ['group','current_speaker',[{role:'assistant',speaker:'a',content:'我建议先讲故事。'},{role:'assistant',speaker:'b',content:'我建议先玩桌游。'}],'林青，请回顾你之前明确提出的建议，别替周予新增表态。','林青先讲故事；不冒充周予，不将周予建议归为自己。',[['故事']],[]],
 ['group','cancelled_plan',['原定今晚八点开局狼人杀。','组织者通知：今晚取消，新的日期还没讨论。'],'今晚还开局吗？改到哪天？','今晚取消，新日期未知。',[['取消','不开'],['不知道','未定','没定','未确定','没有','还没']],[]],
 ['group','unresolved_vote',[{role:'assistant',speaker:'a',content:'我支持方案甲。'},{role:'assistant',speaker:'b',content:'我支持方案乙。'},{role:'user',content:'还没有投票，暂时没有形成决定。'}],'大家已经决定选哪个方案了？','没有决定，两人意见不同；不虚构一致同意。',[['没有','未定','还没','未决定']],[]],
 ['group','source_edit',['大家确认晚餐订了四份素食。'],'我们确认订了多少份素食？','原消息已改为尚未确认份数，所以不能断言四份。',[['不知道','未定','没有','未确认','还没','不确定']],['四份']],
];
export const SCENARIOS=cases.map(([category,id,messages,question,reference,required,forbidden])=>({id:`${category}-${id}`,category,messages,question,reference,required,forbidden,target:['private_boundary','new_member','public_after_private'].includes(id)?'b':'a',budgetTokens:4000,action:id==='correction'?'correct':id==='retracted'?'retract':id==='source_edit'?'edit':'none',replacement:id==='correction'?'明晚聚会的地点改为青石厅，开始时间仍为六点。':null}));
const revisions=[
 {id:'chat-revision_chain',category:'chat',messages:['设计复盘会定在周一早上九点。','复盘会改到周三下午两点。','最后确认复盘会周四晚上八点，前两次安排作废。','另一个跑步活动仍为周一早上九点。'],question:'复盘会最后几点？跑步活动呢？',reference:'复盘会周四晚上八点；跑步周一早上九点。',required:[['周四'],['八点','8点'],['周一'],['九点','9点']],forbidden:[]},
 {id:'group-revision_chain',category:'group',messages:['项目复盘原定周二下午一点。','复盘改周五晚上六点。','最终复盘定周六早上十点，原先两个时间不再有效。','团建仍为周五晚上六点，别和复盘混淆。'],question:'复盘和团建各是什么时间？',reference:'复盘周六早上十点；团建周五晚上六点。',required:[['周六'],['十点','10点'],['周五'],['六点','6点']],forbidden:[]},
 {id:'chat-tentative_update',category:'chat',messages:['面试已确认周五上午十点。','我在考虑改到周二下午三点，但只是想法，尚未确认更改。'],question:'面试当前确认的时间是什么？',reference:'仍是周五上午十点；周二只是设想。',required:[['周五'],['十点','10点']],forbidden:[]},
 {id:'group-distinct_people',category:'group',messages:[{role:'assistant',speaker:'a',content:'我林青的面试是周二上午九点。'},{role:'assistant',speaker:'b',content:'我周予的面试改到周四下午三点。'}],question:'林青和周予分别什么时候面试？',reference:'林青周二上午九点，周予周四下午三点，不能相互覆盖。',required:[['周二'],['九点','9点'],['周四'],['三点','3点']],forbidden:[]},
 ...['chat','group'].map(category=>({id:category+'-synonym_correction',category,messages:['周末读书会在青栎书屋集合。',{role:'assistant',speaker:'a',content:'记住了，大家这周末读书碰头就去青栎书屋。'},'对，读书会的碰面地址就是青栎书屋。','另一个摄影活动也在青栎书屋，时间是下个月。','读书会开始时间是下午三点。'],action:'correct',rebuildAfterCorrection:true,needle:'青栎书屋',subject:'读书会',replacement:'周末读书会的集合地点是蓝鲸书屋。',question:'读书会的地点和时间是什么？摄影活动在哪里？',reference:'读书会蓝鲸书屋，下午三点；摄影活动仍为青栎书屋。',required:[['蓝鲸书屋'],['三点','3点'],['青栎书屋']],forbidden:[]})),
 {id:'group-cross_context_correction',category:'group',messages:[{role:'user',source:'private',content:'周末读书会在青栎书屋集合。'},{role:'user',content:'现在公开通知：周末读书会的集合地点是青栎书屋。'},{role:'assistant',speaker:'a',content:'明白，读书会我们就在青栎书屋见。'}],action:'correct',rebuildAfterCorrection:true,needle:'青栎书屋',subject:'读书会',replacement:'周末读书会集合地点更正为蓝鲸书屋。',question:'周末读书会现在在哪里集合？',reference:'蓝鲸书屋；已听过私聊和群聊的同一角色只需纠正一次。',required:[['蓝鲸书屋']],forbidden:['青栎书屋']},
];
for(const category of ['chat','group']){
 revisions.push({id:category+'-incremental_change',category,incremental:true,messages:['春季筹备会确定周一上午九点。','春季筹备会改到周三下午两点，原时间不再有效。','最终确定春季筹备会周四晚上八点，前面的时间都作废。'],question:'春季筹备会最终是什么时间？',reference:'周四晚上八点，前面的时间已作废。',required:[['周四'],['八点','8点']],forbidden:['周三下午两点']});
 revisions.push({id:category+'-legacy_composite',category,action:'correct',rebuildAfterCorrection:true,needle:'青栎书屋',subject:'读书会',messages:['读书会在青栎书屋。','读书会在青栎书屋，下午三点开始。','摄影活动在青栎书屋，下个月举行。'],legacyFacts:[{text:'读书会在青栎书屋。',sourceIds:['0']},{text:'读书会在青栎书屋，下午三点开始。',sourceIds:['1']},{text:'读书会开始时间为下午三点。',sourceIds:['1']},{text:'摄影活动在青栎书屋，下个月举行。',sourceIds:['2']}],replacement:'读书会地点改为蓝鲸书屋。',question:'读书会几点在哪里？摄影活动在哪里？',reference:'读书会蓝鲸书屋、下午三点；摄影活动仍为青栎书屋。',required:[['蓝鲸书屋'],['三点','3点'],['青栎书屋']],forbidden:[]});
}
for(const category of ['chat','group']) revisions.push({id:category+'-unknown_echo',category,neutralPersona:true,historyEcho:true,action:'correct',rebuildAfterCorrection:true,needle:'青栎书屋',subject:'读书会',messages:[{role:'user',content:'周末读书会在哪里集合？'},{role:'assistant',speaker:'a',content:'不知道。当前没有可靠记录能确认周末读书会的集合地点。'},{role:'user',source:'group',content:'现在向群内公开确认：周末读书会在青栎书屋，下午三点开始。'},{role:'assistant',speaker:'a',source:'group',content:'收到，青栎书屋，下午三点，我记下了。'},{role:'user',content:'周末读书会现在在哪里？'},{role:'assistant',speaker:'a',content:'不知道。'}],replacement:'周末读书会的集合地点改为蓝鲸书屋。',question:'周末读书会现在在哪里集合，几点开始？',reference:'蓝鲸书屋，下午三点。角色过去回答不知道不覆盖后续公开消息和人工纠正。',required:[['蓝鲸书屋'],['三点','3点']],forbidden:['青栎书屋']});
SCENARIOS.push(...revisions.map(s=>({target:'a',budgetTokens:4000,action:'none',replacement:null,...s})));
export const PILOT_IDS=SCENARIOS.map(s=>s.id);
export function scoreAnswer(s,text,{error=false,truncated=false}={}){const pass=!error&&!truncated&&s.required.every(xs=>xs.some(x=>String(text).includes(x)))&&!s.forbidden.some(x=>String(text).includes(x));return {pass,status:error?'error':truncated?'truncated':pass?'pass':'fail',kind:'literal-proxy-not-semantic',needsReview:true};}

import { DAY, makeClock, dateKey } from './calendar.mjs';
const EPS=1000;
export function cardTimeAllowed(at){const day=((at+8*3600000)%DAY+DAY)%DAY;return day>=9.5*3600000&&day<=22*3600000;}
export function availableCards(snapshot,config,now){
 const raw=config.manualCredits?.length&&(!config.manualAccount||config.manualAccount===snapshot.account)?config.manualCredits.map((c,i)=>({id:'manual-'+i,status:'available',resetType:'codexRateLimits',expiresAt:Date.parse(c.expiresAt)})):snapshot.credits;
 return (raw||[]).filter(c=>c.status==='available'&&c.resetType==='codexRateLimits'&&c.expiresAt>now).sort((a,b)=>a.expiresAt-b.expiresAt);
}
export function createPlan(window,snapshot,config,now=snapshot.at,policy={}){
 if(!window||window.remaining==null||!window.duration||window.resetsAt<=now)return null;
 const warnings=[],all=window.bucket==='codex'&&window.duration===7*DAY?availableCards(snapshot,config,now):[];
 const cards=all.filter(c=>c.expiresAt<=now+90*DAY).slice(0,8);
 if(cards.length<all.length)warnings.push('当前只规划最近90天内最早8张卡，其余卡仍保留在库存。');
 const last=cards.at(-1)?.expiresAt||window.resetsAt;
 const horizon=Math.max(policy.horizon||0,cards.length?last+window.duration:window.resetsAt);
 const clock=makeClock(now,horizon+window.duration+DAY,config);
 if(clock.rows.some(r=>!r.verified))warnings.push('部分日期尚无已核验的中国节假日表，仅按周末和自定义日历计算。');
 const segment=(start,end,amount,event,card)=>{const work=clock.work(start,end);return {start,end,amount,event,card,work,rate:work>1e-10?amount/work:0,waste:work>1e-10?0:amount};};
 function extend(state,end,event,card){
   let start=state.at,reset=state.reset,amount=state.amount;const parts=[];
   while(reset<end-1){parts.push(segment(start,reset,amount,'natural'));start=reset;reset+=window.duration;amount=100;}
   // Redeeming exactly when a natural reset occurs would discard a fresh 100%.
   if(event==='card'&&Math.abs(end-reset)<1)return null;
   if(event==='horizon'){const full=clock.work(start,reset),used=full>1e-10?amount*clock.work(start,end)/full:0;parts.push({...segment(start,end,used,event,card),amount,retained:amount-used});}else parts.push(segment(start,end,amount,event,card));
   return {at:end,reset:end+window.duration,amount:100,segments:parts,previous:state,
    waste:state.waste+parts.reduce((s,p)=>s+p.waste,0),peak:Math.max(state.peak,...parts.map(p=>p.rate)),
    squares:state.squares+parts.reduce((s,p)=>s+p.rate*p.rate*p.work,0),quota:state.quota+parts.reduce((s,p)=>s+p.amount-p.waste-(p.retained||0),0)};
 }
 const origin={at:now,reset:window.resetsAt,amount:window.remaining,segments:[],previous:null,waste:0,peak:0,squares:0,quota:0};

 const initialCandidates=new Set();
 for(let t=Math.ceil(now/3600000)*3600000;t<last;t+=3600000)initialCandidates.add(t);
 for(const row of clock.rows){for(const t of row.intervals.flat())if(t>now&&t<last)initialCandidates.add(t);if(row.start>now&&row.start<last)initialCandidates.add(row.start);if(row.end>now&&row.end<last)initialCandidates.add(row.end-EPS);}
 for(let day=Math.floor((now+8*3600000)/DAY)*DAY-8*3600000;day<last;day+=DAY){initialCandidates.add(day+9.5*3600000);initialCandidates.add(day+22*3600000);}
 for(const c of cards)initialCandidates.add(c.expiresAt-EPS);
 // At identical redemption times and consumed/wasted quota, future states are identical.
 // Keep the smallest squared workload for each quota class, not just the lowest prefix peak.
 // All paths end at the same horizon; unfinished final quota is retained, never discarded.
 function solve(candidates){let states=[origin];for(const card of cards){const next=[];for(const t of candidates){if(!cardTimeAllowed(t)||t<=now||t>=card.expiresAt||t<(card.grantedAt||now))continue;const frontier=new Map();for(const state of states){if(t<=state.at+EPS)continue;const candidate=extend(state,t,'card',card);if(candidate){const key=candidate.quota+':'+candidate.waste,old=frontier.get(key);if(!old||candidate.squares<old.squares)frontier.set(key,candidate);}}next.push(...frontier.values());}states=next;if(!states.length)return null;}
   let best=null;for(const state of states){const end=horizon;const terminal=extend(state,end,horizon===window.resetsAt?'natural':'horizon');if(!terminal)continue;const work=clock.work(now,end),mean=work?terminal.quota/work:0;terminal.variance=work?Math.max(0,terminal.squares/work-mean*mean):0;terminal.mean=mean;const cmp=best?(terminal.waste-best.waste||terminal.variance-best.variance||best.quota-terminal.quota||terminal.peak-best.peak):-1;if(cmp<0)best=terminal;}return best;}
 let chosen=solve([...initialCandidates].sort((a,b)=>a-b));
 function unpack(state){const parts=[];while(state?.previous){parts.unshift(...state.segments);state=state.previous;}return parts;}
 if(chosen&&cards.length){const fine=new Set();for(const s of unpack(chosen).filter(s=>s.event==='card'))for(let delta=-3600000;delta<=3600000;delta+=5*60000)fine.add(s.end+delta);for(const c of cards)fine.add(c.expiresAt-EPS);const refined=solve([...fine].sort((a,b)=>a-b));if(refined&&(refined.waste<chosen.waste||refined.waste===chosen.waste&&(refined.variance<chosen.variance||refined.variance===chosen.variance&&refined.quota>chosen.quota)))chosen=refined;}
 if(!chosen)return {anchorAt:now,segments:[],daily:[],schedule:[],warnings:[...warnings,'没有找到满足到期时间及北京时间09:30–22:00用卡时段的计划。'],infeasible:true};
 const segments=unpack(chosen),end=segments.at(-1).end;
 const daily=clock.rows.filter(r=>r.end>now&&r.start<end).map(row=>({...row,amount:segments.reduce((sum,s)=>sum+s.rate*clock.work(Math.max(row.start,s.start),Math.min(row.end,s.end)),0),events:segments.filter(s=>s.event!=='horizon'&&dateKey(s.end,config.calendarTimezone)===row.date).map(s=>({type:s.event,at:s.end}))}));
 if(chosen.waste>0.001)warnings.push('有完整额度窗口落在休息日，无法用完；已单独列出预计浪费，未把用量强塞进假期。');
 return {anchorAt:now,account:snapshot.account,hasExpiringCards:all.length>0,initialRemaining:window.remaining,initialReset:window.resetsAt,horizon,end,segments,daily,
  schedule:segments.filter(s=>s.event==='card').map(s=>({...s.card,plannedAt:s.end,overdue:false})),
  consumed:chosen.quota,retained:segments.at(-1).retained||0,peak:chosen.peak,mean:chosen.mean,variance:chosen.variance,waste:chosen.waste,warnings,
  calendarTimezone:config.calendarTimezone,search:'小时候选搜索 + 5分钟局部细化；额度按实际毫秒和有效工作日核算',version:5};
}
export function plannedRemaining(plan,now,config){
 if(!plan?.segments?.length)return null;const s=plan.segments.find(s=>now>=s.start&&now<s.end);if(!s)return now>=plan.end?0:plan.initialRemaining;
 const clock=makeClock(s.start,s.end,config);return Math.max(0,s.amount-s.rate*clock.work(s.start,now));
}

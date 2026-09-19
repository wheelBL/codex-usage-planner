import test from 'node:test';
import assert from 'node:assert/strict';
import {guardSnapshot,reconcileCredits} from '../snapshot-guard.mjs';
import {normalize,DAY,settings} from '../core.mjs';
import {availableCards,createPlan} from '../planner.mjs';
const now=Date.parse('2026-09-21T10:00:00+08:00');
const card={id:'a',status:'available',resetType:'codexRateLimits',expiresAt:now+8*DAY};
const base=()=>({at:now,account:'A',creditsKnown:true,availableCount:1,credits:[card],windows:[{key:'codex:primary',bucket:'codex',duration:7*DAY,resetsAt:now+2*DAY,remaining:25}]});
const read=(s,delta,window={},extra={})=>({...structuredClone(s),at:s.at+delta,windows:s.windows.map(w=>({...w,...window})),...extra});
const stored=s=>({version:1,trusted:s,pending:{}});
test('unknown card details retain known cards and do not change planning identity',()=>{
 const s=base(),out=reconcileCredits(read(s,60000,{}, {creditsKnown:false,credits:[],availableCount:null}),s);
 assert.deepEqual(availableCards(out,settings(),out.at),[card]);assert.equal(out.creditsKnown,false);assert.equal(out.creditsUncertain,true);
 assert.deepEqual(availableCards(s,settings(),out.at),availableCards(out,settings(),out.at));
});
test('known empty and authoritative zero clear inventory',()=>{
 const s=base();
 for(const extra of [{creditsKnown:true,availableCount:0,credits:[]},{creditsKnown:false,availableCount:0,credits:[]}]){
  const out=reconcileCredits(read(s,60000,{},extra),s);assert.deepEqual(out.credits,[]);assert.equal(out.creditsUncertain,false);
 }
});
test('partial inventory merges evidence but does not remove omitted cards',()=>{
 const s=base(),b={...card,id:'b'};
 const out=reconcileCredits(read(s,60000,{}, {credits:[b],availableCount:2}),s);
 assert.deepEqual(out.credits.map(c=>c.id),['a','b']);assert.equal(out.creditsUncertain,true);
 const revoked=reconcileCredits(read(s,60000,{}, {credits:[{...card,status:'redeemed'}],availableCount:2}),s);
 assert.deepEqual(revoked.credits,[]);
});
test('expired cached cards disappear; unknown does not invent an empty confirmed inventory',()=>{
 const s=base(),next=read(s,9*DAY,{}, {creditsKnown:false,credits:[],availableCount:null});
 assert.deepEqual(reconcileCredits(next,s).credits,[]);
 assert.equal(reconcileCredits(next,null).creditsUncertain,true);
});
test('natural reset is admitted immediately',()=>{
 const s=base(),next=read(s,2*DAY+1000,{remaining:100,resetsAt:now+9*DAY});
 assert.equal(guardSnapshot(next,stored(s)).accepted,true);
});
test('early reset holds then confirms independently of OAuth or RPC source',()=>{
 const s=base(),first=read(s,60000,{remaining:99,resetsAt:now+7*DAY},{source:'oauth'});
 const held=guardSnapshot(first,stored(s));assert.equal(held.accepted,false);assert.deepEqual(held.state.trusted,s);
 const tooSoon=guardSnapshot(read(first,1000,{remaining:98},{source:'rpc'}),held.state);assert.equal(tooSoon.accepted,false);
 const confirmed=guardSnapshot(read(first,30000,{remaining:97},{source:'rpc'}),tooSoon.state);
 assert.equal(confirmed.accepted,true);assert.equal(confirmed.snapshot.windows[0].remaining,97);
});
test('restarting preserves pending confirmation; rapid manual refresh cannot bypass it',()=>{
 const s=base(),first=read(s,60000,{remaining:100});let result=guardSnapshot(first,stored(s));
 for(let i=1;i<30;i++){result=guardSnapshot(read(first,i*1000,{remaining:100}),JSON.parse(JSON.stringify(result.state)));assert.equal(result.accepted,false);}
 assert.equal(guardSnapshot(read(first,30000,{remaining:100}),result.state).accepted,true);
});
test('one-off anomaly reverts without contaminating history or baseline',()=>{
 const s=base(),held=guardSnapshot(read(s,60000,{remaining:100}),stored(s));
 const recovered=guardSnapshot(read(s,120000,{remaining:24}),held.state);
 assert.equal(recovered.accepted,true);assert.deepEqual(recovered.state.pending,{});
 const cfg=settings(),plan=createPlan(s.windows[0],s,cfg,now);
 assert.equal(plan.initialRemaining,25);assert.equal(held.state.trusted.windows[0].resetsAt,plan.initialReset);
});
test('inconsistent or expired confirmation restarts verification',()=>{
 const s=base(),first=read(s,60000,{remaining:99,resetsAt:now+7*DAY}),held=guardSnapshot(first,stored(s));
 assert.equal(guardSnapshot(read(first,60000,{resetsAt:now+6*DAY}),held.state).accepted,false);
 assert.equal(guardSnapshot(read(first,300001),held.state).accepted,false);
});
test('account change never borrows cached cards or pending quota',()=>{
 const s=base(),held=guardSnapshot(read(s,60000,{remaining:100}),stored(s));
 const b=guardSnapshot(read(s,120000,{remaining:100},{account:'B',creditsKnown:false,credits:[],availableCount:null}),held.state);
 assert.equal(b.accepted,true);assert.deepEqual(b.snapshot.credits,[]);assert.deepEqual(b.state.pending,{});
});
test('multiple buckets confirm without losing an earlier confirmation',()=>{
 const s=base();s.windows.push({...s.windows[0],bucket:'spark',key:'spark:primary'});
 let next=read(s,60000,{remaining:100}),a=guardSnapshot(next,stored(s));
 next=read(next,30000);next.windows[1].resetsAt+=DAY;
 const b=guardSnapshot(next,a.state);assert.equal(b.accepted,false);
 assert.equal(guardSnapshot(read(next,30000),b.state).accepted,true);
});
test('out-of-order snapshots cannot replace trusted state',()=>assert.equal(guardSnapshot(read(base(),-1),stored(base())).accepted,false));
test('normalization keeps missing and empty credit details distinct',()=>{
 assert.equal(normalize({rateLimitResetCredits:{credits:null}},'A',now).creditsKnown,false);
 assert.equal(normalize({rateLimitResetCredits:{credits:[]}},'A',now).creditsKnown,true);
});
test('missing window fields cannot erase the last valid verification baseline',()=>{
 const s=base(),missing=guardSnapshot(read(s,60000,{remaining:null}),stored(s));
 assert.equal(missing.accepted,true);
 assert.equal(guardSnapshot(read(s,120000,{remaining:100}),missing.state).accepted,false);
});
test('missing windows do not cancel an outstanding confirmation',()=>{
 const s=base(),held=guardSnapshot(read(s,60000,{remaining:100}),stored(s));
 const missing=guardSnapshot({...read(s,120000),windows:[]},held.state);
 assert.equal(missing.accepted,false);assert.deepEqual(missing.state.pending,held.state.pending);
});

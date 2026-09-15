import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY,normalize,budget,settings,forecast,instant} from '../core.mjs';
import {dayInfo,makeClock,midnight} from '../calendar.mjs';
import {createPlan,availableCards,plannedRemaining} from '../planner.mjs';
const at=instant('2026-09-15T10:30:00+08:00'),reset=instant('2026-09-19T16:09:53+08:00');
const w={key:'codex:primary',bucket:'codex',duration:7*DAY,resetsAt:reset,remaining:60};
const card=(id,date)=>({id,status:'available',resetType:'codexRateLimits',expiresAt:instant(date)});
const s={at,account:'a',windows:[w],credits:[card('a','2026-10-04T10:31:47+08:00'),card('b','2026-10-05T12:20:05+08:00')]};
const cfg=settings(),plan=createPlan(w,s,cfg,at),close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,a+' != '+b);
test('default is zero rest-day usage and no reserve-week rule',()=>{assert.equal(cfg.restWeight,0);assert.equal(cfg.calendar,'china');assert.ok(!Object.hasOwn(cfg,'reserveDays'));assert.ok(!Object.hasOwn(settings({reserveDays:7}),'reserveDays'));});
test('2026 official holidays and makeup weekends',()=>{assert.equal(dayInfo('2026-09-20',cfg).weight,1);assert.equal(dayInfo('2026-09-19',cfg).weight,0);assert.equal(dayInfo('2026-09-25',cfg).weight,0);assert.equal(dayInfo('2026-10-01',cfg).weight,0);assert.equal(dayInfo('2026-10-10',cfg).weight,1);});
test('personal days override holidays and makeup dates',()=>{const c=settings({dayOverrides:{'2026-09-20':0,'2026-10-01':0.5}});assert.equal(dayInfo('2026-09-20',c).weight,0);assert.equal(dayInfo('2026-10-01',c).weight,0.5);});
test('unknown holiday years are not silently certified',()=>assert.equal(dayInfo('2027-10-01',cfg).verified,false));
test('DST day is 25 real hours but one weighted workday',()=>{const c=settings({calendar:'weekends',calendarTimezone:'America/Los_Angeles',restWeight:1}),a=midnight('2026-11-01',c.calendarTimezone),b=midnight('2026-11-02',c.calendarTimezone);assert.equal(b-a,25*3600000);close(makeClock(a,b,c).work(a,b),1);});
test('exact partial working day and timezone-equivalent instant',()=>{assert.equal(at,instant('2026-09-15T02:30:00Z'));const clock=makeClock(at,reset,cfg);close(clock.work(at,reset),3.5625);});
test('current interval participates in smoothing and can move natural reset',()=>{assert.equal(plan.segments[0].event,'card');assert.ok(plan.segments[0].end<reset);assert.ok(Math.abs(plan.segments[0].rate-plan.segments[1].rate)<14);assert.ok(Math.sqrt(plan.variance)<8.6);});
test('joint plan reduces old 19-to-21 spike',()=>{const oldWork=makeClock(reset,instant('2026-09-21T00:00:00+08:00'),cfg).work(reset,instant('2026-09-21T00:00:00+08:00'));assert.ok(plan.peak<100/oldWork);});
test('all cards are used strictly before their expiry',()=>{assert.equal(plan.schedule.length,2);for(const c of plan.schedule)assert.ok(c.plannedAt<c.expiresAt);});
test('all paths use expiry plus one window as fixed horizon',()=>{close(plan.end,s.credits.at(-1).expiresAt+w.duration);const natural=plan.segments.find(p=>p.event==='natural');close(natural.end,plan.schedule.at(-1).plannedAt+w.duration);});
test('no consumption is assigned to weekends or holidays',()=>{for(const d of plan.daily)if(d.weight===0)close(d.amount,0);});
test('quota conservation and zero unused quota',()=>{close(plan.waste,0);close(plan.daily.reduce((sum,d)=>sum+d.amount,0),plan.segments.reduce((sum,p)=>sum+p.amount-(p.retained||0),0));});
test('no card means consume the current remainder by natural reset',()=>{const p=createPlan(w,{...s,credits:[]},cfg,at);assert.equal(p.schedule.length,0);assert.equal(p.segments.length,1);close(p.peak,60/3.5625);});
test('card expiring before natural reset can override preservation',()=>{const p=createPlan(w,{...s,credits:[card('soon','2026-09-18T00:00:00+08:00')]},cfg,at);assert.equal(p.segments[0].event,'card');assert.ok(p.schedule[0].plannedAt<reset);});
test('holiday-only allowance reports waste rather than invented use',()=>{const a=instant('2026-10-01T00:00:00+08:00'),ww={...w,resetsAt:a+7*DAY,remaining:100},p=createPlan(ww,{at:a,account:'a',credits:[]},cfg,a);assert.equal(p.waste,100);assert.ok(p.daily.every(d=>d.amount===0));assert.ok(p.warnings.length);});
test('baseline stays fixed when actual remaining changes',()=>{const later=at+3600000;const b=budget({...w,remaining:58},s,cfg,later,plan);assert.ok(b.target<60&&b.target>58);close(b.gap,58-b.target);assert.equal(plan.initialRemaining,60);});
test('display timezone does not change work-calendar budget',()=>{close(budget(w,s,cfg,at+3600000,plan).target,budget(w,s,settings({timezone:'UTC'}),at+3600000,plan).target);});
test('plan does not presume an unredeemed card was used',()=>{const p=createPlan(w,{...s,credits:[card('soon','2026-09-18T00:00:00+08:00')]},cfg,at);const b=budget(w,s,cfg,p.segments[0].end+1000,p);assert.equal(b.target,0);assert.equal(b.overdue,true);});
test('plan remaining is flat across a non-working day',()=>{const a=instant('2026-09-25T01:00:00+08:00'),b=instant('2026-09-25T23:00:00+08:00');close(plannedRemaining(plan,a,cfg),plannedRemaining(plan,b,cfg));});
test('unknown fields are not zero quota',()=>{const n=normalize({rateLimits:{primary:{usedPercent:null,windowDurationMins:null,resetsAt:null}}},'a',at);assert.equal(n.windows[0].remaining,null);assert.equal(budget(n.windows[0],n,cfg,at).target,null);});
test('multi-bucket duration is authoritative',()=>{const n=normalize({rateLimits:{},rateLimitsByLimitId:{codex:{primary:{usedPercent:20,windowDurationMins:10080,resetsAt:reset/1000}},spark:{secondary:{usedPercent:5,windowDurationMins:300,resetsAt:reset/1000}}}},'a',at);assert.equal(n.windows[0].duration,7*DAY);assert.equal(n.windows[1].remaining,95);});
test('invalid dates, timezone, and personal-day data are rejected',()=>{assert.throws(()=>instant('2026-09-26'));assert.throws(()=>settings({calendarTimezone:'Mars/Base'}));assert.throws(()=>settings({dayOverrides:{'2026-02-30':0}}));assert.throws(()=>settings({restWeight:-1}));});
test('card inventory filters expired or inapplicable entries',()=>{assert.equal(availableCards({...s,credits:[{...s.credits[0],status:'redeemed'},{...s.credits[0],expiresAt:at},{...s.credits[0],resetType:'unknown'}]},cfg,at).length,0);});
test('manual cards are account bound',()=>{const c=settings({manualAccount:'other',manualCredits:[{expiresAt:'2026-09-16T00:00:00+08:00'}]});assert.equal(availableCards(s,c,at)[0].id,'a');});
const sample=(time,left,r=reset)=>({at:time,account:'a',windows:[{...w,resetsAt:r,remaining:left}]});
test('forecast needs contiguous measured samples',()=>{assert.equal(forecast([sample(at,60)],w,'a',at,cfg),null);assert.equal(forecast([sample(at-600000,10),sample(at,60)],w,'a',at,cfg),null);assert.equal(forecast([sample(at-30*60000,70),sample(at,60)],w,'a',at,cfg),null);});
test('forecast future consumption skips resting days',()=>{const t=instant('2026-09-24T23:59:00+08:00'),r=t+7*DAY,f=forecast([sample(t-600000,61,r),sample(t,60,r)],{...w,resetsAt:r},'a',t,cfg);assert.ok(f.exhaustsAt>=instant('2026-09-28T00:00:00+08:00'));});

test('expired window cannot generate a fresh forecast',()=>assert.equal(forecast([sample(at-600000,61),sample(at,60)],w,'a',reset+1000,cfg),null));

test('continuation after natural reset does not protect a second reset and delay all cards',()=>{const ww={...w,remaining:100,resetsAt:reset+7*DAY};const pp=createPlan(ww,{...s,at:reset},cfg,reset,{horizon:plan.horizon});assert.ok(pp.schedule[0].plannedAt<ww.resetsAt);assert.equal(pp.horizon,plan.horizon);});
test('continuation after a redeemed card keeps the global workload feasible',()=>{const t=plan.schedule[0].plannedAt,ww={...w,remaining:100,resetsAt:t+7*DAY};const pp=createPlan(ww,{...s,at:t,credits:[s.credits[1]]},cfg,t,{horizon:plan.horizon});assert.equal(pp.schedule.length,1);assert.equal(pp.horizon,plan.horizon);});

test('final retained balance is neither consumption nor waste',()=>{close(plan.consumed,plan.daily.reduce((n,d)=>n+d.amount,0));close(plan.consumed+plan.retained+plan.waste,plan.segments.reduce((n,p)=>n+p.amount,0));assert.ok(plan.retained>=0&&plan.retained<=100);assert.ok(plan.daily.every(d=>d.events.every(e=>e.type!=='horizon')));});
test('fixed horizon persists after final card redemption',()=>{const t=plan.schedule.at(-1).plannedAt;const p=createPlan({...w,remaining:100,resetsAt:t+7*DAY},{...s,at:t,credits:[]},cfg,t,{horizon:plan.horizon});assert.equal(p.end,plan.end);});

import {cardTimeAllowed} from '../planner.mjs';
test('redemption window is Beijing 09:30 to 22:00 inclusive',()=>{for(const [time,allowed] of [['09:29:59',false],['09:30:00',true],['22:00:00',true],['22:00:01',false]])assert.equal(cardTimeAllowed(instant('2026-09-18T'+time+'+08:00')),allowed);for(const c of plan.schedule)assert.ok(cardTimeAllowed(c.plannedAt));const other=createPlan(w,s,settings({timezone:'America/Los_Angeles',calendarTimezone:'UTC'}),at);for(const c of other.schedule)assert.ok(cardTimeAllowed(c.plannedAt));});
test('expiry before next allowed redemption reports infeasible',()=>{const t=instant('2026-09-18T22:01:00+08:00');const p=createPlan(w,{...s,at:t,credits:[card('night','2026-09-19T09:00:00+08:00')]},cfg,t);assert.equal(p.infeasible,true);});

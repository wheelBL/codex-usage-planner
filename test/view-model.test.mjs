import test from 'node:test';
import assert from 'node:assert/strict';
import {overview, dayKey, parseHourRows} from '../public/view-model.js';
const state={now:Date.parse('2026-10-07T01:00:00Z'),config:{calendarTimezone:'Asia/Shanghai'},latest:{creditsKnown:false},plan:{daily:[{date:'2026-10-07',weight:0,amount:0,reason:'国庆'},{date:'2026-10-08',weight:1,amount:50,reason:'工作日'}]}};
const w={bucket:'codex',duration:604800000,remaining:100};
test('rest day zero budget is distinct from missing plan',()=>{const m=overview(state,w);assert.equal(m.today.amount,0);assert.match(m.advice,/仍可正常使用/);assert.equal(m.next.amount,50);assert.equal(overview({...state,plan:null},w).today,undefined);});
test('stale, unknown and restricted usage never gets normal advice',()=>{for(const x of [{...w,remaining:null},{...w,staleWindow:true},undefined])assert.equal(overview(state,x).title,'用量等待更新');assert.equal(overview({...state,stale:true},w).stale,true);assert.equal(overview({...state,latest:{ordinaryUsageAllowed:false}},w).title,'当前额度暂不可用');});
test('other windows do not inherit the main weekly plan',()=>{assert.equal(overview(state,{...w,duration:18000000}).today,undefined);assert.equal(overview(state,{...w,bucket:'other'}).next,undefined);});
test('calendar days honor selected timezone',()=>{assert.equal(dayKey(Date.parse('2026-10-06T20:00:00Z'),'Asia/Shanghai'),'2026-10-07');assert.equal(dayKey(Date.parse('2026-10-06T20:00:00Z'),'America/Los_Angeles'),'2026-10-06');});
test('editable work hours round-trip three segments and end-of-day',()=>{assert.deepEqual(parseHourRows([['09:00','11:45'],['14:00','17:30'],['19:00','22:00']]),[[540,705],[840,1050],[1140,1320]]);assert.deepEqual(parseHourRows([['19:00','00:00']]),[[1140,1440]]);assert.deepEqual(parseHourRows([]),[]);});
test('invalid, reversed and overlapping work periods rejected before saving',()=>{for(const rows of [[['','12:00']],[['13:00','12:00']],[['09:00','12:00'],['11:00','14:00']]])assert.throws(()=>parseHourRows(rows));});


test('live TPS labels retain measured values without inventing streaming token counts',async()=>{
 const {speedOverview}=await import('../public/view-model.js');const now=100000,data={checkedAt:now,selected:{session:'s',status:'generating',model:'m',last:{tps:25.45,at:now-3000},old:false}};
 assert.equal(speedOverview(data,now).value,'25.4');assert.match(speedOverview(data,now).caption,/生成中.*上次响应.*3 秒前/);
 assert.match(speedOverview(data,now+11000).caption,/连接中断.*旧读数/);
 assert.equal(speedOverview({checkedAt:now,selected:{status:'generating'}},now).value,'—');
 assert.match(speedOverview(data,now,false).caption,/连接中断/);
});

test('SSH speed identifies the host and never presents a disconnected source as fresh',async()=>{
 const {speedOverview}=await import('../public/view-model.js');const now=100000,data={checkedAt:now,selected:{session:'s',status:'completed',model:'m',source:{kind:'ssh',label:'v100',connected:true},last:{tps:20,at:now-1000}}};
 assert.match(speedOverview(data,now).caption,/v100.*已更新/);assert.match(speedOverview(data,now).title,/v100/);
 const old={...data,selected:{...data.selected,source:{...data.selected.source,connected:false}}};assert.match(speedOverview(old,now).caption,/连接中断.*旧读数/);assert.equal(speedOverview(old,now).inactive,true);
});

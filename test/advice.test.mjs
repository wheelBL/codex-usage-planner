import test from 'node:test';
import assert from 'node:assert/strict';
import {advise,actionSlots,reminder} from '../advice.mjs';
import {DAY} from '../calendar.mjs';
const at=s=>Date.parse('2026-10-08T'+s+'+08:00');
const config={calendar:'weekdays',calendarTimezone:'Asia/Shanghai',restWeight:0,workHours:[[540,705],[840,1050],[1140,1320]],manualCredits:[]};
function fixture(){return {now:at('10:00:00'),config,latest:{account:'a',creditsKnown:true,credits:[{id:'card',status:'available',resetType:'codexRateLimits',expiresAt:at('22:00:00')}]},windows:[{bucket:'codex',duration:7*DAY,remaining:90,resetsAt:at('22:00:00')+DAY}]};}
test('unknown readings and inventory never recommend redemption',()=>{for(const change of [{stale:true},{validationWarning:'reset'},{latest:{creditsKnown:false}}])assert.equal(advise({...fixture(),...change}).kind,'unknown');});
test('configured periods exclude lunch and reserve fifteen minutes',()=>{const slots=actionSlots(at('09:00:00'),at('22:00:00'),config);assert.deepEqual(slots,[[at('09:00:00'),at('11:30:00')],[at('14:00:00'),at('17:15:00')],[at('19:00:00'),at('21:45:00')]]);});
test('near expiry with high allowance does not invent a need to consume',()=>{const f=fixture();f.latest.credits[0].expiresAt=f.now+60000;assert.equal(advise(f).kind,'deadline');});
test('low allowance needs an active work slot; imminent natural reset takes precedence',()=>{const f=fixture();f.windows[0].remaining=0;assert.equal(advise(f).kind,'consider');f.now=at('12:30:00');assert.notEqual(advise(f).kind,'consider');f.now=at('10:00:00');f.windows[0].resetsAt=f.now+20*60000;assert.equal(advise(f).kind,'natural-soon');});
test('forecast cannot trigger action with short or stale evidence',()=>{const f=fixture();f.windows[0].forecast={since:f.now-29*60000,until:f.now,perDay:90,exhaustsAt:f.now+60000};assert.equal(advise(f).kind,'learning');f.windows[0].forecast.since-=60000;assert.equal(advise(f).kind,'consider');f.windows[0].forecast.until-=180000;assert.equal(advise(f).kind,'learning');});
test('notifications opt in, deduplicate, snooze and dismiss',()=>{const a={alertKey:'a',urgency:'attention',title:'t',detail:'d'};assert.equal(reminder(a,{},10),null);assert.equal(reminder(a,{enabled:true,delivered:'a'},10),null);assert.equal(reminder(a,{enabled:true,dismissed:'a'},10),null);assert.equal(reminder(a,{enabled:true,snoozeId:'a',snoozeUntil:20},10),null);assert.equal(reminder(a,{enabled:true,snoozeId:'a',snoozeUntil:20},21).id,'a');});

test("snooze does not suppress a different card or account",()=>assert.ok(reminder({alertKey:"b",urgency:"attention"},{enabled:true,snoozeId:"a",snoozeUntil:100},10)));

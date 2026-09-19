import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage } from '../reader.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('RPC handshake, usage parsing and bounded timeout',async()=>{
 const code="const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',s=>{const m=JSON.parse(s);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{accountId:'test-account',rateLimits:{primary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}},rateLimitResetCredits:{availableCount:0,credits:[]}}}));});";
 const s=await readUsage({command:[process.execPath,'-e',code,'--']});
 assert.equal(s.windows[0].remaining,80);assert.equal(s.availableCount,0);
 await assert.rejects(readUsage({command:[process.execPath,'-e','setInterval(()=>{},1000)','--'],timeout:150}),/超时/);
});
test('HTTP protections, exact settings and durable history',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-planner-test-'));
 const port=44000+Math.floor(Math.random()*1000), origin='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.mjs','--demo'],{cwd:root,env:{...process.env,PORT:String(port),PLANNER_DATA_DIR:dir},stdio:'ignore',windowsHide:true});
 try {
   let html;
   for(let i=0;i<100;i++){try{html=await (await fetch(origin)).text();break;}catch{await pause(50);}}
   assert.ok(html,'server ready');
   const token=html.match(/name="planner-token" content="([a-f0-9]+)"/)[1], headers={'X-Planner-Token':token,'Content-Type':'application/json'};
   assert.equal((await fetch(origin+'/api/state')).status,403);
   assert.equal((await fetch(origin+'/api/state',{headers:{...headers,Origin:'https://example.com'}})).status,403);
   let state;
   for(let i=0;i<100;i++){state=await (await fetch(origin+'/api/state',{headers})).json();if(state.latest)break;await pause(30);}
   const beforeRefresh=state.latest.at;
   const fresh=await (await fetch(origin+'/api/refresh?force=1',{method:'POST',headers})).json();
   assert.ok(fresh.latest.at>beforeRefresh,'wake refresh bypasses the 30 second cache');
   const workHours=[[540,705],[840,1050],[1140,1320]];
   const scheduled=await (await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({...state.config,workHours})})).json();
   assert.deepEqual(scheduled.config.workHours,workHours);
   assert.deepEqual(JSON.parse(await readFile(path.join(dir,'settings.json'),'utf8')).workHours,workHours);
   // Restore full-day settings before checking the original fixed-baseline assertions.
   state=await (await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify(state.config)})).json();
   assert.equal(state.windows[0].remaining,80);assert.equal(state.latest.account,'demo');assert.ok(state.plan?.anchorAt);const anchor=state.plan.anchorAt;
   const stored=JSON.parse(await readFile(path.join(dir,'plan.json'),'utf8'));assert.equal(stored.plan.anchorAt,anchor);
   const bad=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({manualCredits:[{expiresAt:'2026-09-26'}]})});assert.equal(bad.status,400);
   const saved=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({timezone:'America/Los_Angeles',reserveDays:0})});assert.equal(saved.status,200);const afterSave=await saved.json();assert.equal(afterSave.plan.anchorAt,anchor,'display timezone preserves the baseline');
   const summary=await (await fetch(origin+'/api/summary',{headers})).json();assert.deepEqual(summary.history,[]);
   assert.equal(JSON.parse(await readFile(path.join(dir,'settings.json'),'utf8')).timezone,'America/Los_Angeles');
   assert.ok((await readFile(path.join(dir,'history.jsonl'),'utf8')).includes('naturalTarget'));
 } finally {child.kill();}
});

test('native host secret authenticates only its own server', async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-planner-native-'));
 const token='a'.repeat(64), port=46000+Math.floor(Math.random()*1000), origin=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.mjs','--demo'],{cwd:root,env:{...process.env,PORT:String(port),PLANNER_DATA_DIR:dir,PLANNER_SESSION_TOKEN:token},stdio:'ignore'});
 try {
   let response;
   for(let i=0;i<100;i++){try{response=await fetch(origin+'/api/summary',{headers:{'X-Planner-Token':token}});break;}catch{await pause(50);}}
   assert.equal(response?.status,200);
   assert.equal((await fetch(origin+'/api/summary',{headers:{'X-Planner-Token':'b'.repeat(64)}})).status,403);
 } finally { child.kill(); }
});

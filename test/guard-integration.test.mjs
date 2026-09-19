import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('shared HTTP path preserves plans, rejects replan and persists pending resets',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'planner-guard-'));
 const fixture=path.join(dir,'reply.json'),script=path.join(dir,'rpc.cjs');
 await writeFile(script,`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:JSON.parse(fs.readFileSync(process.argv[2],'utf8'))}));});`);
 const now=Date.now(), reset=Math.floor((now+2*86400000)/1000);
 const reply={accountId:'fixture-account',rateLimits:{primary:{usedPercent:50,windowDurationMins:10080,resetsAt:reset}},rateLimitResetCredits:{availableCount:1,credits:[{id:'card',status:'available',resetType:'codexRateLimits',expiresAt:Math.floor((now+8*86400000)/1000)}]}};
 await writeFile(fixture,JSON.stringify(reply));
 const port=48000+Math.floor(Math.random()*1000),origin=`http://127.0.0.1:${port}`,token='c'.repeat(64);
 const headers={'X-Planner-Token':token};let child;
 const api=async(route,method='GET')=>fetch(origin+'/api/'+route,{method,headers});
 async function stop(){if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
 async function start(){
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,CODEX_HOME:dir,CODEX_COMMAND:JSON.stringify([process.execPath,script,fixture,'--']),PLANNER_DATA_DIR:dir,PLANNER_SESSION_TOKEN:token,PORT:String(port)},stdio:'ignore'});
  for(let i=0;i<100;i++){try{const s=await (await api('state')).json();if(s.latest)return s;}catch{}await pause(50);}
  throw new Error('server did not start');
 }
 try {
  let state=await start();const anchor=state.plan.anchorAt;
  reply.rateLimitResetCredits={availableCount:1,credits:null};await writeFile(fixture,JSON.stringify(reply));
  state=await (await api('refresh?force=1','POST')).json();
  assert.equal(state.plan.anchorAt,anchor);assert.equal(state.latest.credits[0].id,'card');assert.equal(state.latest.creditsUncertain,true);
  const history=await readFile(path.join(dir,'history.jsonl'),'utf8');
  reply.rateLimits.primary.usedPercent=0;reply.rateLimits.primary.resetsAt=reset+86400;
  await writeFile(fixture,JSON.stringify(reply));
  state=await (await api('refresh?force=1','POST')).json();
  assert.ok(state.validationWarning);assert.equal(state.stale,true);assert.equal(state.latest.windows[0].remaining,50);
  assert.equal(state.plan.anchorAt,anchor);assert.equal((await api('replan','POST')).status,409);
  assert.equal(await readFile(path.join(dir,'history.jsonl'),'utf8'),history);
  await stop();state=await start();
  state=await (await api('refresh?force=1','POST')).json();
  assert.ok(state.validationWarning);assert.equal(state.latest.windows[0].remaining,50);
  reply.rateLimits.primary.usedPercent=51;reply.rateLimits.primary.resetsAt=reset;await writeFile(fixture,JSON.stringify(reply));
  state=await (await api('refresh?force=1','POST')).json();
  assert.equal(state.validationWarning,null);assert.equal(state.latest.windows[0].remaining,49);assert.equal(state.plan.anchorAt,anchor);
 } finally {await stop();}
});

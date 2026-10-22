// Synthetic data only. Compare the same Node runtime and machine after warmup.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const {settings, budget, forecast, DAY} = await import(pathToFileURL(path.join(root, 'core.mjs')));
const {advise} = await import(pathToFileURL(path.join(root, 'advice.mjs')));
const now = Date.parse('2026-10-22T06:00:00Z');
const config = settings({workHours:[[540,720],[840,1080]], calendar:'weekends'});
const window = {key:'codex:primary',bucket:'codex',duration:7*DAY,resetsAt:now+2*DAY,remaining:60};
const history = Array.from({length:90*1440}, (_,i) => ({at:now-(90*1440-1-i)*60000, account:'benchmark', windows:[{...window,remaining:Math.min(100,60+(90*1440-1-i)*0.01)}]}));
const latest = {...history.at(-1),creditsKnown:true,credits:[{id:'demo',status:'available',resetType:'codexRateLimits',expiresAt:now+8*DAY}]};
const compute = () => {
  const windows = [{...budget(window,latest,config,now),forecast:forecast(history,window,latest.account,now,config)}];
  return advise({latest,windows,config,now,stale:false});
};
for(let i=0;i<5;i++) compute();
const samples=[];
for(let i=0;i<40;i++){const start=performance.now();compute();samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,historyRows:history.length,iterations:samples.length,medianMs:+samples[20].toFixed(3),p95Ms:+samples[38].toFixed(3)},null,2));

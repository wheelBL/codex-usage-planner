import http from 'node:http';
import {createPollScheduler} from './polling.mjs';
import {describeFailure,failureLabel} from './diagnostics.mjs';
import { readFile, writeFile, mkdir, rename, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { settings, budget, forecast, DAY, normalize } from './core.mjs';
import { readUsage } from './reader.mjs';
import { readOAuthUsage } from './oauth.mjs';
import { createPlan, availableCards } from './planner.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const demo = process.argv.includes('--demo');
const port = Number(process.env.PORT || (demo ? 43128 : 43127));
const dataDir = process.env.PLANNER_DATA_DIR || path.join(root, 'data', demo ? 'demo' : 'live');
await mkdir(dataDir, { recursive: true });
// A native host pins its own per-launch secret before connecting to the local server.
const hostToken = process.env.PLANNER_SESSION_TOKEN;
if (hostToken !== undefined && !/^[a-f0-9]{64}$/i.test(hostToken)) throw new Error('Invalid native session token');
const token = hostToken || randomBytes(24).toString('hex');
const origin = `http://127.0.0.1:${port}`;
const configFile = path.join(dataDir, 'settings.json'), historyFile = path.join(dataDir, 'history.jsonl');
let config = settings(), history = [], latest = null, error = null, active = null;
let persistenceError = null;
try { config = settings(JSON.parse(await readFile(configFile, 'utf8'))); }
catch (e) { if (e.code !== 'ENOENT') throw new Error('settings.json 损坏，请修复或备份后移走该文件。'); }
try {
  const lines = (await readFile(historyFile, 'utf8')).split('\n').filter(Boolean);
  for (const [i, line] of lines.entries()) {
    try {
      const s = JSON.parse(line);
      if (!Number.isFinite(s.at) || !Array.isArray(s.windows) || !s.account) throw new Error();
      if (s.at > Date.now() - 90 * DAY) history.push(s);
    } catch { persistenceError = `历史文件第 ${i + 1} 行损坏，已跳过；原文件保留。`; }
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }
latest = history.at(-1) || null;
const planFile=path.join(dataDir,'plan.json');let plan=null,planKey=null;
try{const saved=JSON.parse(await readFile(planFile,'utf8'));if(saved.plan?.version===5){plan=saved.plan;planKey=saved.key;}}catch{}
async function updatePlan(snapshot,force=false){
 const w=snapshot?.windows.find(w=>w.bucket==='codex'&&w.duration===7*DAY);if(!w)return;
 const planningConfig={...config};delete planningConfig.timezone;if(!planningConfig.manualCredits.length)delete planningConfig.manualAccount;
 const key=JSON.stringify([snapshot.account,w.resetsAt,planningConfig,availableCards(snapshot,config,Date.now()).map(c=>[c.id,Math.floor(c.expiresAt/1000)])]);
 if(!force&&key===planKey&&plan)return;
 const horizon=plan?.account===snapshot.account&&plan.horizon>Date.now()?plan.horizon:undefined;
 plan=createPlan(w,snapshot,config,Date.now(),{horizon});planKey=key;
 await writeFile(planFile+'.tmp',JSON.stringify({key,plan}),{mode:0o600});await rename(planFile+'.tmp',planFile);
}
let failures = 0, outageSince=null, lastCompaction = Date.now();
const demoStarted = Date.now();
function demoSnapshot() {
  const now = Date.now();
  return normalize({ accountId: 'demo', rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor((demoStarted + 2 * DAY) / 1000) } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'demo', status: 'available', resetType: 'codexRateLimits', expiresAt: Math.floor((demoStarted + 8 * DAY) / 1000) }] } }, 'demo', now);
}
async function recordDiagnostic(event){try{const file=path.join(dataDir,'reader-diagnostics.jsonl');if((await stat(file).catch(()=>({size:0}))).size>65536)await rename(file,file+'.previous');await appendFile(file,JSON.stringify({at:Date.now(),...event})+'\n',{mode:0o600});}catch{}}
async function refresh() {
  if (active) return active;
  active = (async () => {
    try {
      let snapshot;
      if (demo) snapshot = demoSnapshot();
      else {
        try { snapshot = await readOAuthUsage({onDiagnostic:recordDiagnostic}); }
        catch (oauthError) {const first=oauthError.diagnostic||describeFailure(oauthError,'oauth-usage');await recordDiagnostic(first);try{snapshot=await readUsage();await recordDiagnostic({stage:'rpc-fallback',category:'recovered'});}catch(rpcError){const second=rpcError.diagnostic||describeFailure(rpcError,'rpc-fallback');await recordDiagnostic(second);throw new Error('OAuth：'+failureLabel(first)+'；RPC：'+failureLabel(second));}}
      }
      await updatePlan(snapshot);
      snapshot.planAnchor=plan?.anchorAt??null; snapshot.planVersion=5;
      snapshot.windows = snapshot.windows.map(w => {
        const b = budget(w, snapshot, config, snapshot.at, plan);
        return { ...w, target: b.target, naturalTarget: b.naturalTarget, deadline: b.deadline };
      });
      latest = snapshot;
      history.push(snapshot);
      history = history.filter(s => s.at > Date.now() - 90 * DAY);
      await appendFile(historyFile, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
      if (!persistenceError && Date.now() - lastCompaction > DAY) {
        await writeFile(historyFile + '.tmp', history.map(s => JSON.stringify(s)).join('\n') + '\n', {mode:0o600});
        await rename(historyFile + '.tmp', historyFile);
        lastCompaction = Date.now();
      }
      if(outageSince!==null){await recordDiagnostic({stage:'recovery',category:'recovered',outageMs:Date.now()-outageSince});outageSince=null;}
      error = null; failures = 0;
    } catch (e) { error = e.message; failures++;outageSince??=Date.now(); }
  })().finally(() => { active = null; });
  return active;
}
const poller=createPollScheduler(refresh,()=>error);
function schedulePoll(){poller.schedule();}
function state(days = 7) {
  const now = Date.now();
  const rows = latest ? history.filter(s => s.account === latest.account) : [];
  return { demo, now, config, latest, plan: days>0?plan:null, error, persistenceError, refreshing: !!active,nextPollAt:poller.nextAt,
    stale: !latest || !!error || now - latest.at > 150000,
    windows: latest?.windows.map(w => ({ ...budget(w, latest, config, now, plan), forecast: forecast(rows, w, latest.account, now, config) })) || [],
    history: days > 0 ? rows.filter(s => s.at >= now - days * DAY) : [] };
}
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return json(403, { error: '仅允许本机同源请求' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && files[url.pathname]) {
      const [name, type] = files[url.pathname];
      let content = await readFile(path.join(root, 'public', name), 'utf8');
      if (name === 'index.html') content = content.replace('__TOKEN__', token);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
    }
    if (req.headers['x-planner-token'] !== token) return json(403, { error: '请重新打开本机页面' });
    const days = [1,7,30,90].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
    if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state(days));
    if (req.method === 'GET' && url.pathname === '/api/summary') return json(200, state(0));
    if (req.method === 'GET' && url.pathname === '/api/export') return json(200, latest ? history.filter(s => s.account === latest.account) : []);
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (url.searchParams.get('force') === '1' || !latest || Date.now() - latest.at >= 30000) await refresh();
      schedulePoll();
      return json(200, state(days));
    }
    if (req.method === 'POST' && url.pathname === '/api/replan') {
      if(!latest||error||Date.now()-latest.at>150000)return json(409,{error:'请先获取新鲜用量再重算计划'});
      await updatePlan(latest,true);return json(200,state(days));
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16000) return json(413, { error: '配置过大' }); }
      const next = settings({ ...JSON.parse(body), manualAccount: latest?.account });
      await writeFile(configFile + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(configFile + '.tmp', configFile); config = next;
      if(latest)await updatePlan(latest);
      return json(200, state(days));
    }
    return json(404, { error: 'Not found' });
  } catch (e) { return json(400, { error: e.message }); }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请检查是否已经启动。` : e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => { console.log(`Codex Usage Planner: ${origin}${demo ? ' (DEMO)' : ''}`); refresh().then(schedulePoll); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { poller.stop(); server.close(); process.exit(0); });

if(process.env.PLANNER_PARENT_PID){const parent=Number(process.env.PLANNER_PARENT_PID);setInterval(()=>{try{process.kill(parent,0);}catch{poller.stop();server.close();process.exit(0);}},5000).unref();}

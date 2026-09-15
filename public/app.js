const $ = id => document.getElementById(id);
if(new URLSearchParams(location.search).has('embedded'))document.body.classList.add('embedded');
for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',()=>{for(const pane of document.querySelectorAll('[data-pane]'))pane.hidden=pane.dataset.pane!==tab.dataset.tab;for(const button of document.querySelectorAll('[data-tab]'))button.classList.toggle('active',button===tab);requestAnimationFrame(draw);});
const token = document.querySelector('meta[name="planner-token"]').content;
let state, selected, initialized = false, plotted = [];
const pct = n => n == null ? '—' : `${n.toFixed(2)}%`;
const date = (t, short = false) => t == null ? '未知' : new Intl.DateTimeFormat('zh-CN', { timeZone: state.config.timezone,
  month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', ...(short ? {} : {year:'numeric',second:'2-digit',timeZoneName:'shortOffset'}), hourCycle:'h23' }).format(t);
async function api(route, value) {
  const response = await fetch(`/api/${route}?days=${$('range').value}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'X-Planner-Token':token, 'Content-Type':'application/json' }, body:value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function render(next) {
  state = next;
  const old = selected;
  $('window').replaceChildren(...state.windows.map(w => new Option(`${w.name} · ${w.duration == null ? '未知窗口' : w.duration / 3600000 + ' 小时'}`, w.key)));
  selected = state.windows.some(w => w.key === old) ? old : (state.windows.find(w => w.bucket === 'codex') || state.windows[0])?.key;
  if (selected) $('window').value = selected;
  if (!initialized) {
    if (![...$('timezone').options].some(o => o.value === state.config.timezone)) $('timezone').add(new Option(state.config.timezone));
    $('timezone').value = state.config.timezone; $('calendar-timezone').value=state.config.calendarTimezone; $('calendar').value=state.config.calendar; $('rest-weight').value=state.config.restWeight; $('overrides').value=Object.entries(state.config.dayOverrides).map(([d,w])=>d+'='+w).join('\n');
    $('manual').value = state.config.manualCredits.map(c => c.expiresAt).join('\n'); initialized = true;
  }
  $('status').className = state.stale || state.demo || state.persistenceError ? 'warn' : '';
  $('status').textContent = [state.demo ? '演示模式 · 示例数据，与真实历史隔离。' : '本机 Codex 状态',
    state.error ? state.error+(state.refreshing?' · 正在重试':state.nextPollAt?' · 下次检查 '+date(state.nextPollAt,true):'') : (state.stale ? '等待新数据；旧快照不可视为当前额度。' : '已连接 · 自动记录中'),
    state.latest?.ordinaryUsageAllowed === false ? '服务端当前不允许普通额度使用。' : '', state.latest?.creditsWarning || '', state.config.manualAccount && state.config.manualAccount !== state.latest?.account && state.config.manualCredits.length ? '手动卡片属于其他账户，已停用' : '', state.persistenceError || ''].filter(Boolean).join('  /  ');
  $('sample').textContent = state.latest ? `采样于 ${date(state.latest.at)}` : '暂无采样';
  const w = state.windows.find(w => w.key === selected);
  if (!w) { draw(); return; }
  $('actual').textContent = pct(w.remaining);
  $('actual-detail').textContent = state.stale || w.staleWindow ? '上次已知值 · 等待有效窗口数据' : '服务端剩余额度';
  $('target').textContent = pct(w.target);
  $('target-detail').textContent = w.overdue ? '计划时间已过，请调整预算或在 Codex 中处理' : state.plan ? '按已保存的工作日计划比较' : '按自然重置和日历计算';
  $('gap').textContent = w.gap == null ? '—' : `${w.gap >= 0 ? '+' : ''}${w.gap.toFixed(2)}`;
  $('gap-detail').textContent = w.gap == null ? '等待有效重置时间' : `百分点 · ${w.gap >= 0 ? '比目标充裕' : '消耗快于目标'}`;
  $('speed').textContent = w.requiredPerDay == null ? '—' : w.requiredPerDay.toFixed(2);
  $('reset').textContent = date(w.resetsAt); $('deadline').textContent = date(w.deadline); $('natural').textContent = pct(w.naturalTarget);
  $('credits-count').textContent = state.latest.availableCount ?? '未知';
  $('credits').replaceChildren();
  for (const [i, c] of w.schedule.entries()) {
    const div = document.createElement('div'); div.className = 'card';
    const title = document.createElement('strong'); title.textContent = `第 ${i+1} 张 · ${c.plannedAt<=state.now ? '计划已逾期' : '待兑换'}${c.beforeGrant ? ' · 早于发卡，计划不可行' : ''}`;
    const detail = document.createElement('div'); detail.textContent = `建议兑换 ${date(c.plannedAt)} ｜ 到期 ${date(c.expiresAt)}`;
    div.append(title, detail); $('credits').append(div);
  }
  if (!w.schedule.length) $('credits').textContent = w.duration !== 604800000 || w.bucket !== 'codex' ? '重置卡策略应用于 Codex 主额度的周窗口；其他池按自然重置展示。' : state.latest.creditsKnown ? '无待安排的有效到期卡片（无期限卡不强制安排）。' : '服务端未提供卡片明细，可手动填写到期时间。';
  else if (!state.config.manualCredits.length && state.latest.availableCount > state.latest.credits.length) $('credits').append(document.createTextNode('卡片清单不完整，当前计划只包含已知到期时间。'));
  const f = w.forecast;
  $('forecast').textContent = !f || state.stale ? '消耗趋势：需要至少 5 分钟的连续有效样本；断采或重置后重新积累。' : `近 ${((f.until-f.since)/3600000).toFixed(2)} 小时平均消耗 ${f.perDay.toFixed(2)} 百分点/有效工作日；预计自然重置时剩余 ${pct(f.atReset)}。${f.exhaustsAt ? '线性耗尽时间 ' + date(f.exhaustsAt) : '样本期间未观测到额度下降'}。此推算不能保证未来用量。`;
  renderPlan();
  const core=state.windows.find(w=>w.bucket==='codex'&&w.duration===7*86400000);if(window.chrome?.webview)window.chrome.webview.postMessage({remaining:core?.remaining??null,gap:core?.gap??null,plannedPerWorkday:core?.plannedPerWorkday??null,stale:state.stale||core?.remaining==null,error:state.error||(state.stale?'数据已过期':'')});
  draw();
}
function draw() {
  const canvas = $('chart'), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if(!box.width||!box.height)return;
  canvas.width = box.width * dpr; canvas.height = box.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=box.width,H=box.height,p={l:45,r:18,t:12,b:35};
  ctx.font = '11px Segoe UI'; ctx.fillStyle='#98a6ae';
  const w = state?.windows.find(w => w.key === selected);
  if (!w) { ctx.fillText('等待首次成功采样…',30,50); return; }
  const now=state.now, from=now-Number($('range').value)*86400000;
  const to=Math.max(now+3600000, Math.min((w.bucket==='codex'?state.plan?.end:null)||w.resetsAt||now,now+Number($('range').value)*86400000));
  const x=t=>p.l+(t-from)/(to-from)*(W-p.l-p.r), y=v=>p.t+(100-v)/100*(H-p.t-p.b);
  for(let n=0;n<=100;n+=25){ctx.strokeStyle='#303a42';ctx.beginPath();ctx.moveTo(p.l,y(n));ctx.lineTo(W-p.r,y(n));ctx.stroke();ctx.fillText(`${n}%`,4,y(n)+4);}
  const ticks=W<600?3:5;for(let i=0;i<ticks;i++){const t=from+(to-from)*i/(ticks-1);ctx.fillText(date(t,true),Math.min(W-108,Math.max(0,x(t)-42)),H-8);}
  const line=(points,color,dash=[])=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash(dash);ctx.beginPath();let pen=false;for(const point of points){if(!point){pen=false;continue;}const [t,v]=point;if(pen)ctx.lineTo(x(t),y(v));else ctx.moveTo(x(t),y(v));pen=true;}ctx.stroke();ctx.setLineDash([]);};
  const rows=state.history.filter(s=>s.at>=from&&s.at<=now);
  const actual=[],nat=[],plan=[];plotted=[];let prev;
  for(const s of rows){const a=s.windows.find(v=>v.key===selected);if(!a||a.remaining==null){actual.push(null);nat.push(null);plan.push(null);prev=null;continue;}
    const discontinuity=prev&&(a.resetsAt!==prev.w.resetsAt||a.duration!==prev.w.duration||a.remaining>prev.w.remaining||s.at-prev.at>150000);
    if(discontinuity){actual.push(null);nat.push(null);plan.push(null);}
    if(prev&&prev.planAnchor!==s.planAnchor)plan.push(null);
    actual.push([s.at,a.remaining]);
    // Budget values saved with each sample preserve the policy that was active then.
    if(a.naturalTarget!=null)nat.push([s.at,a.naturalTarget]);else nat.push(null);
    if(a.target!=null)plan.push([s.at,a.target]);else plan.push(null);
    plotted.push({at:s.at,remaining:a.remaining,x:x(s.at),y:y(a.remaining)});prev={at:s.at,w:a,planAnchor:s.planAnchor};
  }
  ctx.save();ctx.beginPath();ctx.rect(p.l,p.t,W-p.l-p.r,H-p.t-p.b);ctx.clip();
  line(nat,'#7f8d99');line(plan,'#c5b3ff');line(actual,'#9fe8c8');
  for(const a of plotted){ctx.fillStyle='#9fe8c8';ctx.beginPath();ctx.arc(a.x,a.y,2.5,0,Math.PI*2);ctx.fill();}
  const dates=state.plan?.daily||[];
  const work=(a,b)=>dates.reduce((sum,d)=>sum+Math.max(0,Math.min(b,d.end)-Math.max(a,d.start))/(d.end-d.start)*d.weight,0);
  const cuts=(a,b)=>[a,...dates.map(d=>d.end).filter(t=>t>a&&t<b),b];
  if(w.naturalTarget!=null){const units=work(now,w.resetsAt);line(cuts(now,w.resetsAt).map(t=>[t,units?w.naturalTarget*work(t,w.resetsAt)/units:0]),'#7f8d99',[4,5]);}
  if(w.bucket==='codex'&&state.plan?.segments?.length)for(const s of state.plan.segments){if(s.end<now)continue;line(cuts(Math.max(now,s.start),s.end).map(t=>[t,Math.max(0,s.amount-s.rate*work(s.start,t))]),'#c5b3ff',[6,5]);}

  if(w.forecast&&!state.stale){const f=w.forecast;const end=Math.min(to,f.exhaustsAt||to,w.resetsAt||to);line(cuts(state.latest.at,end).map(t=>[t,Math.max(0,w.remaining-f.perDay*work(state.latest.at,t))]),'#f1be7d',[3,5]);}
  ctx.strokeStyle='#748a85';ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(x(now),p.t);ctx.lineTo(x(now),H-p.b);ctx.stroke();ctx.setLineDash([]);ctx.restore();
  ctx.fillStyle='#98a6ae';ctx.fillText('现在',Math.min(W-35,x(now)+5),p.t+12);
  if(!plotted.length)ctx.fillText('所选时段暂无历史采样',p.l+15,p.t+35);
}
$('chart').addEventListener('mousemove',event=>{const x=event.offsetX;const row=plotted.reduce((best,r)=>!best||Math.abs(r.x-x)<Math.abs(best.x-x)?r:best,null);if(row)$('hover').textContent=`${date(row.at)} · 实际剩余 ${pct(row.remaining)}`;});
$('window').addEventListener('change',()=>{selected=$('window').value;render(state);});
$('range').addEventListener('change',update);window.addEventListener('resize',draw);
$('refresh').addEventListener('click',async()=>{ $('refresh').disabled=true;try{render(await api('refresh',{}));}catch(e){$('status').textContent=e.message;}finally{$('refresh').disabled=false;} });
$('settings').addEventListener('submit',async event=>{event.preventDefault();try{
 const dayOverrides={};for(const row of $('overrides').value.split('\n').map(s=>s.trim()).filter(Boolean)){const pair=row.split('=');if(pair.length!==2||!pair[1].trim())throw new Error('每行格式为 YYYY-MM-DD=0 或 YYYY-MM-DD=1');dayOverrides[pair[0].trim()]=Number(pair[1]);}
 render(await api('settings',{timezone:$('timezone').value,calendarTimezone:$('calendar-timezone').value,calendar:$('calendar').value,restWeight:Number($('rest-weight').value),dayOverrides,manualCredits:$('manual').value.split('\n').map(s=>s.trim()).filter(Boolean).map(expiresAt=>({expiresAt}))}));$('saved').textContent='已保存并更新计划';
 }catch(e){$('saved').textContent=e.message;}});
$('replan').addEventListener('click',async()=>{try{render(await api('replan',{}));}catch(e){$('plan-warning').textContent=e.message;}});
$('export').addEventListener('click',async()=>{try{const rows=await api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='codex-usage-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('status').textContent=e.message;}});
async function update(){try{render(await api('state'));}catch(e){$('status').textContent='状态服务不可达：'+e.message;$('status').className='warn';window.chrome?.webview?.postMessage({stale:true,error:'本机状态服务不可达'});}}
await update();setInterval(update,15000);

function renderPlan(){
 const p=state.plan; if(!p){$('plan-summary').textContent='等待有效的主额度周窗口';return;}
 $('plan-summary').textContent='工作日峰值 '+(p.peak?.toFixed(2)??'—')+' 点 · 平均 '+(p.mean?.toFixed(2)??'—')+' 点 · 波动标准差 '+(Math.sqrt(p.variance||0).toFixed(2))+' 点 · 丢弃 '+(p.waste?.toFixed(2)??'—')+' 点';
 $('plan-baseline').textContent='用卡时段：北京时间09:30–22:00。统一比较至 '+date(p.end)+' · 预计消耗 '+(p.consumed?.toFixed(2)??'—')+' 点，期末保留 '+(p.retained?.toFixed(2)??'—')+' 点。计划基准 '+date(p.anchorAt)+' · 日历时区 '+state.config.calendarTimezone+'。实际使用偏离时保留基准，点击重算可按新余量调整。';
 $('plan-warning').textContent=p.warnings.join(' ');$('daily-rows').replaceChildren();$('daily-chart').replaceChildren();const maximum=Math.max(1,...p.daily.map(d=>d.amount));
 for(const d of p.daily){const row=document.createElement('tr');if(!d.weight)row.className='rest';for(const text of [d.date,d.reason,d.amount.toFixed(2)+' 点',d.events.map(e=>(e.type==='card'?'用卡':'自然重置')+' '+date(e.at,true)).join(' / ')]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}$('daily-rows').append(row);
 const bar=document.createElement('div');bar.className='day-bar'+(d.weight?'':' rest');bar.title=d.date+' '+d.reason+'：'+d.amount.toFixed(2)+' 点';const fill=document.createElement('div');fill.className='day-fill';fill.style.height=Math.max(2,d.amount/maximum*105)+'px';const label=document.createElement('span');label.className='day-label';label.textContent=d.date.slice(8);bar.append(fill,label);for(const e of d.events.filter(e=>e.type==='card')){const badge=document.createElement('span');badge.className='card-marker';badge.textContent='用卡 '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(e.at);badge.title=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'full',timeStyle:'short'}).format(e.at)+' 北京时间';bar.append(badge);bar.classList.add('has-card');} $('daily-chart').append(bar);}
}

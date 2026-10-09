import {formatAmount, dayKey, overview, parseHourRows, speedOverview} from './view-model.js';
const $ = id => document.getElementById(id);
if(new URLSearchParams(location.search).has('embedded'))document.body.classList.add('embedded');
function navigate(name) {
  for(const pane of document.querySelectorAll('[data-pane]')) pane.hidden=pane.dataset.pane!==name;
  for(const button of document.querySelectorAll('[data-tab]')) {const active=button.dataset.tab===name;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  window.scrollTo(0,0); requestAnimationFrame(()=>{draw();drawGauge();});
}
for(const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click',()=>navigate(tab.dataset.tab));
const token = document.querySelector('meta[name="planner-token"]').content;
let state, selected, initialized = false, plotted = [], speedSelection='';
let speedRequest=0, speedLoading=false, recentSpeed=null, speedConnected=true;
const pct = n => n == null ? '—' : `${n.toFixed(2)}%`;
const date = (t, short = false) => t == null ? '未知' : new Intl.DateTimeFormat('zh-CN', { timeZone: state?.config?.timezone||'Asia/Shanghai',
  month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', ...(short ? {} : {year:'numeric',second:'2-digit',timeZoneName:'shortOffset'}), hourCycle:'h23' }).format(t);
async function api(route, value) {
  const response = await fetch(`/api/${route}?days=${$('range').value}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'X-Planner-Token':token, 'Content-Type':'application/json' }, body:value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
function render(next) {
  state = next;
  const old = selected;
  $('window').replaceChildren(...state.windows.map(w => new Option(`${w.name} · ${w.duration == null ? '未知窗口' : w.duration / 3600000 + ' 小时'}`, w.key)));
  selected = state.windows.some(w => w.key === old) ? old : (state.windows.find(w => w.bucket === 'codex' && w.duration === 604800000) || state.windows[0])?.key;
  if (selected) $('window').value = selected;
  if (!initialized) {
    if (![...$('timezone').options].some(o => o.value === state.config.timezone)) $('timezone').add(new Option(state.config.timezone));
    $('timezone').value = state.config.timezone; $('calendar-timezone').value=state.config.calendarTimezone; $('calendar').value=state.config.calendar; $('rest-weight').value=state.config.restWeight; renderHours(state.config.workHours||[]); $('reminders-enabled').checked=state.config.remindersEnabled===true; $('overrides').value=Object.entries(state.config.dayOverrides).map(([d,w])=>d+'='+w).join('\n');
    $('manual').value = state.config.manualCredits.map(c => c.expiresAt).join('\n'); renderSSH(state.config.speedSources||[]); initialized = true;
  }
  $('status').className = state.stale || state.demo || state.persistenceError ? 'warn' : '';
  $('status').textContent = [state.demo ? '演示模式 · 示例数据，与真实历史隔离。' : '本机 Codex 状态',
    state.error ? state.error+(state.refreshing?' · 正在重试':state.nextPollAt?' · 下次检查 '+date(state.nextPollAt,true):'') : (state.stale ? '等待新数据；旧快照不可视为当前额度。' : '已连接 · 自动记录中'),
    state.validationWarning || '', state.latest?.ordinaryUsageAllowed === false ? '服务端当前不允许普通额度使用。' : '', state.latest?.creditsWarning || '', state.config.manualAccount && state.config.manualAccount !== state.latest?.account && state.config.manualCredits.length ? '手动卡片属于其他账户，已停用' : '', state.persistenceError || ''].filter(Boolean).join('  /  ');
  $('sample').textContent = state.latest ? `${date(state.latest.at,true)} 更新` : '尚未更新';
  const w = state.windows.find(w => w.key === selected);
  renderOverview(w);
  if (!w) { for(const id of ['actual','target','gap','speed','credits-count','reset','deadline','natural'])$(id).textContent='—'; $('actual-detail').textContent='等待有效数据'; $('credits').replaceChildren(); renderPlan(); draw(); return; }
  $('actual').textContent = w.remaining == null ? '—' : formatAmount(w.remaining)+'%';
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
    const detail = document.createElement('div'); detail.textContent = `容量参考时刻 ${date(c.plannedAt)} ｜ 到期 ${date(c.expiresAt)}`;
    div.append(title, detail); $('credits').append(div);
  }
  if (!w.schedule.length) $('credits').textContent = w.duration !== 604800000 || w.bucket !== 'codex' ? '重置卡策略应用于 Codex 主额度的周窗口；其他池按自然重置展示。' : state.latest.creditsKnown ? '无待安排的有效到期卡片（无期限卡不强制安排）。' : '服务端未提供卡片明细，可手动填写到期时间。';
  else if (!state.config.manualCredits.length && state.latest.availableCount > state.latest.credits.length) $('credits').append(document.createTextNode('卡片清单不完整，当前计划只包含已知到期时间。'));
  const f = w.forecast;
  $('forecast').textContent = !f || state.stale ? '消耗趋势：需要至少 5 分钟的连续有效样本；断采或重置后重新积累。' : `近 ${((f.until-f.since)/3600000).toFixed(2)} 小时平均消耗 ${f.perDay.toFixed(2)} 百分点/有效工作日；预计自然重置时剩余 ${pct(f.atReset)}。${f.exhaustsAt ? '线性耗尽时间 ' + date(f.exhaustsAt) : '样本期间未观测到额度下降'}。此推算不能保证未来用量。`;
  renderPlan();
  const core=state.windows.find(w=>w.bucket==='codex'&&w.duration===7*86400000);if(window.chrome?.webview)window.chrome.webview.postMessage({remaining:core?.remaining??null,gap:core?.gap??null,plannedPerWorkday:core?.plannedPerWorkday??null,reminder:state.reminder,stale:state.stale||core?.remaining==null,error:state.validationWarning||state.error||(state.stale?'数据已过期':'')});
  draw(); drawGauge();
}
function draw() {
  const canvas = $('chart'), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if(!box.width||!box.height)return;
  canvas.width = box.width * dpr; canvas.height = box.height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=box.width,H=box.height,p={l:45,r:18,t:12,b:35};
  ctx.font = '11px Segoe UI'; ctx.fillStyle='#637080';
  const w = state?.windows.find(w => w.key === selected);
  if (!w) { ctx.fillText('等待首次成功采样…',30,50); return; }
  const now=state.now, from=now-Number($('range').value)*86400000;
  const to=Math.max(now+3600000, Math.min((w.bucket==='codex'?state.plan?.end:null)||w.resetsAt||now,now+Number($('range').value)*86400000));
  const x=t=>p.l+(t-from)/(to-from)*(W-p.l-p.r), y=v=>p.t+(100-v)/100*(H-p.t-p.b);
  for(let n=0;n<=100;n+=25){ctx.strokeStyle='#e1e6e9';ctx.beginPath();ctx.moveTo(p.l,y(n));ctx.lineTo(W-p.r,y(n));ctx.stroke();ctx.fillText(`${n}%`,4,y(n)+4);}
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
  line(nat,'#71818c');line(plan,'#7054a0');line(actual,'#2e8d69');
  for(const a of plotted){ctx.fillStyle='#2e8d69';ctx.beginPath();ctx.arc(a.x,a.y,2.5,0,Math.PI*2);ctx.fill();}
  const dates=state.plan?.daily||[];
  const work=(a,b)=>dates.reduce((sum,d)=>sum+(d.intervals||[[d.start,d.end]]).reduce((n,[x,y])=>n+Math.max(0,Math.min(b,y)-Math.max(a,x)),0)/(d.activeDuration||d.end-d.start)*d.weight,0);
  const cuts=(a,b)=>[...new Set([a,...dates.flatMap(d=>[d.end,...(d.intervals||[]).flat()]).filter(t=>t>a&&t<b),b])].sort((x,y)=>x-y);
  if(w.naturalTarget!=null){const units=work(now,w.resetsAt);line(cuts(now,w.resetsAt).map(t=>[t,units?w.naturalTarget*work(t,w.resetsAt)/units:0]),'#71818c',[4,5]);}
  if(w.bucket==='codex'&&state.plan?.segments?.length)for(const s of state.plan.segments){if(s.end<now)continue;line(cuts(Math.max(now,s.start),s.end).map(t=>[t,Math.max(0,s.amount-s.rate*work(s.start,t))]),'#7054a0',[6,5]);}

  if(w.forecast&&!state.stale){const f=w.forecast;const end=Math.min(to,f.exhaustsAt||to,w.resetsAt||to);line(cuts(state.latest.at,end).map(t=>[t,Math.max(0,w.remaining-f.perDay*work(state.latest.at,t))]),'#a56c1c',[3,5]);}
  ctx.strokeStyle='#748a85';ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(x(now),p.t);ctx.lineTo(x(now),H-p.b);ctx.stroke();ctx.setLineDash([]);ctx.restore();
  ctx.fillStyle='#637080';ctx.fillText('现在',Math.min(W-35,x(now)+5),p.t+12);
  if(!plotted.length)ctx.fillText('所选时段暂无历史采样',p.l+15,p.t+35);
}
$('chart').addEventListener('mousemove',event=>{const x=event.offsetX;const row=plotted.reduce((best,r)=>!best||Math.abs(r.x-x)<Math.abs(best.x-x)?r:best,null);if(row)$('hover').textContent=`${date(row.at)} · 实际剩余 ${pct(row.remaining)}`;});
$('window').addEventListener('change',()=>{selected=$('window').value;render(state);});
$('range').addEventListener('change',update);window.addEventListener('resize',()=>{draw();drawGauge();});
$('refresh').addEventListener('click',async()=>{ $('refresh').disabled=true;try{render(await api('refresh',{}));}catch(e){$('status').textContent=e.message;}finally{$('refresh').disabled=false;} });
$('settings').addEventListener('submit',async event=>{event.preventDefault();try{
 const dayOverrides={};for(const row of $('overrides').value.split('\n').map(s=>s.trim()).filter(Boolean)){const pair=row.split('=');if(pair.length!==2||!pair[1].trim())throw new Error('每行格式为 YYYY-MM-DD=0 或 YYYY-MM-DD=1');dayOverrides[pair[0].trim()]=Number(pair[1]);}
 const workHours=parseHourRows([...document.querySelectorAll('.hours-row')].map(row=>[...row.querySelectorAll('input')].map(input=>input.value)));
 $('hours-error').textContent='';
 render(await api('settings',{workHours,speedSources:readSSH(),remindersEnabled:$('reminders-enabled').checked,timezone:$('timezone').value,calendarTimezone:$('calendar-timezone').value,calendar:$('calendar').value,restWeight:Number($('rest-weight').value),dayOverrides,manualCredits:$('manual').value.split('\n').map(s=>s.trim()).filter(Boolean).map(expiresAt=>({expiresAt}))}));loadSpeed();$('saved').textContent='已保存并更新计划';
 }catch(e){$('saved').textContent=e.message;$('hours-error').textContent=e.message;}});
$('replan').addEventListener('click',async()=>{try{render(await api('replan',{}));}catch(e){$('plan-warning').textContent=e.message;}});
$('export').addEventListener('click',async()=>{try{const rows=await api('export');const url=URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='codex-usage-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('status').textContent=e.message;}});
async function update(){try{render(await api('state'));}catch(e){$('status').textContent='状态服务不可达：'+e.message;$('status').className='warn';if(state){state.stale=true;renderOverview(state.windows.find(w=>w.key===selected));drawGauge();$('actual-detail').textContent='上次已知值 · 服务不可达';}window.chrome?.webview?.postMessage({stale:true,error:'本机状态服务不可达'});}}
for(const [id,action]of [['snooze-advice','snooze'],['dismiss-advice','dismiss']])$(id).addEventListener('click',async()=>{try{render(await api('reminders',{id:state.advice.alertKey,action}));$('reminder-feedback').textContent=action==='snooze'?'30分钟后再提醒':'本次建议不再提醒';}catch(e){$('reminder-feedback').textContent=e.message;}});
$('speed-session').addEventListener('change',()=>{speedSelection=$('speed-session').value;loadSpeed();});
$('speed-panel').addEventListener('toggle',()=>{if($('speed-panel').open)loadSpeed();});
$('show-speed').addEventListener('click',()=>{speedSelection='';$('speed-panel').open=true;loadSpeed();$('speed-panel').scrollIntoView({block:'start'});});
$('configure-speed').addEventListener('click',()=>{navigate('settings');$('ssh-settings').scrollIntoView({block:'start'});});
$('add-ssh').addEventListener('click',()=>{if($('ssh-list').children.length<8)addSSH({id:'ssh-'+crypto.randomUUID(),enabled:true});});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadSpeed();});
$('add-hours').addEventListener('click',()=>addHourRow());
$('show-help').addEventListener('click',()=>{ $('help').open=true; $('help').scrollIntoView({block:'start'}); });
$('show-credits').addEventListener('click',()=>{ $('usage-details').open=true; $('credits').scrollIntoView({block:'center'}); });
loadSpeed();setInterval(()=>{renderRecentSpeed();if(!document.hidden)loadSpeed();},1000);
await update();setInterval(update,15000);

function renderPlan(){
 const p=state.plan; if(!p){$('plan-summary').textContent='等待有效的主额度周窗口';$('daily-rows').replaceChildren();$('daily-chart').replaceChildren();$('plan-baseline').textContent='';$('plan-warning').textContent='';return;}
 $('plan-summary').textContent='从今天开始安排 · 每工作日平均 '+formatAmount(p.mean)+' 个百分点';
 $('plan-baseline').textContent='有配置工作时段时，仅在工作时段内留出15分钟操作余量；本页不保证实际用量。统一比较至 '+date(p.end)+' · 理论可分配 '+(p.consumed?.toFixed(2)??'—')+' 点，期末保留 '+(p.retained?.toFixed(2)??'—')+' 点。计划基准 '+date(p.anchorAt)+' · 日历时区 '+state.config.calendarTimezone+'。实际使用偏离时保留基准，点击重算可按新余量调整。';
 $('plan-warning').textContent=p.warnings.join(' ');$('daily-rows').replaceChildren();$('daily-chart').replaceChildren();const todayKey=dayKey(state.now,state.config.calendarTimezone);const future=p.daily.filter(d=>d.date>=todayKey);const maximum=Math.max(1,...future.map(d=>d.amount));
 for(const d of future){const row=document.createElement('tr');if(!d.weight)row.className='rest';if(d.date===todayKey)row.classList.add('today');for(const text of [d.date+(d.date===todayKey?' · 今天':''),d.reason,formatAmount(d.amount)+' 个百分点',d.events.map(e=>(e.type==='card'?'用卡':'自然重置')+' '+date(e.at,true)).join(' / ')]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}$('daily-rows').append(row);
 const bar=document.createElement('div');bar.className='day-bar'+(d.weight?'':' rest');bar.title=d.date+' '+d.reason+'：'+d.amount.toFixed(2)+' 点';const fill=document.createElement('div');fill.className='day-fill';fill.style.height=Math.max(2,d.amount/maximum*105)+'px';const label=document.createElement('span');label.className='day-label';label.textContent=d.date.slice(8);bar.append(fill,label);for(const e of d.events.filter(e=>e.type==='card')){const badge=document.createElement('span');badge.className='card-marker';badge.textContent='用卡 '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(e.at);badge.title=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'full',timeStyle:'short'}).format(e.at)+' 北京时间';bar.append(badge);bar.classList.add('has-card');} $('daily-chart').append(bar);}
}

function renderHours(hours) { $('hours-list').replaceChildren();for(const range of hours)addHourRow(range); }
function addHourRow(range) {
 const row=document.createElement('div');row.className='hours-row';
 for(const [i,label] of ['开始','结束'].entries()) {const field=document.createElement('label');field.textContent=label;const input=document.createElement('input');input.type='time';input.required=true;input.setAttribute('aria-label',label+'时间');if(range){const n=range[i]%1440;input.value=String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');}field.append(input);row.append(field);}
 const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.addEventListener('click',()=>row.remove());row.append(remove);$('hours-list').append(row);
 if(!range)row.querySelector('input').focus();
}
function renderOverview(w) {
 const model=overview(state,w), {today,next}=model;
 $('today-date').textContent='今天 '+new Intl.DateTimeFormat('zh-CN',{timeZone:state.config.calendarTimezone,month:'long',day:'numeric',weekday:'short'}).format(state.now);
 $('today-title').textContent=model.stale?model.title:(state.advice?.title||model.title);
 $('today-budget').textContent=today?'今日计划预算：'+formatAmount(today.amount)+' 个百分点':'每日计划以主额度周窗口为准';
 $('today-advice').textContent=model.stale?model.advice:(state.advice?.detail||model.advice);
 $('advice-actions').hidden=!state.advice?.alertKey;
 $('next-label').textContent='下一次复核'; $('next-budget').textContent=state.advice?.reviewAt?date(state.advice.reviewAt,true):'按需查看';
 $('next-date').textContent='容量预算是参考，不必为了用满而增加工作';
 $('reset-short').textContent=w?.resetsAt?'自然重置 '+date(w.resetsAt,true):'重置时间未知';
 const events=[];
 events.push({title:'今天 '+model.todayKey.slice(5),label:today?.reason||'今日',detail:today?'计划 '+formatAmount(today.amount)+' 个百分点':'计划待确认'});
 if(next)events.push({title:next.date.slice(5),label:next.reason,detail:'计划 '+formatAmount(next.amount)+' 个百分点'});
 if(w?.resetsAt)events.push({title:date(w.resetsAt,true).split(' ')[0],label:'自然重置',detail:date(w.resetsAt,true).split(' ').slice(1).join(' ')});
 const advice=state.advice;
 events.push(advice?.card?{title:date(advice.card.expiresAt,true).split(' ')[0],label:'卡片到期',detail:date(advice.card.expiresAt,true).split(' ').slice(1).join(' ')+' · 可选择不用'}:{title:'重置卡',label:state.latest?.creditsKnown?'暂无到期安排':'状态待确认',detail:'以服务端核验为准'});
 $('timeline').replaceChildren(...events.slice(0,4).map(e=>{const li=document.createElement('li');for(const [tag,text]of [['strong',e.title],['span',e.label],['small',e.detail]]){const el=document.createElement(tag);el.textContent=text;li.append(el);}return li;}));
 drawGauge();
}
function drawGauge() {
 const canvas=$('gauge'),box=canvas.getBoundingClientRect();if(!box.width)return;
 const dpr=window.devicePixelRatio||1;canvas.width=box.width*dpr;canvas.height=box.height*dpr;
 const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const r=box.width/2-12,c=box.width/2;
 const w=state?.windows.find(w=>w.key===selected);const stale=!w||state.stale||w.staleWindow||w.remaining==null;
 ctx.lineWidth=20;ctx.strokeStyle='#edf1ef';ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);ctx.stroke();
 if(!stale){ctx.strokeStyle='#4caf8a';ctx.lineCap='round';ctx.beginPath();ctx.arc(c,c,r,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,Math.min(100,w.remaining))/100);ctx.stroke();}
}

function renderRecentSpeed(){
 const view=speedOverview(recentSpeed,Date.now(),speedConnected);
 $('live-speed-value').textContent=view.value;$('live-speed-status').textContent=view.caption;
 $('show-speed').title=view.title;$('show-speed').setAttribute('aria-label',`最近会话 TPS ${view.value}，${view.caption}，查看详情`);$('show-speed').dataset.inactive=String(view.inactive);
}
async function loadSpeed(){
 if(speedLoading)return;
 speedLoading=true;const request=++speedRequest,controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),4000);
 const get=async(selection='')=>{const response=await fetch('/api/speed'+(selection?'?session='+encodeURIComponent(selection):''),{headers:{'X-Planner-Token':token},signal:controller.signal});if(!response.ok)throw new Error();return response.json();};
 try{
  recentSpeed=await get();speedConnected=true;renderRecentSpeed();renderSourceHealth(recentSpeed.sources||[]);
  const selection=speedSelection;
  const result=selection&&$('speed-panel').open?await get(selection):recentSpeed;
  if(request===speedRequest&&selection===speedSelection&&(!selection||$('speed-panel').open))renderSpeed(result,true);
 }catch{speedConnected=false;renderRecentSpeed();$('speed-reason').textContent='日志服务暂不可达，上次读数不能视为当前速度';}
 finally{clearTimeout(timeout);speedLoading=false;}
}
function renderSpeed(data,explicit=false){
 if(!data||speedSelection&&!explicit)return;
 const choice=$('speed-session'),sessions=data.sessions||[],signature=JSON.stringify(sessions.map(s=>[s.key||s.session,s.model,s.agent,s.source?.label]));
 if(choice.dataset.signature!==signature||!Array.from(choice.options).some(o=>o.value===speedSelection)){
  choice.replaceChildren(new Option('最近使用会话（所有已连接主机）',''),...sessions.map(s=>new Option((s.source?.label||'本机')+' · '+(s.agent?'子代理 · ':'')+(s.model||'未知模型')+' · '+s.session.slice(0,8),s.key||s.session)));
  if(speedSelection&&!sessions.some(s=>(s.key||s.session)===speedSelection))choice.add(new Option('所选会话暂不在覆盖范围',speedSelection));
  choice.dataset.signature=signature;
 }
 choice.value=speedSelection;
 const s=data.selected,last=s?.last;
 const unavailable=s?.source?.connected===false;
 $('speed-status').textContent=unavailable?'主机连接中断 · 下方为旧读数':s?({generating:'生成中 · 下方为上次完成响应',tool:'工具执行中 · 下方为上次响应',unmeasurable:'本次不可测 · 下方为上次有效响应',idle:'空闲 · 上次响应',completed:'最近完成响应',unknown:'等待可测响应'}[s.status]||'上次响应'):'尚无可测样本';
 $('speed-value').textContent=last?last.tps.toFixed(1):'—';$('speed-median').textContent=s?.median!=null?s.median.toFixed(1):'—';$('speed-count').textContent=s?`${s.count} 个有效样本 · 同模型与推理强度`:'尚无有效样本';
 $('speed-meta').textContent=s?`${s.source?.label||'本机'} · ${last?.model||s.model||'未知模型'} · ${last?.effort||s.effort||'强度未知'} · ${s.agent?'子代理':'会话'} ${s.session}${last?' · 样本 '+date(last.at):''}${s.old?' · 久未更新':''}`:'未跟随 Codex 当前选中任务；按已连接主机的最近活动选择';
 $('speed-reason').textContent=data.missingSelection?'所选会话暂不在覆盖范围':s?.source?.error||s?.reason||'';
 $('speed-detail').textContent=last?`输出 ${last.output} token / ${last.seconds.toFixed(2)} 秒；推理 ${last.reasoning??'未知'}，可见 ${last.visible??'未知'}。推理吞吐 ${last.reasoning==null?'未知':(last.reasoning/last.seconds).toFixed(1)}，可见吞吐 ${last.visible==null?'未知':(last.visible/last.seconds).toFixed(1)} token/s。最近同组样本总输出/总时长 ${s.weighted.toFixed(1)} token/s。`:'没有足够的计数与时间信息。';
 $('speed-coverage').textContent=data.coverage||'仅已配置的日志来源，不是全账户统计';
}

function renderSSH(sources){$('ssh-list').replaceChildren();for(const source of sources)addSSH(source);}
function addSSH(source){
 const row=document.createElement('div');row.className='ssh-row';row.dataset.id=source.id;
 const head=document.createElement('div');head.className='ssh-heading';
 const enabled=document.createElement('label');enabled.className='toggle-label';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='ssh-enabled';checkbox.checked=source.enabled!==false;enabled.append(checkbox,'启用此主机');
 const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.addEventListener('click',()=>{row.remove();$('add-ssh').disabled=false;});head.append(enabled,remove);row.append(head);
 const grid=document.createElement('div');grid.className='form-grid';
 for(const [key,name,placeholder]of [['label','主机名称','例如 v100'],['target','SSH 目标','例如 user@192.0.2.1 或 SSH 别名'],['port','端口（可选）','沿用 SSH 配置，默认22'],['home','远端 Codex 目录（可选）','沿用远端 CODEX_HOME 或 ~/.codex']]){
  const label=document.createElement('label'),input=document.createElement('input');label.textContent=name;input.className='ssh-'+key;input.value=source[key]??'';input.placeholder=placeholder;if(key==='port'){input.type='number';input.min='1';input.max='65535';}input.autocomplete='off';label.append(input);grid.append(label);
 }
 row.append(grid);const advanced=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Python 路径';const pythonLabel=document.createElement('label');pythonLabel.textContent='远端 Python 3 可执行文件';const python=document.createElement('input');python.className='ssh-python';python.value=source.python||'python3';pythonLabel.append(python);advanced.append(summary,pythonLabel);row.append(advanced);
 const status=document.createElement('p');status.className='ssh-health muted';status.setAttribute('role','status');status.textContent='保存后连接';row.append(status);$('ssh-list').append(row);$('add-ssh').disabled=$('ssh-list').children.length>=8;
 renderSourceHealth(recentSpeed?.sources||[]);
}
function readSSH(){return [...$('ssh-list').children].map(row=>{const get=key=>row.querySelector('.ssh-'+key).value.trim();return {id:row.dataset.id,label:get('label'),target:get('target'),port:get('port')?Number(get('port')):null,home:get('home'),python:get('python')||'python3',enabled:row.querySelector('.ssh-enabled').checked};});}
function renderSourceHealth(sources){
 const description=s=>s.connected?'已连接':s.status==='disabled'?'已停用':s.error||'连接中';
 $('speed-sources-state').replaceChildren(...sources.map(s=>{const item=document.createElement('span');item.className=s.connected?'connected':'muted';item.textContent=`${s.label} · ${description(s)}`;return item;}));
 for(const row of $('ssh-list').children){const source=sources.find(s=>s.id===row.dataset.id);if(state?.demo)row.querySelector('.ssh-health').textContent='演示模式不连接 SSH';else if(source)row.querySelector('.ssh-health').textContent=description(source);}
}

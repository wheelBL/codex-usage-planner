// Shared, DOM-free presentation rules for both desktop hosts.
const amountFormatter=new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
export const formatAmount = value => Number.isFinite(value) ? amountFormatter.format(value) : '—';
export function dayKey(at, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(at).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function overview(state, window) {
  const todayKey = dayKey(state.now, state.config.calendarTimezone);
  const supported = window?.bucket === 'codex' && window?.duration === 604800000;
  const days = supported ? state.plan?.daily || [] : [];
  const today = days.find(d => d.date === todayKey);
  const next = days.find(d => d.date > todayKey && d.weight > 0);
  const stale = !window || state.stale || window.staleWindow || window.remaining == null;
  const blocked = state.latest?.ordinaryUsageAllowed === false;
  const cardAdvice = supported && !stale && !blocked ? state.advice : null;
  return {todayKey, today, next, stale, blocked, supported, cardAdvice,
    title: stale ? '用量等待更新' : blocked ? '当前额度暂不可用' : cardAdvice?.title || (!today ? '查看当前额度' : !today.weight ? `${today.reason} · 休息日` : '今天按计划使用'),
    advice: stale ? '当前数据尚未确认，请刷新后再安排用量。' : blocked ? '服务端当前不允许普通额度使用，请在 Codex 中检查状态。' : cardAdvice?.detail || (!today ? '此窗口显示实际剩余；每日预算以主额度周窗口为准。' : !today.weight ? '休息日计划预算为 0。仍可正常使用，以实际剩余额度为准。' : '预算是计划建议，实际消耗取决于任务。可在每日计划中查看安排。')};
}
export function forecastDescription(state, window, formatDate) {
 const f=window?.forecast;
 if(state.validationWarning)return '消耗趋势暂不可用：额度变化仍待核验；通过核验后会继续使用符合条件的历史记录。';
 if(state.stale||window?.staleWindow||(f&&state.now-f.until>150000))return '消耗趋势暂不可用：当前读数已过期或读取失败，请等待刷新。已有历史记录会保留。';
 if(!f)return '消耗趋势：需要至少5分钟的连续有效读数，并覆盖工作时段；断采或重置后重新积累。';
 const remaining=f.atReset==null?'—':`${f.atReset.toFixed(2)}%`;
 const end=f.perDay===0?'样本期间未观测到额度下降':f.exhaustsAt!=null?'线性耗尽时间 '+formatDate(f.exhaustsAt):'按近期速度，当前预测范围内额度仍有剩余';
 return `近 ${((f.until-f.since)/3600000).toFixed(2)} 小时平均消耗 ${f.perDay.toFixed(2)} 百分点/有效工作日；预计自然重置时剩余 ${remaining}。${end}。此推算不能保证未来用量。`;
}
export function parseHourRows(rows) {
  if(rows.length>8)throw new Error('工作时段最多8段');
  let previous = -1;
  return rows.map(([a,b],index) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b)) throw new Error(`第 ${index+1} 段：请填写开始和结束时间`);
    const minute = s => Number(s.slice(0,2))*60+Number(s.slice(3));
    const start=minute(a), end=b==='00:00'?1440:minute(b);
    if (start>=end) throw new Error(`第 ${index+1} 段：结束时间需晚于开始时间`);
    if (start<previous) throw new Error(`第 ${index+1} 段：请按时间排序，时段不能重叠`);
    previous=end; return [start,end];
  });
}

export function parseDayOverrides(text) {
 const result={};
 for(const [index,line] of text.split('\n').entries()) {
  if(!line.trim())continue;
  const parts=line.split('='),date=parts[0].trim(),value=parts[1]?.trim();
  const parsed=Date.parse(date+'T00:00:00Z');
  if(parts.length!==2||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date||!value||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>2)
   throw new Error(`第 ${index+1} 行：请填写 YYYY-MM-DD=强度，日期需有效，强度为 0–2`);
  if(Object.hasOwn(result,date))throw new Error(`第 ${index+1} 行：${date} 重复，请只保留一行`);
  result[date]=Number(value);
 }
 if(Object.keys(result).length>366)throw new Error('自定义日期最多366天');
 return result;
}

export function speedOverview(data,now=Date.now(),connected=true){
 const s=data?.selected,last=s?.last;
 const age=last?Math.max(0,Math.floor((now-last.at)/1000)):null;
 const ago=age===null?'':age<60?`${age} 秒前`:age<3600?`${Math.floor(age/60)} 分钟前`:`${Math.floor(age/3600)} 小时前`;
 const sources=(data?.sources||[]).filter(source=>source.status!=='disabled');
 const noSource=!s&&sources.length>0&&sources.every(source=>!source.connected);
 const unavailable=!connected||s?.source?.connected===false||noSource||(data?.checkedAt!=null&&now-data.checkedAt>10000);
 const reason=s?.source?.error||(noSource?sources.map(source=>source.error).filter(Boolean).join('；'):'');
 const activity=unavailable?'连接中断':!s?'暂无会话':({generating:'生成中',tool:'工具执行中',waiting:'活动状态待确认',idle:'空闲',completed:'已更新',unmeasurable:'本次不可测',unknown:'等待响应'}[s.status]||'等待响应');
 return {value:last&&Number.isFinite(last.tps)?last.tps.toFixed(1):'—',unavailable,reason,
  caption:(s?.source?.kind==='ssh'?`${s.source.label} · `:'')+activity+(last?` · ${unavailable?'旧读数':s?.status==='completed'?'最近响应':'上次响应'} · ${ago}`:reason?' · '+reason:' · 等待有效计数'),
  inactive:unavailable||!last||s?.old||['idle','waiting'].includes(s?.status),
  title:reason||(s?`${s.source?.label||'本机'} · ${s.model||'未知模型'} · 会话 ${s.session}；按已连接主机最近活动自动切换`:'读取本机与已配置 SSH 日志，不跟随 Codex 当前选中任务')};
}

import { makeClock } from './calendar.mjs';
import { availableCards } from './planner.mjs';
export const DAY = 86400000;
export const clamp = n => Math.max(0, Math.min(100, n));
const finite = n => typeof n === 'number' && Number.isFinite(n);
export function instant(value) {
  if (finite(value)) return value * 1000;
  // A date without an explicit offset is ambiguous and must never use the host zone.
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('时间必须包含时分秒和时区，例如 2026-09-26T00:00:00+08:00');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('无效时间');
  return result;
}
export function normalize(result, account, now = Date.now()) {
  const buckets = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? result.rateLimitsByLimitId : { [result.rateLimits?.limitId || 'codex']: result.rateLimits };
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets)) {
    if (!bucket) continue;
    for (const slot of ['primary', 'secondary']) {
      const w = bucket[slot];
      if (!w) continue;
      windows.push({ key: `${id}:${slot}`, bucket: id, name: bucket.limitName || id,
        duration: finite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins * 60000 : null,
        remaining: finite(w.usedPercent) ? clamp(100 - w.usedPercent) : null,
        resetsAt: finite(w.resetsAt) ? w.resetsAt * 1000 : null });
    }
  }
  const summary = result.rateLimitResetCredits;
  return { at: now, account, windows, ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    availableCount: summary?.availableCount ?? null,
    creditsKnown: Array.isArray(summary?.credits),
    credits: (summary?.credits || []).map(c => ({ id: c.id, status: c.status, resetType: c.resetType,
      grantedAt: finite(c.grantedAt) ? c.grantedAt * 1000 : null,
      expiresAt: finite(c.expiresAt) ? c.expiresAt * 1000 : null })) };
}
export function settings(input = {}) {
  const timezone = input.timezone ?? 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new Error('无效的 IANA 时区'); }
  const calendarTimezone = input.calendarTimezone ?? 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en',{timeZone:calendarTimezone}).format(); } catch { throw new Error('无效的计划时区'); }
  const restWeight = input.restWeight ?? 0;
  if(!finite(restWeight)||restWeight<0||restWeight>2)throw new Error('休息日强度必须在0–2之间');
  const calendar = input.calendar ?? 'china';
  if(!['china','weekends'].includes(calendar))throw new Error('无效日历');
  const dayOverrides = input.dayOverrides ?? {};
  if(typeof dayOverrides!=='object'||Array.isArray(dayOverrides)||Object.keys(dayOverrides).length>366)throw new Error('自定义日期最多366天');
  for(const [date,weight] of Object.entries(dayOverrides))if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!finite(weight)||weight<0||weight>2)throw new Error('自定义日期格式为 YYYY-MM-DD，强度为0–2');
  const manualCredits = input.manualCredits ?? [];
  if (!Array.isArray(manualCredits) || manualCredits.length > 30) throw new Error('最多输入 30 张重置卡');
  return { timezone, calendarTimezone, calendar, restWeight, dayOverrides, manualAccount: typeof input.manualAccount === 'string' ? input.manualAccount : null, manualCredits: manualCredits.map(c => ({ expiresAt: new Date(instant(c.expiresAt)).toISOString() })) };
}
export function creditSchedule(snapshot, config, now) { return availableCards(snapshot,config,now); }
export function budget(window, snapshot, config, now = Date.now(), plan = null) {
 const {duration,resetsAt,remaining}=window;const valid=duration!=null&&resetsAt!=null&&resetsAt>now;
 let naturalTarget=valid?clamp(100*(resetsAt-now)/duration):null;
 if(valid&&duration===7*DAY){const clock=makeClock(resetsAt-duration,resetsAt,config),total=clock.work(resetsAt-duration,resetsAt);naturalTarget=total>0?clamp(100*clock.work(now,resetsAt)/total):0;}
 const usePlan=window.bucket==='codex'&&duration===7*DAY&&plan?.segments?.length&&plan.initialReset===resetsAt;
 const first=usePlan?plan.segments[0]:null,deadline=first?.end??resetsAt;
 let target=naturalTarget;
 if(valid&&first){const clock=makeClock(first.start,first.end,config);target=now>=first.end?0:clamp(first.amount-first.rate*clock.work(first.start,now));}
 const work=valid&&deadline>now?(duration===7*DAY?makeClock(now,deadline,config).work(now,deadline):(deadline-now)/DAY):0;
 return {...window,naturalTarget,target,gap:target==null||remaining==null?null:remaining-target,deadline,
  schedule:usePlan?plan.schedule:[],staleWindow:resetsAt!=null&&resetsAt<=now,
  requiredPerDay:valid&&remaining!=null&&work>0?remaining/work:null,plannedPerWorkday:first?.rate??null,
  overdue:valid&&deadline<=now,accelerated:valid&&deadline<resetsAt};
}
export function forecast(history, window, account, now = Date.now(), config = null) {
  if(window.resetsAt==null||window.resetsAt<=now)return null;
  // Only use the contiguous current cycle and recent samples. A rise means reset/correction.
  const rows = [];
  for (const s of [...history].reverse()) {
    if (s.account !== account) continue;
    const w = s.windows.find(x => x.key === window.key);
    if (!w || w.resetsAt !== window.resetsAt || w.duration !== window.duration || w.remaining == null || now - s.at > DAY) break;
    if (rows.length && (w.remaining < rows.at(-1).remaining || rows.at(-1).at - s.at > 15 * 60000)) break;
    rows.push({ at: s.at, remaining: w.remaining });
  }
  if (rows.length < 2) return null;
  const last = rows[0], first = rows.at(-1), elapsed = last.at - first.at;
  if (elapsed < 5 * 60000 || now - last.at > 15 * 60000) return null;
  const clock=config?makeClock(first.at,Math.max(now+90*DAY,window.resetsAt||now),config):null;
  const units=clock?clock.work(first.at,last.at):elapsed/DAY;
  if(units<=0)return null;
  const perDay=(first.remaining-last.remaining)/units;
  let exhaustsAt=null;
  if(perDay>0){if(clock){let needed=last.remaining/perDay;for(const d of clock.rows){const begin=Math.max(d.start,last.at);if(begin>=d.end||d.weight===0)continue;const available=clock.work(begin,d.end);if(needed<=available){exhaustsAt=begin+needed/d.weight*(d.end-d.start);break;}needed-=available;}}else exhaustsAt=last.at+last.remaining*DAY/perDay;}
  return { perDay, since: first.at, until: last.at,
    exhaustsAt,
    atReset: window.resetsAt > last.at ? clamp(last.remaining - perDay * (clock?clock.work(last.at,window.resetsAt):(window.resetsAt-last.at)/DAY)) : null };
}

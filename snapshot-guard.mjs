// Shared by all hosts. No OS APIs, credentials, or platform-specific policy.
const MIN_CONFIRM_MS = 30000;
const MAX_CONFIRM_MS = 300000;
const RESET_TOLERANCE_MS = 60000;
const live = (c, now) => c.status === 'available' && (c.expiresAt == null || c.expiresAt > now);

export function reconcileCredits(incoming, previous) {
  const now = incoming.at;
  const known = incoming.creditsKnown === true;
  const observed = known ? incoming.credits : [];
  const count = incoming.availableCount;
  const complete = count === 0 || (known && (count == null || count === observed.filter(c => c.status === 'available').length));
  if (complete) return {...incoming, credits: count === 0 ? [] : observed, creditsUncertain: false};
  const cache = new Map((previous?.credits || []).filter(c => live(c, now)).map(c => [c.id, c]));
  for (const card of observed) {
    if (live(card, now)) cache.set(card.id, card);
    else cache.delete(card.id);
  }
  return {...incoming, credits: [...cache.values()], creditsUncertain: true,
    creditsWarning: '重置卡明细待核验：保留本账户已确认且未到期的卡片；当前计划可能不完整。'};
}

const valid = w => Number.isFinite(w.remaining) && Number.isFinite(w.resetsAt) && w.duration > 0;
const identity = w => `${w.bucket}:${w.duration}`;
function suspicious(old, next, now) {
  if (!valid(next)) return false; // Missing values remain unknown, never synthesized as a reset.
  if (!old || !valid(old)) return false;
  const shifted = Math.abs(next.resetsAt - old.resetsAt) > RESET_TOLERANCE_MS;
  const increased = next.remaining > old.remaining + 2;
  if (!shifted && !increased) return false;
  // An expired window advancing to a plausible future boundary is a natural reset.
  if (old.resetsAt <= now && next.resetsAt > now && next.resetsAt <= now + next.duration + RESET_TOLERANCE_MS && next.resetsAt > old.resetsAt) return false;
  return true;
}
function agrees(a, b) {
  return Math.abs(a.resetsAt - b.resetsAt) <= RESET_TOLERANCE_MS && b.remaining <= a.remaining + 1;
}

export function pendingWarning(saved, now) {
  const pending=Object.values(saved.pending||{}).filter(p=>!p.confirmed);
  if(!pending.length)return null;
  const describe=p=>{
    const seconds=Math.max(0,Math.floor((now-p.firstAt)/1000));
    const waited=seconds<60?`${seconds}秒`:`${Math.floor(seconds/60)}分钟`;
    const window=`${p.window.bucket} · ${p.window.duration/3600000}小时窗口`;
    return `${window}${p.missing?'未返回完整读数':'等待一致读数'}，已等待${waited}`;
  };
  return pending.map(describe).join('；')+'。'+(pending.some(p=>p.missing)?'缺失读数恢复后才能继续核验，请检查额度来源；':'需要至少间隔30秒的第二次一致读数；')+'暂保留上次可信额度和计划。';
}

export function guardSnapshot(incoming, saved = {}) {
  const previous = saved.trusted?.account === incoming.account ? saved.trusted : null;
  if(previous && incoming.at <= previous.at)return {accepted:false,warning:'收到过时采样，保留上次可信额度。',state:saved};
  const snapshot = reconcileCredits(incoming, previous);
  const reference = previous ? (saved.reference || previous.windows) : [];
  const pending = {};
  const priorPending = previous ? saved.pending || {} : {};
  for (const window of snapshot.windows) {
    const key = identity(window);
    const old = reference.find(w => identity(w) === key);
    if (!suspicious(old, window, incoming.at)) continue;
    const prior = priorPending[key] ? {...priorPending[key]} : null;
    if(prior)delete prior.missing;
    const elapsed = prior ? incoming.at - prior.firstAt : -1;
    if (prior && elapsed >= MIN_CONFIRM_MS && elapsed <= MAX_CONFIRM_MS && agrees(prior.window, window)) {
      pending[key] = {...prior, confirmed:true};continue;
    }
    pending[key] = prior && elapsed >= 0 && elapsed <= MAX_CONFIRM_MS && agrees(prior.window, window)
      ? prior : {firstAt: incoming.at, window};
  }
  for(const [key,value] of Object.entries(priorPending)) {
    if(!snapshot.windows.some(w=>identity(w)===key && valid(w)))pending[key]={...value,missing:true};
  }
  if (Object.values(pending).some(p => !p.confirmed)) {
    const state={version: 1, trusted: previous, reference, pending};
    return {accepted: false, warning: pendingWarning(state,incoming.at),state};
  }
  const nextReference=new Map(reference.map(w=>[identity(w),w]));
  for(const w of snapshot.windows)if(valid(w))nextReference.set(identity(w),w);
  return {accepted: true, snapshot, warning: null, state: {version: 1, trusted: snapshot, reference:[...nextReference.values()], pending: {}}};
}

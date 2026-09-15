import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { normalize } from './core.mjs';
import { readResetCredits } from './credits.mjs';
import {getWithRetry} from './diagnostics.mjs';
export async function readOAuthUsage({onDiagnostic=()=>{}}={}) {
  const auth = JSON.parse(await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'));
  const t = auth.tokens;
  if (!t?.access_token || !t.account_id) throw new Error('OAuth unavailable');
  const response = await getWithRetry('https://chatgpt.com/backend-api/wham/usage', { method:'GET', redirect:'error',
    headers:{ Authorization:'Bearer ' + t.access_token, 'ChatGPT-Account-ID':t.account_id }, signal:AbortSignal.timeout(10000) },{onDiagnostic,stage:'oauth-usage'});
  if (!response.ok) throw new Error('OAuth usage unavailable');
  const raw = await response.json();
  if (raw.account_id && raw.account_id !== t.account_id) throw new Error('Account mismatch');
  const window = w => w == null ? null : ({ usedPercent:w.used_percent, windowDurationMins:typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds/60 : null, resetsAt:w.reset_at });
  const bucket = (r,name) => ({ limitName:name, primary:window(r?.primary_window), secondary:window(r?.secondary_window) });
  const rateLimitsByLimitId = { codex:bucket(raw.rate_limit,'codex') };
  for (const r of raw.additional_rate_limits || []) if (r.metered_feature) rateLimitsByLimitId[r.metered_feature] = bucket(r.rate_limit,r.limit_name);
  if (!Object.values(rateLimitsByLimitId).some(b=>b.primary || b.secondary)) throw new Error('No usage windows');
  let credits = {availableCount:raw.rate_limit_reset_credits?.available_count ?? null}, creditsWarning=null;
  try { credits = await readResetCredits(t.account_id); } catch { creditsWarning='重置卡明细暂不可用，可手动填写到期时间。'; }
  const account = createHash('sha256').update(t.account_id).digest('hex').slice(0,20);
  return {...normalize({rateLimitsByLimitId,rateLimitResetCredits:credits},account),source:'oauth',creditsWarning};
}

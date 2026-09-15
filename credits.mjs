import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// Compatibility fallback for older app-server versions. Read only, no token refresh or redemption.
async function localTokens(expectedAccountId, expectedEmail) {
  const auth = JSON.parse(await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'));
  const tokens = auth.tokens;
  if (!tokens?.access_token || !tokens.account_id) throw new Error('No local OAuth credentials');
  const claims = value => { try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url')); } catch { return {}; } };
  const idClaims = claims(tokens.id_token || ''), accessClaims = claims(tokens.access_token);
  const email = idClaims.email || accessClaims.email || accessClaims['https://api.openai.com/profile']?.email;
  if (expectedAccountId ? expectedAccountId !== tokens.account_id : !expectedEmail || email !== expectedEmail) throw new Error('Account identity mismatch');
  return tokens;
}
export async function localAccountId(email) { return (await localTokens(null, email)).account_id; }
export async function readResetCredits(expectedAccountId, expectedEmail) {
  const tokens = await localTokens(expectedAccountId, expectedEmail);
  const response = await fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
    method: 'GET', headers: { Authorization: 'Bearer ' + tokens.access_token, 'ChatGPT-Account-ID': tokens.account_id },
    redirect: 'error', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Credits request failed');
  const result = await response.json();
  if (!Array.isArray(result.credits)) throw new Error('Missing credit details');
  const timestamp = value => value == null ? null : typeof value === 'number' ? value : Date.parse(value) / 1000;
  return { availableCount: typeof result.available_count === 'number' ? result.available_count : null,
    credits: result.credits.map(c => ({ id: c.id, status: c.status,
      resetType: c.reset_type === 'codex_rate_limits' ? 'codexRateLimits' : 'unknown',
      expiresAt: timestamp(c.expires_at), grantedAt: timestamp(c.granted_at) })) };
}

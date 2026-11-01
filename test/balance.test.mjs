import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalize} from '../core.mjs';
import {readOAuthUsage} from '../oauth.mjs';
import {guardSnapshot} from '../snapshot-guard.mjs';
import {creditBalanceView} from '../public/view-model.js';

const now = 1800000000000;
const credits = {balance:'1234.5678900000',hasCredits:true,unlimited:false};
const snapshot = balance => normalize({rateLimits:{credits:balance}}, 'account-a', now);
const view = balance => creditBalanceView({now,stale:false,latest:snapshot(balance)});

test('RPC balance comes only from the main Codex pool and stays separate from reset cards', () => {
  const legacy = normalize({rateLimits:{credits},rateLimitResetCredits:{availableCount:2,credits:[]}}, 'a', now);
  assert.deepEqual(legacy.creditBalance, credits);
  assert.equal(legacy.availableCount, 2);
  assert.deepEqual(legacy.credits, []);
  const multi = normalize({rateLimitsByLimitId:{codex:{credits},other:{credits:{...credits,balance:'9999'}}}}, 'a', now);
  assert.deepEqual(multi.creditBalance, credits);
  assert.equal(normalize({rateLimitsByLimitId:{other:{credits}}}, 'a', now).creditBalance, null);
  assert.equal(normalize({rateLimits:{limitId:'other',credits}}, 'a', now).creditBalance, null);
});

test('missing and malformed balances stay unknown while explicit zero and decimal precision survive', () => {
  for (const balance of [null,undefined,'',' ','-1','NaN','Infinity','1,234',true,{},'1e3']) {
    assert.equal(snapshot({...credits,balance}).creditBalance.balance, null);
  }
  assert.equal(snapshot(null).creditBalance, null);
  assert.equal(snapshot({}).creditBalance, null);
  assert.equal(snapshot({...credits,balance:0}).creditBalance.balance, '0');
  assert.equal(snapshot(credits).creditBalance.balance, '1234.5678900000');
});

test('balance display handles zero, small values, unknown amounts and unlimited access honestly', () => {
  assert.equal(view({...credits,balance:'0',hasCredits:false}).value, '0 Credits');
  assert.equal(view(credits).value, '1,234.57 Credits');
  assert.equal(view(credits).exact, '1234.56789 Credits');
  assert.equal(view({...credits,balance:'0.000001'}).value, '<0.01 Credits');
  assert.equal(view(null).value, '— Credits');
  assert.equal(view({...credits,balance:null}).value, '有余额');
  assert.match(view({...credits,balance:null}).status, /未提供具体余额/);
  assert.equal(view({...credits,balance:null,unlimited:true}).value, '不限量');
  assert.match(view({...credits,hasCredits:false}).status, /不可用/);
});

test('failed reads, old snapshots and unquantified old balances cannot look current', () => {
  for (const state of [
    {now,stale:true,latest:snapshot(credits)},
    {now:now+150001,latest:snapshot(credits)},
    {now,stale:true,latest:snapshot({...credits,balance:null})}
  ]) {
    assert.equal(creditBalanceView(state).stale, true);
    assert.match(creditBalanceView(state).caption, /旧读数/);
  }
});

test('missing balances and account switches never reuse a cached balance', () => {
  const saved = guardSnapshot(snapshot(credits)).state;
  const missing = guardSnapshot(normalize({rateLimits:{}}, 'account-a', now+1), saved);
  assert.equal(missing.snapshot.creditBalance, null);
  const switched = guardSnapshot(normalize({rateLimits:{}}, 'account-b', now+1), saved);
  assert.equal(switched.snapshot.creditBalance, null);
});

test('OAuth reads actual Credits fields and supports an account with balance but no subscription windows', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'planner-balance-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(home, {recursive:true,force:true});
  });
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({tokens:{access_token:'test-only-token',account_id:'test-only-account'}}));
  let raw = {account_id:'test-only-account',rate_limit:null,credits:{balance:credits.balance,has_credits:true,unlimited:false}};
  t.mock.method(globalThis, 'fetch', async url => ({ok:true,status:200,json:async () => String(url).endsWith('/wham/usage') ? raw : {available_count:0,credits:[]}}));
  const result = await readOAuthUsage();
  assert.deepEqual(result.creditBalance, credits);
  assert.deepEqual(result.windows, []);
  assert.equal(result.availableCount, 0);
  raw = {...raw,credits:null};
  await assert.rejects(readOAuthUsage(), /No usage windows or credit balance/);
});

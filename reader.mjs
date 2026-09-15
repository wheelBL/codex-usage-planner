import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { normalize } from './core.mjs';
import {describeFailure,failureLabel} from './diagnostics.mjs';
import { readResetCredits, localAccountId } from './credits.mjs';

export async function readUsage({ command, timeout = 25000 } = {}) {
  const argv = command ?? (process.env.CODEX_COMMAND ? JSON.parse(process.env.CODEX_COMMAND) : ['codex']);
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string')) throw new Error('CODEX_COMMAND 必须是命令及参数的 JSON 数组');
  const child = spawn(argv[0], [...argv.slice(1), '-s', 'read-only', '-a', 'never', 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  let failure, nextId = 0;
  const fail = error => { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', () => fail(new Error('无法启动 Codex；请配置 CODEX_COMMAND 为 codex.exe 的完整路径，并确认已登录。')));
  child.on('exit', () => fail(new Error('Codex 状态进程已退出')));
  child.stdin.on('error', () => fail(new Error('Codex 状态连接已关闭')));
  // Drain stderr without retaining or exposing credentials or local configuration details.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if (message.error) {const d=describeFailure(Object.assign(new Error(message.error.message||''),{rpcCode:message.error.code}),p.method);p.reject(Object.assign(new Error(failureLabel(d)),{diagnostic:d}));}
    else p.resolve(message.result);
  });
  const timer = setTimeout(() => fail(new Error('读取 Codex 状态超时；保留上次记录，稍后重试。')), timeout);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'codex_usage_planner', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await request('account/rateLimits/read', null);
    let identity = result.accountId, email;
    if (!identity) {
      const profile = await request('account/read', { refreshToken: false });
      identity = profile?.account?.email;
      email = identity;
      try { identity = await localAccountId(email); } catch { /* Keep this unverified identity isolated. */ }
    }
    if (!identity) throw new Error('服务未提供账户标识，无法安全归档历史；请使用 ChatGPT 账户登录并更新 Codex。');
    let creditsWarning = null;
    if (!Array.isArray(result.rateLimitResetCredits?.credits)) {
      try { result.rateLimitResetCredits = await readResetCredits(result.accountId, email); }
      catch { creditsWarning = '重置卡明细不可用：可手动填写到期时间，或更新 Codex 状态源。'; }
    }
    const account = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    return { ...normalize(result, account), creditsWarning };
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.pid) {
      // Own this subprocess only; Windows taskkill includes descendants of this exact PID.
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000);
        killTimer.unref();
      }
    }
  }
}

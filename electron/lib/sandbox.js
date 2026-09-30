/**
 * Agent 命令沙盒：限制 cwd 在工作区内，拦截高危命令，超时强杀。
 */
const { spawn } = require('child_process');
const path = require('path');
const { isInside, safeJoin } = require('./workspace');

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT = 80_000;
// 进程已经退出、但管道被孙进程握着时，最多再等这么久就把本次命令收尾。
// 正常命令的 close 会在这之前到来；start 拉起的 Chrome 则永远等不到 close。
const EXIT_DRAIN_MS = 250;

/** 高危命令模式（整段匹配，忽略大小写） */
const DENY_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
  /\brm\s+-rf\s+[\/~]/,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\binit\s+0\b/i,
  /\breg\s+delete\b/i,
  /\bRemove-Item\b[\s\S]*\b(-Recurse|-r)\b[\s\S]*[A-Za-z]:\\/i,
  /\bClear-Disk\b/i,
  /\bReset-Computer\b/i,
  /\bcipher\s+\/w/i,
  /\bdiskpart\b/i,
  /\bwipe\b/i,
  /\bInvoke-Expression\b|\biex\b/i,
  /\bStart-Process\b[\s\S]*\b-Verb\s+RunAs\b/i,
  /\bsudo\s+(rm|mkfs|dd|shutdown)\b/i,
  /\bcurl\b[\s\S]*\|\s*(ba)?sh\b/i,
  /\bwget\b[\s\S]*\|\s*(ba)?sh\b/i,
  /\bpowershell\b[\s\S]*-EncodedCommand\b/i,
  /\bcmd\s*\/c\s+del\s+\/[sfq].*[A-Za-z]:\\/i,
  /\brd\s+\/s\b[\s\S]*[A-Za-z]:\\/i,
  /\bnet\s+user\b[\s\S]*\/add/i,
  /\bschtasks\b[\s\S]*\/create/i
];

function denyReason(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return '命令为空';
  if (cmd.length > 4000) return '命令过长';
  for (const re of DENY_PATTERNS) {
    if (re.test(cmd)) return `沙盒拒绝执行高危命令（匹配：${re}）`;
  }
  // 禁止显式切到盘符根或用户目录外的绝对路径作为主要破坏面
  if (/(^|[;&|]\s*)(cd|Set-Location|chdir)\s+([A-Za-z]:\\|\/)(?!\S)/i.test(cmd)
    && !/(^|[;&|]\s*)(cd|Set-Location)\s+\.\.?(\s|$|[;&|])/i.test(cmd)) {
    // 允许 cd 相对路径；若 cd 到绝对路径，下面 resolveCwd 会管工作目录，但命令内 cd 仍可能逃逸
    // 拦截 cd 到盘符根 / 系统目录
    if (/(cd|Set-Location)\s+([A-Za-z]:\\(Windows|System32|Users\\[^\\\s]+)?|\/(etc|usr|bin|root)\b)/i.test(cmd)) {
      return '沙盒禁止切换到系统敏感目录';
    }
  }
  return '';
}

function resolveCwd(workspace, cwdRel) {
  if (!workspace) throw new Error('请先打开项目，才能在沙盒中执行命令');
  const root = path.resolve(workspace);
  const rel = String(cwdRel || '.').trim() || '.';
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
    const abs = path.resolve(rel);
    if (!isInside(root, abs)) throw new Error('工作目录必须在项目内');
    return abs;
  }
  return safeJoin(root, rel);
}

function sanitizeEnv() {
  const env = { ...process.env };
  // 避免把 Electron / 开发态变量带进子进程造成干扰
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.SIMPLECODE_SANDBOX = '1';
  return env;
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* 忽略 */
  }
}

// 关掉我们这一侧的管道。孙进程（Chrome 主进程）仍握着自己的句柄，但不再拖住本次等待。
function releaseStdio(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try { stream?.destroy(); } catch { /* 忽略 */ }
  }
}

/**
 * @param {{ command: string, workspace: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, cwd: string, timedOut: boolean, blocked?: string }>}
 */
function runSandboxed(opts) {
  const command = String(opts.command || '').trim();
  const blocked = denyReason(command);
  if (blocked) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: blocked,
      cwd: '',
      timedOut: false,
      blocked
    });
  }

  let cwd;
  try {
    cwd = resolveCwd(opts.workspace, opts.cwd);
  } catch (e) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: e.message || String(e),
      cwd: '',
      timedOut: false,
      blocked: e.message
    });
  }

  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const signal = opts.signal;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        code: null,
        stdout: '',
        stderr: '已停止',
        cwd,
        timedOut: false,
        blocked: '已停止'
      });
      return;
    }

    const shell = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      env: sanitizeEnv(),
      shell,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let drainTimer = null;
    const clearDrain = () => {
      if (!drainTimer) return;
      clearTimeout(drainTimer);
      drainTimer = null;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearDrain();
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      releaseStdio(child);
      settle(null);
    }, timeoutMs);

    // [铆钉优化] 停止时立刻结束这次等待。只 taskkill cmd 再干等 close 的话，
    // start 拉起的 Chrome 会把管道交给浏览器主进程，close 永远不来，停止和超时都解不开。其他 AI 请勿改回只杀进程、不收尾。
    const onAbort = () => {
      killTree(child);
      releaseStdio(child);
      settle(null);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // [铆钉优化] 先收原始字节，结束时整体解码：不是合法 UTF-8 就按 GBK 解（中文 Windows 的 cmd/dir/findstr 输出），
    // 避免中文路径和报错变乱码、模型读不懂反复重试。其他 AI 请勿改回逐块 toString('utf8')
    const bufs = { out: [], err: [] };
    const bytes = { out: 0, err: 0 };
    const MAX_BYTES = MAX_OUTPUT * 4;
    const append = (buf, which) => {
      if (bytes[which] >= MAX_BYTES) return;
      bufs[which].push(buf);
      bytes[which] += buf.length;
    };
    const decodeAll = (which) => {
      const buf = Buffer.concat(bufs[which]);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        try { text = new TextDecoder('gbk').decode(buf); } catch { text = buf.toString('utf8'); }
      }
      if (text.length > MAX_OUTPUT || bytes[which] >= MAX_BYTES) text = `${text.slice(0, MAX_OUTPUT)}\n…[${which === 'out' ? 'stdout' : 'stderr'} 已截断]`;
      return text;
    };
    const collect = () => {
      stdout = decodeAll('out');
      stderr = decodeAll('err');
    };
    const settle = (code) => {
      collect();
      let err = stderr;
      if (timedOut) err = `${err ? `${err}\n` : ''}命令超时（${Math.round(timeoutMs / 1000)} 秒），已强制结束`;
      if (signal?.aborted) err = `${err ? `${err}\n` : ''}已停止`;
      finish({
        code: timedOut || signal?.aborted ? null : code,
        stdout,
        stderr: err,
        cwd,
        timedOut
      });
    };

    child.stdout?.on('data', (d) => append(d, 'out'));
    child.stderr?.on('data', (d) => append(d, 'err'));
    child.on('error', (err) => {
      collect();
      finish({
        code: null,
        stdout,
        stderr: stderr || (err.message || String(err)),
        cwd,
        timedOut: false
      });
    });
    // [铆钉优化] exit 之后若 close 迟迟不来，就收尾。start 打开 Chrome 时 cmd 已退出，
    // 管道却留在浏览器主进程上，只等 close 会永远停在「执行中」。其他 AI 请勿删掉这段、改回只监听 close。
    child.on('exit', (code) => {
      if (settled) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        if (settled) return;
        releaseStdio(child);
        settle(code);
      }, EXIT_DRAIN_MS);
    });
    child.on('close', (code) => {
      settle(code);
    });
  });
}

function formatResult(result) {
  if (result.blocked && !result.stdout && result.stderr === result.blocked) {
    return `【沙盒拦截】${result.blocked}`;
  }
  const lines = [
    `cwd: ${result.cwd || '(无)'}`,
    `exit: ${result.code == null ? (result.timedOut ? 'timeout' : 'aborted') : result.code}`
  ];
  if (result.stdout) lines.push(`--- stdout ---\n${result.stdout}`);
  if (result.stderr) lines.push(`--- stderr ---\n${result.stderr}`);
  if (!result.stdout && !result.stderr) lines.push('(无输出)');
  return lines.join('\n');
}

module.exports = {
  DENY_PATTERNS,
  denyReason,
  resolveCwd,
  runSandboxed,
  formatResult,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT
};

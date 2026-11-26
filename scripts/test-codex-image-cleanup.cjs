// 针对 Codex 普通适配器（codex-model.js）的附件临时文件：只落盘最后 8 张、保持原消息顺序，
// 并在部分写失败 / 正常完成 / SDK 失败（含取消）时释放本次实际创建的文件，不碰既有文件。
// 测试不接外部模型：按锚点截取真实源码，用假 codex 和计数式故障注入核对落盘与清理行为。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'electron/lib/codex-model.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const passed = [];
// 所有图片与 SDK 工作目录均建在本次测试独占的临时目录中。
let fixtureDir;
/** 返回测试专属目录，供普通适配器的 os.tmpdir 和文件计数共用。 */
function testTempDir() { return fixtureDir; }

/**
 * 按唯一锚点从真实源码里截取一段，锚点缺失直接抛错，
 * 避免源码改名后测试悄悄跑空却仍然显示通过。
 */
function between(text, start, end) {
  const begin = text.indexOf(start);
  assert.ok(begin >= 0, '源码里找不到起始锚点：' + start);
  const finish = text.indexOf(end, begin);
  assert.ok(finish > begin, '源码里找不到结束锚点：' + end);
  return text.substring(begin, finish);
}

/** 记录一条通过的检查，便于回报可复查的证据。 */
function ok(name) {
  passed.push(name);
  console.log('PASS ' + name);
}

// 图片落盘函数、清理函数和兜底提示词函数；以及调用它们的 complete。
const imageSource = between(source, '// 一次请求最多把几张附件图片落成本地临时文件', 'async function makeCodex(');
const completeSource = between(source, 'async function complete(', 'module.exports = {');

// 写入计数与故障注入状态：failAtCall 为第几次写图片时失败，0 表示不注入故障
const writeState = { calls: 0, failAtCall: 0 };

/**
 * fs 替身：写入前先计数，命中故障点就真实写出半截内容再抛错，
 * 这样能覆盖「文件已创建但没写完」也必须被删掉的场景；删除直接走真实 fs。
 */
const fsShim = {
  openSync: fs.openSync,
  closeSync: fs.closeSync,
  rmdirSync: fs.rmdirSync,
  writeFileSync: function (file, data) {
    writeState.calls += 1;
    if (writeState.failAtCall > 0 && writeState.calls === writeState.failAtCall) {
      fs.writeFileSync(file, Buffer.from([0]));
      throw new Error('模拟图片写入失败');
    }
    fs.writeFileSync(file, data);
  },
  unlinkSync: function (file) {
    fs.unlinkSync(file);
  },
  // complete 会准备它自己的 codex 沙箱目录，直接走真实 fs（与应用生产行为一致）
  mkdirSync: function (dir, options) {
    return fs.mkdirSync(dir, options);
  }
};

// 假 codex：由每个用例替换，run 的行为决定正常 / 失败路径
let currentCodex = null;
const sandbox = {
  fs: fsShim,
  os: { tmpdir: testTempDir },
  path: path,
  Buffer: Buffer,
  process: process,
  console: console,
  makeCodex: async function () {
    return currentCodex;
  }
};
const context = vm.createContext(sandbox);
vm.runInContext(imageSource + '\n' + completeSource, context, { filename: 'codex-model-images.js' });
const imagesOf = context.imagesOf;
const complete = context.complete;

/** 本测试自身可能留下的临时图片文件名集合（按本进程 pid 前缀过滤），用于核对创建与清理。 */
function tempImageNames() {
  const prefix = 'spcode-codex-' + process.pid + '-';
  const names = fs.readdirSync(fixtureDir);
  const found = new Set();
  for (let i = 0; i < names.length; i += 1) {
    if (names[i].indexOf(prefix) === 0) found.add(names[i]);
  }
  return found;
}

/** 对比前后快照，返回本次新出现的临时图片文件名，用来判断有没有漏删。 */
function createdBetween(before, after) {
  const created = [];
  const names = Array.from(after);
  for (let i = 0; i < names.length; i += 1) {
    if (before.has(names[i]) === false) created.push(names[i]);
  }
  return created;
}

/** 生成一张内容可区分的 data URL 图片，标签写进字节以便核对落盘顺序。 */
function imageUrl(tag) {
  const base64 = Buffer.from('png-' + tag).toString('base64');
  return 'data:image/png;base64,' + base64;
}

/** 构造一条携带多张图片的用户消息，图片按传入顺序排列，模拟真实请求形状。 */
function messageWithImages(tags) {
  const content = [{ type: 'text', text: '看这几张图' }];
  for (let i = 0; i < tags.length; i += 1) {
    content.push({ type: 'image_url', image_url: { url: imageUrl(tags[i]) } });
  }
  return [{ role: 'user', content: content }];
}

/** 用例一：超过 8 张时只落盘最后 8 张，内容与顺序和原消息一致，入参不被改动。 */
function caseWriteLimitAndOrder() {
  writeState.calls = 0;
  writeState.failAtCall = 0;
  const before = tempImageNames();
  const tags = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const messages = messageWithImages(tags);
  const files = imagesOf(messages);

  assert.strictEqual(files.length, 8, '超过 8 张时应只保留 8 张，实际为 ' + files.length);
  const expected = tags.slice(-8);
  for (let i = 0; i < files.length; i += 1) {
    const body = fs.readFileSync(files[i], 'utf8');
    assert.strictEqual(body, 'png-' + expected[i], '第 ' + i + ' 张内容或顺序不对：' + body);
    assert.strictEqual(path.basename(files[i]).indexOf('spcode-codex-' + process.pid + '-'), 0, '临时文件前缀不对');
  }
  const created = createdBetween(before, tempImageNames());
  assert.strictEqual(created.length, 8, '落盘文件数应为 8，实际为 ' + created.length);
  assert.strictEqual(messages[0].content.length, 11, '原始消息内容不应被改动');

  // 用例自身清掉这 8 个文件，确认清理后磁盘回到用例开始时的状态
  for (let i = 0; i < files.length; i += 1) fs.unlinkSync(files[i]);
  assert.strictEqual(createdBetween(before, tempImageNames()).length, 0, '用例清理后仍有残留');
  ok('imagesOf 只落盘最后 8 张且顺序与内容一致，入参不变');
}

/** 用例二：写到第 3 张失败时，已创建（含半截）的文件全部删除，错误原样抛出。 */
function casePartialWriteFailure() {
  writeState.calls = 0;
  writeState.failAtCall = 3;
  const before = tempImageNames();
  let error = null;
  try {
    imagesOf(messageWithImages(['a', 'b', 'c', 'd']));
  } catch (e) {
    error = e;
  }
  writeState.failAtCall = 0;
  assert.ok(error, '写入失败必须向上抛出，不能静默返回');
  assert.ok(String(error.message).indexOf('模拟图片写入失败') >= 0, '抛出的应是原始写入错误：' + error.message);
  assert.strictEqual(writeState.calls, 3, '失败后不应继续写后面的图片，实际写入次数 ' + writeState.calls);
  const left = createdBetween(before, tempImageNames());
  assert.strictEqual(left.length, 0, '写到一半失败后仍有残留文件：' + left.join(','));
  ok('部分写失败时本次已创建（含半截）的图片全部删除，错误原样抛出');
}

/** 用例三：正常完成后释放临时文件，SDK 收到的输入是文本加按序图片（运行时文件真实存在）。 */
async function caseCompleteSuccess() {
  const before = tempImageNames();
  const seen = { input: null, existed: [], bodies: [], signal: null };
  currentCodex = {
    startThread: function () {
      return {
        run: async function (input, options) {
          seen.input = input;
          seen.signal = options && options.signal;
          for (let i = 1; i < input.length; i += 1) {
            seen.existed.push(fs.existsSync(input[i].path));
            seen.bodies.push(fs.readFileSync(input[i].path, 'utf8'));
          }
          return { finalResponse: '看到了' };
        }
      };
    }
  };
  const messages = messageWithImages(['x', 'y', 'z']);
  const deltas = [];
  const signal = { aborted: false };
  const result = await complete({
    modelCfg: {},
    messages: messages,
    onDelta: function (text) { deltas.push(text); },
    signal: signal
  });

  assert.strictEqual(result.content, '看到了', '应原样返回 SDK 文本');
  assert.strictEqual(deltas.join(''), '看到了', 'onDelta 应收到同样文本');
  assert.strictEqual(seen.signal, signal, '取消信号应原样传给 SDK');
  assert.strictEqual(seen.input[0].type, 'text', '第 0 项应是文本');
  assert.strictEqual(seen.input.length, 4, '三张图应生成三个 local_image，实际 ' + (seen.input.length - 1));
  for (let i = 1; i < seen.input.length; i += 1) {
    assert.strictEqual(seen.input[i].type, 'local_image', '第 ' + i + ' 项应是 local_image');
  }
  for (let i = 0; i < seen.existed.length; i += 1) {
    assert.strictEqual(seen.existed[i], true, '传给 SDK 的第 ' + i + ' 张图片在调用时不存在');
  }
  assert.strictEqual(seen.bodies[0], 'png-x', '第一张图片顺序不对：' + seen.bodies[0]);
  assert.strictEqual(seen.bodies[seen.bodies.length - 1], 'png-z', '最后一张图片顺序不对：' + seen.bodies[seen.bodies.length - 1]);
  assert.strictEqual(createdBetween(before, tempImageNames()).length, 0, '正常完成后仍有临时图片残留');
  ok('正常完成时释放本次临时文件，SDK 输入保持文本加按序图片');
}

/** 用例四：SDK 失败或取消时同样释放临时文件，错误原样抛出。 */
async function caseCompleteFailure() {
  const before = tempImageNames();
  let runCount = 0;
  currentCodex = {
    startThread: function () {
      return {
        run: async function () {
          runCount += 1;
          throw new Error('模拟取消或 SDK 失败');
        }
      };
    }
  };
  let error = null;
  try {
    await complete({ modelCfg: {}, messages: messageWithImages(['p', 'q']), signal: null });
  } catch (e) {
    error = e;
  }
  assert.strictEqual(runCount, 1, 'run 应只被调用一次');
  assert.ok(error, 'SDK 失败必须向上抛出');
  assert.strictEqual(error.message, '模拟取消或 SDK 失败', '错误应原样抛出：' + error.message);
  const left = createdBetween(before, tempImageNames());
  assert.strictEqual(left.length, 0, 'SDK 失败后仍有临时图片残留：' + left.join(','));
  ok('SDK 失败（含取消）时释放本次临时文件并原样抛出错误');
}

/** 用例五：complete 内部落盘失败时文件不遗留，且不再调用 SDK。 */
async function caseCompleteWriteFailure() {
  writeState.calls = 0;
  writeState.failAtCall = 2;
  const before = tempImageNames();
  let runCount = 0;
  currentCodex = {
    startThread: function () {
      return {
        run: async function () {
          runCount += 1;
          return { finalResponse: '不该跑到这里' };
        }
      };
    }
  };
  let error = null;
  try {
    await complete({ modelCfg: {}, messages: messageWithImages(['m', 'n', 'o']), signal: null });
  } catch (e) {
    error = e;
  }
  writeState.failAtCall = 0;
  assert.ok(error, '落盘失败必须向上抛出');
  assert.strictEqual(runCount, 0, '落盘失败时不应调用 SDK');
  const left = createdBetween(before, tempImageNames());
  assert.strictEqual(left.length, 0, '落盘失败后仍有临时图片残留：' + left.join(','));
  ok('complete 落盘失败时清理本次已创建文件且不调用 SDK');
}

/**
 * 用独立进程获得同一 SDK 共用目录两次，验证退出时空目录清理、已有内容保留。
 * 子进程与断言均使用本次测试的私有临时根目录。
 */
function caseSandboxExit() {
  const script = [
    "const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');",
    context.sandboxDirectory.toString(),
    "const dir = sandboxDirectory();",
    "assert.equal(dir, sandboxDirectory());",
    "if (process.argv[1] === 'keep') fs.writeFileSync(path.join(dir, 'owned.txt'), 'keep');",
    "process.stdout.write(dir);"
  ].join('\n');
  const env = { ...process.env, TEMP: fixtureDir, TMP: fixtureDir, TMPDIR: fixtureDir, ELECTRON_RUN_AS_NODE: '1' };
  for (const mode of ['empty', 'keep']) {
    const dir = require('child_process').execFileSync(process.execPath, ['-e', script, mode], { env, encoding: 'utf8' });
    assert.strictEqual(path.dirname(dir), fixtureDir);
    if (mode === 'empty') assert.strictEqual(fs.existsSync(dir), false);
    else assert.strictEqual(fs.readFileSync(path.join(dir, 'owned.txt'), 'utf8'), 'keep');
  }
  ok('SDK 共用目录在进程退出时回收，含其他内容的目录保留');
}

/** 在独占目录内运行全部用例；断言失败也清掉图片和 SDK 测试沙箱。 */
async function main() {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-image-cleanup-test-'));
  try {
    caseWriteLimitAndOrder();
    casePartialWriteFailure();
    await caseCompleteSuccess();
    await caseCompleteFailure();
    await caseCompleteWriteFailure();
    caseSandboxExit();
    console.log('全部通过：' + passed.length + ' 项检查');
  } finally {
    currentCodex = null;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch(function (error) {
  console.error('FAIL ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

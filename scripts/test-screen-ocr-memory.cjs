/**
 * 回归后台读屏长期运行时的 OCR 结果泄漏。
 * 使用真实 Tesseract worker 连续识别本地画布，核对任务槽数量、旧结果回收和文字坐标。
 * 运行：node_modules\\.bin\\electron.cmd scripts/test-screen-ocr-memory.cjs
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const v8 = require('node:v8');
const { createRequire } = require('node:module');

const WORKERS = 2;
const SCANS = 240;
const results = [];
const jobIds = new Set();
let screenText;
let window;
let timeout;

/** 让弱引用离开当前任务后再回收，避免 WeakRef 当前任务的存活保证影响结论。 */
function nextTask() {
  return new Promise(function wait(resolve) { setImmediate(resolve); });
}

/** 加载真实读屏模块，仅限制测试线程数并观察实际 OCR 返回值，不替换识别实现。 */
function loadScreenText() {
  const file = path.resolve(__dirname, '../electron/lib/screen-text-map.js');
  const localRequire = createRequire(file);
  const tesseract = localRequire('tesseract.js');
  async function createWorker(langs, oem, options) {
    const worker = await tesseract.createWorker(langs, oem, options);
    const recognize = worker.recognize;
    /** 只保存弱引用和任务编号，测试代码不持有识别结果本身。 */
    async function observeResult(image, opts, output, jobId) {
      const result = await recognize(image, opts, output, jobId);
      jobIds.add(result.jobId);
      results.push(new WeakRef(result));
      return result;
    }
    worker.recognize = observeResult;
    return worker;
  }
  function profile() { return { ocrWorkers: WORKERS }; }
  function dependency(name) {
    if (name === 'tesseract.js') return { createWorker };
    if (name === './agi-throttle') return { profile };
    return localRequire(name);
  }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, setTimeout, clearTimeout };
  // 只在测试上下文开放内部入口，生产模块不增加测试 API。
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.recognizeForTest = recognize;', context, { filename: file });
  return context.module.exports;
}

/**
 * 验证异步识别失败或同步裁剪失败时，仍等待其它条带结束才允许下一帧复用编号。
 * failureMode 指定 ocr 或 crop；运行生产 recognize 和 ocrQueue，确保错误不会造成同一 worker 的在途任务重叠。
 */
async function testFailedBand(image, failureMode) {
  let calls = 0;
  let delayed = false;
  let releaseBand;
  let crops = 0;
  /** 识别失败用例让首条带报错；裁剪失败用例让首条带保持在途。 */
  async function firstBand() {
    calls++;
    if (calls !== 1) return { data: { blocks: [] } };
    if (failureMode === 'ocr') throw new Error('OCR_BAND_FAILURE');
    return new Promise(function pending(resolve) {
      releaseBand = function finishBand() { resolve({ data: { blocks: [] } }); };
    });
  }
  /** 异步识别失败时让第二条带保持在途，供测试核对下一帧是否被正确阻塞。 */
  async function secondBand() {
    calls++;
    if (failureMode === 'crop' || delayed) return { data: { blocks: [] } };
    delayed = true;
    return new Promise(function pending(resolve) {
      releaseBand = function finishBand() { resolve({ data: { blocks: [] } }); };
    });
  }
  const file = path.resolve(__dirname, '../electron/lib/screen-text-map.js');
  const context = { require: createRequire(file), module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, setTimeout, clearTimeout,
    testWorkers: [{ recognize: firstBand }, { recognize: secondBand }] };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') +
    '\ngetOcr = async function testOcr() { return testWorkers; };' +
    '\narmIdleStop = function idle() {}; module.exports = { recognize };', context, { filename: file });
  const recognize = context.module.exports.recognize;
  /** 真实图像只在指定的第二次裁剪同步抛错，其余条带保留原有像素输入。 */
  const source = {
    getSize: function getSize() { return image.getSize(); },
    crop: function crop(rect) {
      crops++;
      if (failureMode === 'crop' && crops === 2) throw new Error('OCR_CROP_FAILURE');
      return image.crop(rect);
    }
  };
  const first = recognize(source, WORKERS);
  function unexpectedSuccess() { throw new Error('失败条带没有向调用方报告错误'); }
  function expectedFailure(error) { return error.message; }
  const failed = first.then(unexpectedSuccess, expectedFailure);
  const second = recognize(source, WORKERS);
  await nextTask();
  const beforeRelease = calls;
  releaseBand();
  const result = await Promise.all([failed, second]);
  const expectedError = failureMode === 'crop' ? 'OCR_CROP_FAILURE' : 'OCR_BAND_FAILURE';
  const expectedStarted = failureMode === 'crop' ? WORKERS - 1 : WORKERS;
  assert.equal(result[0], expectedError, '保留原有识别或裁剪错误');
  assert.equal(beforeRelease, expectedStarted, '失败帧的全部条带结束前，不得在同一 worker 开始下一帧');
  assert.equal(calls, expectedStarted + WORKERS, '失败后的下一帧可正常完成');
  console.log('PASS ' + failureMode + ' 失败后等待全部在途任务，下一帧安全复用编号并保留原始错误');
}

/** 连续识别同一幅真实图像，模拟后台画面变化导致的重复 OCR，并核对回收而非仅看退出码。 */
async function main() {
  await app.whenReady();
  timeout = setTimeout(function exceeded() { failed(new Error('OCR 内存回归超时')); }, 55000);
  window = new BrowserWindow({ show: false, width: 800, height: 240,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const html = '<!doctype html><canvas id="image" width="800" height="240"></canvas><script>' +
    'const canvas=document.getElementById("image");const ctx=canvas.getContext("2d");' +
    'ctx.fillStyle="white";ctx.fillRect(0,0,800,240);ctx.fillStyle="black";ctx.font="32px Arial";' +
    'ctx.fillText("Screen memory check 12345",24,64);ctx.fillText("Second OCR band 67890",24,200);</script>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const png = await window.webContents.executeJavaScript('document.getElementById("image").toDataURL()');
  const image = nativeImage.createFromDataURL(png);
  screenText = loadScreenText();
  for (let i = 0; i < SCANS; i++) {
    const lines = await screenText.recognizeForTest(image, i < SCANS / 2 ? 1 : WORKERS);
    assert.ok(lines.some(function found(line) { return line.text.includes('12345'); }), 'OCR 仍能识别首行文字');
    assert.ok(lines.some(function found(line) { return line.text.includes('67890') && line.y0 > 120; }), '多条带识别仍返回原图坐标');
  }
  v8.setFlagsFromString('--expose-gc');
  const collect = vm.runInNewContext('gc');
  for (let i = 0; i < 4; i++) { await nextTask(); collect(); }
  let retained = 0;
  for (const result of results) if (result.deref()) retained++;
  console.log('OCR_MEMORY ' + JSON.stringify({ scans: SCANS, calls: results.length, workers: WORKERS,
    taskSlots: jobIds.size, retainedResults: retained, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }));
  assert.ok(jobIds.size <= WORKERS, '串行 OCR 的任务槽数量必须有界');
  assert.ok(retained <= WORKERS, '历史 OCR 结果必须可回收，仅允许每个 worker 保留最近一次结果');
  console.log('PASS 真实 OCR 连续识别、单线程与多线程坐标、任务槽有界、历史结果回收');
  await testFailedBand(image, 'ocr');
  await testFailedBand(image, 'crop');
  clearTimeout(timeout);
  screenText.stopOcr();
  window.destroy();
  app.exit(0);
}

/** 测试失败保留非零状态，同时关闭本次创建的 OCR 和隐藏窗口。 */
function failed(error) {
  clearTimeout(timeout);
  if (screenText) screenText.stopOcr();
  if (window && !window.isDestroyed()) window.destroy();
  console.error(error.stack || error);
  app.exit(1);
}
main().catch(failed);

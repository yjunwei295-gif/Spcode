/**
 * 在隔离 Electron 进程核对参考图工具、真实网页/视频像素、生产模型传输和视觉桥。
 * 本地兼容接口只用于断言请求内容；--live 另行查询 Bing 并下载实际原图，不发送用户配置或真实模型请求。
 */
'use strict';
const { app, nativeImage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
let origin;
let checks = 0;
let live = false;
let searchCount = 0;
let compared = 0;
let rejected = 0;
let rejectedWithoutImages = 0;
let blue;
let workspace;
// 协议边界测试逐图核对视觉桥收到的像素，避免仅断言内容块数量。
let expectedBridgeImages = null;
let bridgeRequests = 0;
const network = require('../electron/lib/http-fetch');
const originalFetch = network.httpFetch;
/** 只替换测试中的搜索页响应，图片下载和模型 HTTP 均走实际生产网络通道。 */
async function fixtureFetch(url, init) {
  if (!live && String(url).startsWith('https://www.bing.com/images/search?')) {
    searchCount++;
    const item = { t: '蓝色参考', murl: origin + '/reference.png', purl: origin + '/reference-source' };
    return new Response('<a class="iusc" m="' + JSON.stringify(item).replace(/"/g, '&quot;') + '"></a>');
  }
  return originalFetch(url, init);
}
network.httpFetch = fixtureFetch;
const reference = require('../electron/lib/aesthetic-reference');
const review = require('../electron/lib/aesthetic-review');
app.on('window-all-closed', function keepAlive(event) { event.preventDefault(); });
/** 每一项都须有行为或像素证据。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 暴露测试入口，不替换生产 Agent 内部的传输或视觉接线。 */
function agentApi() {
  const file = path.join(root, 'electron/lib/agent.js');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.referenceTest={prepareAestheticImages,completeAesthetic,callVisionEndpoint};', file);
  return loaded.exports.referenceTest;
}
/** 按 NativeImage 的 BGRA 排列读取首像素，核对实际内容而不是图片块数量。 */
function pixel(dataUrl) {
  const image = nativeImage.createFromDataURL(dataUrl);
  const buffer = image.toBitmap();
  return { r: buffer[2], g: buffer[1], b: buffer[0], size: image.getSize() };
}
/** 本地兼容接口返回普通或流式消息，供生产 API 层真实解析工具调用。 */
function reply(response, body, message) {
  if (!body.stream) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message }] }));
    return;
  }
  response.setHeader('Content-Type', 'text/event-stream');
  response.end('data: ' + JSON.stringify({ choices: [{ delta: message }] }) + '\n\ndata: [DONE]\n\n');
}
/** 生成标准工具调用，编号与后续 tool_call_id 对齐。 */
function call(name, args, index) {
  return { index, id: 'call-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
/** 真实 HTTP 服务核对工具结果、两幅画面和看图失败的请求次数。 */
async function serve(request, response) {
  try {
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'vision-fixture' }] })); return; }
    if (request.url === '/reference.png') { response.setHeader('Content-Type', 'image/png'); response.end(blue); return; }
    if (request.url === '/page') { response.setHeader('Content-Type', 'text/html'); response.end('<style>body{margin:0;background:rgb(0,255,0)}</style>'); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const last = body.messages[body.messages.length - 1];
    if (body.model === 'reject-vision') {
      rejected++;
      if (!body.messages.some(function hasImage(message) {
        return Array.isArray(message.content) && message.content.some(function image(part) { return part.type === 'image_url'; });
      })) rejectedWithoutImages++;
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { message: 'image_url not supported' } }));
      return;
    }
    if (body.model === 'single-fixture') {
      const images = last.content.filter(function image(p) { return p.type === 'image_url'; });
      assert.equal(images.length, 1);
      assert.equal(pixel(images[0].image_url.url).r, 255);
      assert.ok(last.content[0].text.length > 0);
      reply(response, body, { role: 'assistant', content: '单图画面为红色。' });
      return;
    }
    if (body.model === 'vision-fixture') {
      const parts = last.content.filter(function image(p) { return p.type === 'image_url'; });
      if (expectedBridgeImages) {
        assert.equal(parts.length, expectedBridgeImages.length);
        for (let i = 0; i < parts.length; i++) {
          assert.deepEqual(pixel(parts[i].image_url.url), pixel(expectedBridgeImages[i].dataUrl));
          let hasLabel = false;
          for (const part of last.content) {
            if (part.type === 'text' && part.text.includes(expectedBridgeImages[i].label)) hasLabel = true;
          }
          assert.ok(hasLabel);
        }
        bridgeRequests++;
        reply(response, body, { role: 'assistant', content: '已联合查看 ' + parts.length + ' 幅画面，完整保留各标签对应的像素。' });
        return;
      }
      assert.equal(parts.length, 2);
      assert.equal(pixel(parts[0].image_url.url).r, 255);
      assert.equal(pixel(parts[1].image_url.url).b, 255);
      assert.ok(last.content[0].text.includes('联合查看'));
      reply(response, body, { role: 'assistant', content: '成果是红色，参考图是蓝色；两者主色不同。' });
      return;
    }
    assert.deepEqual(body.tools.map(function name(t) { return t.function.name; }), ['search_reference_images', 'view_review_image']);
    if (last.role === 'user' && Array.isArray(last.content)) {
      const images = last.content.filter(function image(p) { return p.type === 'image_url'; });
      assert.equal(images.length, 2);
      assert.equal(pixel(images[0].image_url.url).r, 255);
      assert.equal(pixel(images[1].image_url.url).b, 255);
      const tools = body.messages.filter(function tool(m) { return m.role === 'tool'; });
      assert.equal(tools.length, 3);
      assert.ok(tools[0].content.includes(origin + '/reference-source'));
      compared++;
      reply(response, body, { role: 'assistant', content: '【审美投票】不通过\n【挑刺】\npage.html 主色是红色，参考图主色是蓝色。来源：' + origin + '/reference-source' });
    } else if (last.role === 'tool') {
      reply(response, body, { role: 'assistant', content: '', tool_calls: [
        call('view_review_image', { source: 'page.html', width: 64, height: 32 }, 0),
        call('view_review_image', { source: '参考图1' }, 1)
      ] });
    } else {
      reply(response, body, { role: 'assistant', content: '', tool_calls: [call('search_reference_images', { query: '蓝色页面', count: 1 }, 0)] });
    }
  } catch (error) { response.statusCode = 500; response.end(String(error.stack)); }
}

/**
 * 执行真实 Codex/Grok 适配器方法，仅以可检查的 SDK/ACP 边界代替外部模型进程。
 * @param {object} api 从当前生产 Agent 源码加载的审美准备和请求入口
 * @param {Array<object>} pair 已实际渲染的成果与参考画面，包含 label 和 dataUrl
 * @param {object} store 当前测试进程的配置模块；仅临时指定本地测试视觉端点
 * @returns {Promise<void>} 核对原生八图、九图视觉桥、Grok 文字通道及缺失视觉槽位的失败行为
 */
async function verifyAdapterBoundaries(api, pair, store) {
  const codex = require('../electron/lib/codex-model');
  const grok = require('../electron/lib/grok-model');
  const originalCodex = codex.complete;
  const originalGrok = grok.complete;
  const originalLoad = store.load;
  let expectedCodexImages = [];
  let codexRuns = 0;
  let grokPrompts = 0;
  const updates = [];
  /**
   * 从当前生产源码加载适配器，保留 complete、图片提取和提示拼装的真实实现。
   * @param {string} relative 适配器相对项目路径
   * @param {string} injection 仅用于绑定外部 SDK 或 ACP 依赖的测试入口源码
   * @returns {object} 独立模块实例的导出，不修改磁盘源码
   */
  function loadAdapter(relative, injection) {
    const file = path.join(root, relative);
    const loaded = new Module(file, module);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    loaded._compile(fs.readFileSync(file, 'utf8') + injection, file);
    return loaded.exports;
  }
  /**
   * 检查真实 Codex 适配器写出的每个本地图像文件及其顺序。
   * @param {Array<object>} input 适配器交给 SDK 的 text/local_image 输入
   * @returns {Promise<object>} 固定最终投票；图片数量、内容或视觉桥文字不符时断言失败
   */
  async function sdkRun(input) {
    const files = [];
    for (const item of input) if (item.type === 'local_image') files.push(item.path);
    assert.equal(files.length, expectedCodexImages.length);
    for (let i = 0; i < files.length; i++) {
      const actual = 'data:image/png;base64,' + fs.readFileSync(files[i]).toString('base64');
      assert.deepEqual(pixel(actual), pixel(expectedCodexImages[i].dataUrl));
    }
    if (!files.length) assert.ok(input[0].text.includes('已联合查看 9 幅画面'));
    codexRuns++;
    return { finalResponse: '【审美投票】通过\n【挑刺】\n无' };
  }
  /**
   * 为真实适配器提供可检查的 SDK 会话。
   * @returns {object} run 指向逐文件核对输入的测试方法
   */
  function sdkThread() { return { run: sdkRun }; }
  /**
   * 仅代替外部 SDK 客户端创建，适配器的图片提取与 complete 本体照常执行。
   * @returns {Promise<object>} 含 startThread 的 SDK 客户端
   */
  async function sdkFactory() { return { startThread: sdkThread }; }
  /**
   * 返回测试用可执行标识，不搜索或启动真实 Grok CLI。
   * @returns {string} 固定的测试可执行标识
   */
  function grokExecutable() { return 'fixture-grok'; }
  /**
   * 释放 ACP 测试对象；不涉及系统进程。
   * @returns {void} 不产生副作用
   */
  function killFixture() {}
  /**
   * 提供 ACP 进程边界对象。
   * @returns {{kill:function}} 仅包含 kill 的测试对象
   */
  function grokProcess() { return { kill: killFixture }; }
  /**
   * 核对真实 Grok 适配器生成的 ACP 消息，像素必须先由视觉桥实际查看。
   * @param {string} method ACP 方法名称
   * @param {object} params 适配器生成的请求参数
   * @returns {Promise<object>} 新会话或完成响应，并提供可被生产适配器消费的消息更新
   */
  async function acpRequest(method, params) {
    if (method === 'session/new') return { sessionId: 'fixture-session' };
    assert.equal(method, 'session/prompt');
    assert.equal(params.prompt.length, 1);
    assert.equal(params.prompt[0].type, 'text');
    assert.ok(params.prompt[0].text.includes('已联合查看 2 幅画面'));
    assert.ok(!params.prompt[0].text.includes('data:image'));
    grokPrompts++;
    updates.push({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '【审美投票】通过\n【挑刺】\n无' } } });
    return { stopReason: 'end_turn' };
  }
  /**
   * 提供已握手的 ACP 测试连接。
   * @returns {Promise<object>} client 中包含 request 请求方法和 updates 消息队列
   */
  async function grokHandshake() { return { client: { request: acpRequest, updates } }; }
  const codexAdapter = loadAdapter('electron/lib/codex-model.js', '\n/**\n * 仅在测试模块中绑定外部 SDK 创建依赖。\n * @param {function} factory 返回测试 SDK 客户端的异步工厂\n * @returns {void} 替换本模块的 SDK 创建依赖，保留完整适配器实现\n */\nmodule.exports.bindBoundary = function bindBoundary(factory) { makeCodex = factory; };');
  codexAdapter.bindBoundary(sdkFactory);
  const grokAdapter = loadAdapter('electron/lib/grok-model.js', '\n/**\n * 仅在测试模块中绑定外部 ACP 进程与握手依赖。\n * @param {object} deps executable 提供测试标识，process 提供进程边界对象，handshake 提供 ACP 连接\n * @returns {void} 绑定三个外部依赖，保留提示拼装及请求处理实现\n */\nmodule.exports.bindBoundary = function bindBoundary(deps) { findGrokExecutable = deps.executable; spawnGrokStdio = deps.process; handshake = deps.handshake; };');
  grokAdapter.bindBoundary({ executable: grokExecutable, process: grokProcess, handshake: grokHandshake });
  codex.complete = codexAdapter.complete;
  grok.complete = grokAdapter.complete;
  /**
   * 指向本地像素核对端点，不使用用户保存的凭据。
   * @returns {object} 包含模型、端点、工作区及语言的测试视觉槽位配置
   */
  function visionSettings() { return { modelsDir: workspace, visionAgentModel: 'vision-fixture', visionAgentEndpoint: origin + '/v1', locale: 'zh' }; }
  /**
   * 构造没有视觉槽位的配置。
   * @returns {object} 仅包含临时工作区和语言
   */
  function noVisionSettings() { return { modelsDir: workspace, locale: 'zh' }; }
  store.load = visionSettings;
  const codexModel = { type: 'api', protocol: 'codex', baseUrl: codex.CODEX_BASE_URL, model: 'gpt-6', vision: true };
  const grokModel = { type: 'api', protocol: 'grok', baseUrl: grok.GROK_BASE_URL, model: 'grok-fixture', vision: true };
  const nine = [];
  for (let i = 0; i < 9; i++) {
    const png = nativeImage.createFromBitmap(Buffer.from([0, 0, i + 1, 255]), { width: 1, height: 1 }).toDataURL();
    nine.push({ label: '逐图证据 ' + i, dataUrl: png });
  }
  const eight = nine.slice(0, 8);
  const native = await api.prepareAestheticImages(eight, codexModel, '核对完整八图', {});
  expectedCodexImages = eight;
  await api.completeAesthetic({ modelCfg: codexModel, toolSpec: reference.toolSpecs, messages: [
    { role: 'system', content: review.criticInstruction() },
    { role: 'user', content: native.parts }, { role: 'user', content: native.parts }
  ] });
  check(codexRuns === 1, '真实 Codex complete 与图片提取方法收到最新完整八图，逐图像素顺序一致');
  expectedBridgeImages = nine;
  const previousBridgeRequests = bridgeRequests;
  const bridgedNine = await api.prepareAestheticImages(nine, codexModel, '联合查看九图', {});
  expectedCodexImages = [];
  await api.completeAesthetic({ modelCfg: codexModel, toolSpec: reference.toolSpecs, messages: [
    { role: 'system', content: review.criticInstruction() }, { role: 'user', content: native.parts },
    { role: 'user', content: [{ type: 'text', text: bridgedNine.text }].concat(bridgedNine.parts) }
  ] });
  check(bridgeRequests === previousBridgeRequests + 1 && bridgedNine.parts.length === 0 && codexRuns === 2, 'Codex 九图全部进入视觉桥，真实适配器接收比较结果且不携带被截断的旧批次');
  expectedBridgeImages = pair;
  const beforeGrokBridge = bridgeRequests;
  const grokView = await api.prepareAestheticImages(pair, grokModel, '联合查看成果与参考', {});
  await api.completeAesthetic({ modelCfg: grokModel, toolSpec: reference.toolSpecs, messages: [
    { role: 'system', content: review.criticInstruction() },
    { role: 'user', content: [{ type: 'text', text: grokView.text }].concat(grokView.parts) }
  ] });
  check(bridgeRequests === beforeGrokBridge + 1 && grokView.parts.length === 0 && grokPrompts === 1, 'Grok vision:true 仍先将全部真实像素送入视觉桥，真实 ACP 适配器只接收已完成的比较结果');
  /**
   * 直接提交未经视觉桥处理的 Grok 图片，以核对传输入口的拒绝行为。
   * @returns {Promise<object>} 正常返回形态为模型回包，本测试必须在进入适配器前同步抛错
   */
  function rawGrokRequest() { return api.completeAesthetic({ modelCfg: grokModel, messages: [{ role: 'user', content: native.parts }], toolSpec: reference.toolSpecs }); }
  /**
   * 直接提交超过 Codex 图片上限的批次，以核对传输入口的拒绝行为。
   * @returns {Promise<object>} 正常返回形态为模型回包，本测试必须在进入适配器前同步抛错
   */
  function rawCodexRequest() {
    const parts = [];
    for (const image of nine) parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    return api.completeAesthetic({ modelCfg: codexModel, messages: [{ role: 'user', content: parts }], toolSpec: reference.toolSpecs });
  }
  assert.throws(rawGrokRequest, /Grok.*不传递像素/);
  assert.throws(rawCodexRequest, /Codex.*超过八张/);
  check(codexRuns === 2 && grokPrompts === 1, '绕过准备入口的 Grok 原图与 Codex 九图请求均明确拒绝，没有静默丢图后继续投票');
  store.load = noVisionSettings;
  await assert.rejects(api.prepareAestheticImages(pair, grokModel, '比较', {}), /无法看图/);
  await assert.rejects(api.prepareAestheticImages(nine, codexModel, '比较', {}), /无法看图/);
  const stillNative = await api.prepareAestheticImages(eight, codexModel, '比较', {});
  check(stillNative.parts.length === eight.length * 2, '无视觉槽位时 Grok 和 Codex 超量图片明确失败，八张以内的原生 Codex 不受影响');
  expectedBridgeImages = null;
  store.load = originalLoad;
  codex.complete = originalCodex;
  grok.complete = originalGrok;
}

/** 验收生产调用、只读边界、渲染采样和原有单图请求。 */
async function main() {
  await app.whenReady();
  workspace = fs.mkdtempSync(path.join(root, 'generated', 'aesthetic-reference-'));
  fs.writeFileSync(path.join(workspace, 'page.html'), '<style>body{margin:0;background:rgb(255,0,0)}</style>', 'utf8');
  fs.writeFileSync(path.join(workspace, 'App.tsx'), 'export default function App(){return null;}', 'utf8');
  fs.writeFileSync(path.join(workspace, 'motion.html'), '<style>body{margin:0}</style><canvas id="c"></canvas><script>window.renderFrame=function(t,f,i){c.width=i.width;c.height=i.height;const x=c.getContext("2d");x.fillStyle=t<1?"red":"blue";x.fillRect(0,0,i.width,i.height)};</script>', 'utf8');
  fs.writeFileSync(path.join(workspace, 'art.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>', 'utf8');
  const svg = await reference.viewImage(workspace, { source: 'art.svg', width: 64, height: 32 }, new Map());
  blue = nativeImage.createFromDataURL(svg.dataUrl).toPNG();
  const server = http.createServer(serve);
  await new Promise(function listen(resolve) { server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const api = agentApi();
  const pageBefore = fs.readFileSync(path.join(workspace, 'page.html'));
  const models = [
    { id: 'a', config: { type: 'api', protocol: 'openai', model: 'review-a', vision: true, baseUrl: origin + '/v1' } },
    { id: 'b', config: { type: 'api', protocol: 'openai', model: 'review-b', vision: true, baseUrl: origin + '/v1' } }
  ];
  async function prepare(images, model, prompt) { return api.prepareAestheticImages(images, model, prompt, {}); }
  const result = await review.review({ models, changes: [{ path: 'page.html' }], workspace,
    userText: '制作蓝色页面', systemPrompt: review.criticInstruction(), completeFn: api.completeAesthetic, prepareImages: prepare });
  check(searchCount === 2 && compared === 2, '两位评委通过生产流式 API 独立查询、查看两幅实际图像并给出差异');
  check(!result.passed && result.report.includes(origin + '/reference-source') && result.report.includes('主色是红色'), '报告保留实际参考来源和具体视觉差异');
  check(fs.readFileSync(path.join(workspace, 'page.html')).equals(pageBefore), '评审查询和看图没有改动成果');
  const page = await reference.viewImage(workspace, { source: origin + '/page', page: true, width: 64, height: 32 }, new Map());
  check(pixel(page.dataUrl).g === 255, '运行页面 URL 按明确画幅截到实际绿色像素，支持组件工程评审');
  const animation = await reference.viewImage(workspace, { source: 'motion.html', width: 64, height: 32, fps: 2, duration: 2, time: 1.5 }, new Map());
  check(pixel(animation.dataUrl).b === 255 && animation.label.includes('1.5 秒'), '代码动画确实调用 renderFrame 并采样指定时刻');
  await assert.rejects(reference.viewImage(workspace, { source: 'motion.html', width: 64, height: 32, time: 1.5 }, new Map()), /fps\/duration/);
  await assert.rejects(reference.viewImage(workspace, { source: 'App.tsx' }, new Map()), /源码不是画面/);
  check(true, '动画缺时序和组件源码直接看图均明确诊断');
  const encoded = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x32:r=2:d=2', '-c:v', 'libx264', path.join(workspace, 'clip.mp4')], { windowsHide: true });
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const frame = await reference.viewImage(workspace, { source: 'clip.mp4', time: 1 }, new Map());
  check(pixel(frame.dataUrl).r > 240 && frame.label.includes('1 秒'), '真实 MP4 经 FFmpeg 解码得到指定时刻画面');
  const red = await reference.viewImage(workspace, { source: 'page.html', width: 64, height: 32 }, new Map());
  const pair = [{ label: '成果', dataUrl: red.dataUrl }, { label: '参考', dataUrl: svg.dataUrl }];
  const store = require('../electron/lib/store');
  const originalLoad = store.load;
  store.load = function localVisionSettings() { return { modelsDir: workspace, visionAgentModel: 'vision-fixture', visionAgentEndpoint: origin + '/v1', locale: 'zh' }; };
  const bridged = await api.prepareAestheticImages(pair, { model: 'text-only', vision: false }, '比较两图', {});
  check(bridged.parts.length === 0 && bridged.text.includes('主色不同'), '文本评委的视觉桥在同一次真实请求中收到成果与参考图像素');
  store.load = originalLoad;
  const single = await api.callVisionEndpoint({ endpoint: origin + '/v1', model: 'single-fixture', dataUrl: red.dataUrl });
  check(single === '单图画面为红色。', '原有单图端点调用仍发送实际图片与默认识别提示');
  const engineFile = path.join(root, 'electron/lib/vision-engine.js');
  const engine = new Module(engineFile, module); engine.filename = engineFile; engine.paths = Module._nodeModulePaths(path.dirname(engineFile));
  engine._compile(fs.readFileSync(engineFile, 'utf8') + '\nmodule.exports.chatVisionTest=chatVision;', engineFile);
  const localCompare = await engine.exports.chatVisionTest({ base: origin, model: 'vision-fixture', images: [
    { type: 'image_url', image_url: { url: red.dataUrl } }, { type: 'image_url', image_url: { url: svg.dataUrl } }
  ], prompt: '联合查看两幅画面' });
  check(localCompare.includes('主色不同'), '本地视觉引擎的 HTTP 请求也完整发送多图与比较提示');
  const codex = require('../electron/lib/codex-model');
  const originalComplete = codex.complete;
  let directCompared = 0;
  codex.complete = async function textTransport(options) {
    assert.ok(options.messages[0].content.includes('【审美只读工具协议】'));
    assert.ok(options.messages[0].content.includes('"required":["query","count"]'));
    const last = options.messages[options.messages.length - 1];
    let calls;
    if (last.role === 'user' && Array.isArray(last.content)) {
      assert.equal(last.content.filter(function image(p) { return p.type === 'image_url'; }).length, 2);
      assert.ok(options.messages.some(function history(message) { return message.role === 'assistant' && message.content.includes('<tool_call>'); }));
      directCompared++;
      return { role: 'assistant', content: '【审美投票】通过\n【挑刺】\n无' };
    }
    if (last.role === 'tool') calls = [call('view_review_image', { source: 'page.html', width: 64, height: 32 }, 0), call('view_review_image', { source: '参考图1' }, 1)];
    else calls = [call('search_reference_images', { query: '蓝色页面', count: 1 }, 0)];
    const lines = [];
    for (const item of calls) lines.push('<tool_call>{"name":' + JSON.stringify(item.function.name) + ',"arguments":' + item.function.arguments + '}</tool_call>');
    return { role: 'assistant', content: lines.join('\n') };
  };
  const directModels = [];
  for (const id of ['a', 'b']) directModels.push({ id, config: { type: 'api', protocol: 'codex', baseUrl: 'codex://sdk', model: 'gpt-6', vision: true } });
  const directResult = await review.review({ models: directModels, changes: [{ path: 'page.html' }], workspace,
    systemPrompt: review.criticInstruction(), completeFn: api.completeAesthetic, prepareImages: prepare });
  codex.complete = originalComplete;
  assert.ok(directCompared === 2 && directResult.passed, JSON.stringify({ directCompared, directResult }));
  check(true, '纯文字工具传输也携带限定 Schema、调用历史和真实图片，XML 调用能完成评审循环');
  await verifyAdapterBoundaries(api, pair, store);
  await assert.rejects(api.completeAesthetic({ modelCfg: { type: 'api', protocol: 'openai', model: 'reject-vision', baseUrl: origin + '/v1' },
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: red.dataUrl } }] }], toolSpec: reference.toolSpecs }), /image|看图|图片/i);
  check(rejected > 0 && rejectedWithoutImages === 0, '原生视觉被接口拒绝后报告失败，协议内重试也未丢图或继续纯文本投票');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reference.viewImage(workspace, { source: 'page.html', width: 64, height: 32 }, new Map(), controller.signal), /abort/i);
  check(BrowserWindow.getAllWindows().length === 0, '渲染完成与取消后没有残留看图窗口');
  if (process.argv.includes('--live')) {
    live = true;
    const hits = await reference.searchImages('dashboard ui', 1);
    check(hits.length === 1 && hits[0].sourceUrl.startsWith('http'), '真实 Bing 查询返回原图与来源网页');
    const remote = await reference.viewImage(workspace, { source: '参考图1' }, new Map([['参考图1', hits[0]]]));
    check(remote.width > 0 && remote.height > 0, '真实参考原图下载并成功解码为像素');
    console.log('LIVE_REFERENCE ' + JSON.stringify({ title: hits[0].title, sourceUrl: hits[0].sourceUrl, width: remote.width, height: remote.height }));
  }
  fs.writeFileSync(path.join(workspace, 'verification.json'), JSON.stringify({ checks, compared, searchCount, live, passed: true }, null, 2), 'utf8');
  server.close();
  console.log('RESULT ' + JSON.stringify({ checks, workspace }));
  app.exit(0);
}
main().catch(function failed(error) { console.error(error.stack || error); app.exit(1); });

// 参考文件验收：真实附件解析、IPC、持久化、拖入入口和 Electron Canvas 层级。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const { createReferenceTree, register } = require('../electron/lib/reference-tree');
const { createDocxFixture, assertEdge } = require('./test-docx-reference.cjs');

const root = path.join(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-reference-test-'));
let window;
let serial = 0;
const failures = [];

/** 在真实测试目录保存一个附件；不触碰用户会话或参考存档。 */
function saveFixture(_event, file) {
  const target = path.join(directory, (++serial) + '-' + file.name);
  fs.writeFileSync(target, Buffer.from(file.base64, 'base64'));
  return { path: target, name: file.name };
}

/** 截取已核实生产函数区段，保留真实附件转换和导图入口实现。 */
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, '生产区段必须存在且顺序正确：' + start);
  return source.substring(from, to);
}

/** 等待真实渲染页完成异步拖入识别，失败提示立即终止验收。 */
async function waitForMap() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await window.webContents.executeJavaScript('({open: PlanMap.isOpen(), failures: fixture.failures, busy: referenceImports.size > 0})');
    assert.deepEqual(state.failures, []);
    if (state.open && !state.busy) return;
    await new Promise(waitTick);
  }
  throw new Error('拖入参考文件未在期限内完成识别及展示');
}

/** 本地异步采样间隔，避免以语法检查冒充运行完成。 */
function waitTick(resolve) { setTimeout(resolve, 50); }

/** 执行真实服务、主进程桥及现有导图 Canvas 的行为核对。 */
async function main() {
  await app.whenReady();
  const sessionDir = function sessionDir() { return path.join(directory, 'sessions'); };
  const service = register({ ipcMain, sessionDir });
  ipcMain.handle('paste:save', saveFixture);
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
  const dropStart = source.indexOf("  composer.addEventListener('drop', async function onReferenceDrop");
  const dropEnd = source.indexOf("  document.addEventListener('keydown'", dropStart);
  assert(dropStart >= 0 && dropEnd > dropStart);
  const drop = source.substring(dropStart, dropEnd);
  window = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, preload: path.join(root, 'electron/preload.js') }
  });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><head><style>:root{--panel-solid:#fff;--text:#202830;--muted:#708090;--border:#ccd4de;--hover:#f0f3f6;--overlay:#ccd4de;--primary-bg:#346ddd;--primary-fg:#fff}body{font-family:sans-serif}button{cursor:pointer}</style></head><body><div id="composer"><div id="chips"></div></div></body></html>'));
  await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer/plan-map.js'), 'utf8'));
  const setup = [
    "const api = window.simple;",
    "const fixture = window.fixture = {tab:{id:'drag-reference',title:'参考文件验收',workspace:''},attachments:[],failures:[],retries:0};",
    "const state = {attachments:fixture.attachments};",
    "function activeSession(){return fixture.tab;}",
    "function scheduleComposerSave(){fixture.saved=true;}",
    "function renderChips(){fixture.chips=true;}",
    "function retryHotReload(){fixture.retries++;}",
    "function isImageName(name){return /\\.(png|jpe?g|gif|webp|bmp)$/i.test(name);}",
    "window.alert=function recordFailure(message){fixture.failures.push(String(message));};",
    between(source, 'async function addAttachments(list)', '// 识别请求可能有多个并行批次'),
    between(source, 'const referenceImports = new Set();', '/* ===== 剪贴板常驻面板'),
    between(source, 'function bufToB64(buf)', 'async function attachmentsFromPasteEvent'),
    "const composer=document.getElementById('composer');",
    drop
  ].join('\n');
  await window.webContents.executeJavaScript(setup);
  const markdown = '# 角色界面\n## 布局\n- 左侧导航\n  - 角色列表\n## 配色\n蓝色按钮\n';
  await window.webContents.executeJavaScript("const transfer=new DataTransfer();transfer.items.add(new File([" + JSON.stringify(markdown) + "],'reference.md',{type:'text/markdown'}));const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});composer.dispatchEvent(event);");
  await waitForMap();
  const renderer = await window.webContents.executeJavaScript("({attachments:state.attachments, saved:fixture.saved, chips:fixture.chips, retries:fixture.retries, canvas:!!document.querySelector('#plan-map-modal canvas'), text:document.getElementById('plan-map-modal').innerText})");
  assert.equal(renderer.attachments.length, 1);
  assert.equal(renderer.attachments[0].name, 'reference.md');
  assert.equal(renderer.saved, true);
  assert.equal(renderer.chips, true);
  assert.equal(renderer.retries, 1);
  assert.equal(renderer.canvas, true);
  assert.match(renderer.text, /参考导图/);
  const map = service.read({ tabId: 'drag-reference' });
  const title = map.nodes.find(function titleNode(node) { return node.title === '角色界面'; });
  const layout = map.nodes.find(function layoutNode(node) { return node.title === '布局'; });
  const navigation = map.nodes.find(function navigationNode(node) { return node.title === '左侧导航'; });
  const list = map.nodes.find(function listNode(node) { return node.title === '角色列表'; });
  assert(map.edges.some(function headingEdge(edge) { return edge.from === title.id && edge.to === layout.id; }));
  assert(map.edges.some(function listEdge(edge) { return edge.from === navigation.id && edge.to === list.id; }));
  const reopened = createReferenceTree({ sessionDir });
  assert.deepEqual(reopened.read({tabId:'drag-reference'}), map, '重新创建服务后完整恢复层级与原文');
  const again = await service.importFiles({ tabId:'drag-reference',files:renderer.attachments });
  assert.equal(again.nodes.length, map.nodes.length, '再次拖入同一路径不重复建树');
  assert.equal(service.read({tabId:'another-tab'}).nodes.length, 1, '参考按会话隔离');
  const draw = await window.webContents.executeJavaScript("PlanMap.close();const recorded=[];const fill=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function record(text,x,y){const m=this.getTransform();recorded.push({text,x,y,px:m.a*x+m.e,py:m.d*y+m.f,pw:this.measureText(text).width*m.a,cw:this.canvas.width,ch:this.canvas.height});return fill.apply(this,arguments);};PlanMap.open({title:'层级位置验证',heading:'参考导图',readOnly:true,map:" + JSON.stringify(map) + "});recorded;");
  function xOf(text) { return draw.find(function sameLabel(record) { return record.text === text; }).x; }
  assert(xOf('角色界面') < xOf('布局'));
  assert(xOf('布局') < xOf('左侧导航'));
  assert(xOf('左侧导航') < xOf('角色列表'));
  for (const record of draw) {
    assert(record.px >= 0 && record.px + record.pw <= record.cw, '多级参考树首次打开时文字必须横向入画：' + record.text);
    assert(record.py >= 0 && record.py <= record.ch, '多级参考树首次打开时文字必须纵向入画：' + record.text);
  }
  const png = await window.webContents.capturePage();
  const preview = path.join(directory, 'reference-map.png');
  fs.writeFileSync(preview, png.toPNG());
  // 真实 Office 解析器必须保留工作表节点，不能只验证测试桩里的文本。
  const xlsx = require('xlsx');
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['项目','值'],['攻击','12']]), '角色数值');
  const spreadsheet = path.join(directory, 'reference.xlsx');
  xlsx.writeFile(workbook, spreadsheet);
  const office = await service.importFiles({ tabId:'office-reference',files:[{path:spreadsheet,name:'reference.xlsx'}] });
  assert(office.nodes.some(function sheetNode(node) { return node.title === '工作表 角色数值'; }));
  assert(office.nodes.some(function valueNode(node) { return node.requirement.includes('攻击,12'); }));
  // 用真实 DOCX 二进制触发生产拖入入口，覆盖附件保存、IPC、Word 结构转换与 Canvas 展示。
  const docx = await createDocxFixture(directory);
  const docxBytes = JSON.stringify([...fs.readFileSync(docx)]);
  await window.webContents.executeJavaScript("PlanMap.close();fixture.tab.id='word-drag-reference';const wordTransfer=new DataTransfer();wordTransfer.items.add(new File([Uint8Array.from(" + docxBytes + ")],'word-reference.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));const wordEvent=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(wordEvent,'dataTransfer',{value:wordTransfer});composer.dispatchEvent(wordEvent);");
  await waitForMap();
  const wordMap = service.read({tabId:'word-drag-reference'});
  assertEdge(wordMap, '角色方案', '界面布局');
  assertEdge(wordMap, '界面布局', '顶部导航');
  assertEdge(wordMap, '顶部导航', '角色入口');
  assertEdge(wordMap, '角色入口', '详情按钮');
  assertEdge(wordMap, '顶部导航', '活动入口');
  assertEdge(wordMap, '界面布局', '底部操作');
  assertEdge(wordMap, '界面布局', '# 这不是Word标题');
  assertEdge(wordMap, '最终说明', '1. 这是普通正文，不是列表');
  const wordRenderer = await window.webContents.executeJavaScript("({attachments:state.attachments.length,canvas:!!document.querySelector('#plan-map-modal canvas'),text:document.getElementById('plan-map-modal').innerText})");
  assert.equal(wordRenderer.attachments, 2);
  assert.equal(wordRenderer.canvas, true);
  assert.match(wordRenderer.text, /参考导图/);
  const vision = createReferenceTree({
    sessionDir,
    parseAttachment: async function imageInput() { return {kind:'image',name:'image.png',dataUrl:'data:image/png;base64,actual-pixels'}; },
    recognizeImage: async function seePixels(dataUrl, name) {
      assert.equal(dataUrl,'data:image/png;base64,actual-pixels');
      assert.equal(name,'image.png');
      return '# 参考画面\n## 构图\n- 中央角色';
    }
  });
  const visualMap = await vision.importFiles({tabId:'visual-reference',files:[{path:path.join(directory,'image.png'),name:'image.png'}]});
  assert(visualMap.nodes.some(function pixelNode(node){return node.title==='中央角色';}));
  const broken = createReferenceTree({
    sessionDir,
    parseAttachment: async function imageInput(){return {kind:'image',dataUrl:'data:image/png;base64,actual-pixels'};},
    recognizeImage: async function failRecognition(){throw new Error('视觉识别失败');}
  });
  await assert.rejects(broken.importFiles({tabId:'failed-reference',files:[{path:path.join(directory,'bad.png'),name:'bad.png'}]}),/视觉识别失败/);
  assert.equal(broken.read({tabId:'failed-reference'}).nodes.length,1,'识别失败不得登记为已入图');
  console.log(JSON.stringify({ok:true,checks:['真实拖入事件与附件转换','真实IPC导入和读取','Markdown标题及缩进列表层级','原文及层级跨服务恢复','重复导入不重复建树','会话隔离','真实Canvas多级横向位置','真实XLSX解析与工作表结构','真实DOCX二进制拖入及三级样式/列表入图','图片像素识别边界','识别失败不入图'],preview},null,2));
  window.destroy();
  app.quit();
}

/** 验收失败保留实际错误并返回非零状态。 */
function failed(error) {
  failures.push(error.stack || String(error));
  console.error(failures.join('\n'));
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
}
main().catch(failed);

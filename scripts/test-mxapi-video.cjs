/**
 * 按已核实的 MXAPI 文档录制响应，运行真实生成与引用解析代码。
 * HTTP 在进程内替换为确定性响应，不调用付费接口；检查请求结构、下载、失败和取消。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
let replies = [], calls = [];
let checked = 0;
/** 记录请求并按顺序消费文档响应，不向网络发送密钥。 */
async function fakeFetch(url, options = {}) {
  if (options.signal) options.signal.throwIfAborted();
  calls.push({ url, ...options });
  assert.ok(replies.length, '出现未预期的请求');
  const next = replies.shift();
  if (next instanceof Error) throw next;
  if (next.bytes) return { ok: true, arrayBuffer: async function bytes() { return Buffer.from(next.bytes); } };
  return { ok: next.status === undefined || next.status === 200, status: next.status || 200,
    json: async function json() { return next.json; } };
}
/** 仅压缩测试等待，仍检查取消信号，生产轮询保持文档要求。 */
async function fakeDelay(_ms, _value, options) { options.signal.throwIfAborted(); }
/** 加载生产模块，非网络逻辑不改写。 */
function load(relative, replacements) {
  const file = path.join(root, relative);
  const original = require('node:module').createRequire(file);
  const module = { exports: {} };
  function dependency(name) { return Object.hasOwn(replacements,name) ? replacements[name] : original(name); }
  const context = { module, exports: module.exports, require: dependency, __dirname:path.dirname(file),
    Buffer, URL, FormData, Blob, AbortController, AbortSignal, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
  return module.exports;
}
const referenceBytes = Buffer.from('fixture-reference-image');
/** 在本地测试中提供可精确比对的图片字节，不访问用户附件或上传网络。 */
async function readReference(file) { assert.equal(file, 'reference.png'); return referenceBytes; }
const mxapi = load('electron/lib/mxapi.js', { './http-fetch': {httpFetch:fakeFetch}, 'node:timers/promises': {setTimeout:fakeDelay}, 'node:fs': {promises:{readFile:readReference}} });
const generate = load('electron/lib/generate.js', { './mxapi':mxapi, './http-fetch':{httpFetch:fakeFetch}, './local-llm':{}, './image-gen-engine':{} });
const provider = {id:'video-provider',name:'MXAPI',baseUrl:'https://open.mxapi.org/v1',apiKey:'fixture-only-key'};
const config = {...provider,model:'doubao-seedance-1-0-pro-fast-251015'};
/** 准备一次独立调用的响应序列。 */
function scenario(items) { calls=[]; replies=items; }
/** 记录实际通过的断言组。 */
function check(condition,label) { assert.ok(condition,label); checked++; console.log('PASS '+label); }
/** 执行协议和配置完整链路。 */
async function main() {
  scenario([{json:{code:200,data:{task_id:'task/1'}}},{json:{code:200,data:{status:'processing'}}},
    {json:{code:200,data:{status:'completed',video_url:'https://cdn.example.test/movie.mp4'}}},{bytes:'actual-video-bytes'}]);
  const result=await generate.generateMedia({role:'videoGen',modelCfg:config,prompt:'猫在奔跑 --dur 6 --ratio 16:9'});
  check(result.ext==='.mp4' && result.buf.toString()==='actual-video-bytes','真实 generateMedia 分派并下载视频字节');
  const body=JSON.parse(calls[0].body);
  check(calls[0].url==='https://open.mxapi.org/api/v2/video/generate' && body.content[0].text==='猫在奔跑 --dur 6 --ratio 16:9' && !('seconds' in body),'Seedance 使用正确路径与 content，不硬塞通用秒数');
  check(calls[1].url.endsWith('video/task?task_id=task%2F1') && calls[1].headers.Authorization==='Bearer fixture-only-key','轮询转义任务 ID 并携带厂商凭据');
  check(!calls[3].headers,'下载链接不携带厂商 API Key');
  scenario([{json:{code:200,data:{task_id:'veo-task'}}},{json:{code:200,data:{status:'completed',video_url:'https://origin.test/movie.mp4',proxy_url:'https://proxy.test/movie.mp4'}}},{bytes:'veo-bytes'}]);
  await generate.generateMedia({role:'videoGen',modelCfg:{...config,model:'veo-3.1-fast'},prompt:'海边日出'});
  check(calls[0].url.endsWith('/veo/generate') && JSON.parse(calls[0].body).prompt==='海边日出' && calls[2].url==='https://proxy.test/movie.mp4','Veo 使用独立任务路径及文档代理下载地址');
  scenario([{json:{code:200,data:{task_id:'failed'}}},{json:{code:200,data:{status:'failed',error_msg:'fixture-quota'}}}]);
  await assert.rejects(generate.generateMedia({role:'videoGen',modelCfg:config,prompt:'test'}),/fixture-quota/);
  check(calls.length===2,'异步失败保留服务端原因，不重复提交付费任务');
  scenario([{status:401,json:{code:401,message:'fixture-denied'}}]);
  await assert.rejects(mxapi.generateVideo({modelCfg:config,prompt:'test'}),/fixture-denied/);
  check(calls.length===1,'鉴权失败不会继续轮询');
  const controller=new AbortController();controller.abort();
  scenario([]);
  await assert.rejects(mxapi.generateVideo({modelCfg:config,prompt:'test',signal:controller.signal}),{name:'AbortError'});
  check(calls.length===0,'已取消的任务不发送请求');
  scenario([{json:{code:200,data:{task_id:'empty'}}},{json:{code:200,data:{status:'completed'}}}]);
  await assert.rejects(mxapi.generateVideo({modelCfg:config,prompt:'test'}),/没有返回视频地址/);
  check(calls.length===2,'完成但没有文件地址时明确失败');
  scenario([{json:{code:200,data:{url:'https://images.example.test/reference.png'}}},{json:{code:200,data:{task_id:'reference-task'}}},{json:{code:200,data:{status:'completed',video_url:'https://cdn.example.test/attack.mp4'}}},{bytes:'reference-video'}]);
  await generate.generateMedia({role:'videoGen',modelCfg:config,prompt:'持剑攻击',imagePath:'reference.png',duration:5});
  check(calls[0].url==='https://open.mxapi.org/api/v1/upload/temp-image' && !calls[0].headers && Buffer.from(await calls[0].body.get('image').arrayBuffer()).equals(referenceBytes),'真实图片字节通过 multipart 上传，不泄漏 Key');
  const referenceBody=JSON.parse(calls[1].body);
  check(referenceBody.content[1].image_url.url==='https://images.example.test/reference.png' && referenceBody.content[1].role==='first_frame' && referenceBody.content[0].text.endsWith('--dur 5'),'Seedance 请求包含上传首帧及明确5秒参数');
  scenario([{json:{code:200,data:{url:'https://images.example.test/reference.png'}}},{json:{code:200,data:{task_id:'veo-reference'}}},{json:{code:200,data:{status:'completed',video_url:'https://cdn.example.test/attack.mp4'}}},{bytes:'reference-veo'}]);
  await generate.generateMedia({role:'videoGen',modelCfg:{...config,model:'veo-3.1-fast'},prompt:'持剑攻击',imagePath:'reference.png',duration:8});
  const veoBody=JSON.parse(calls[1].body);
  check(veoBody.reference_images[0]==='https://images.example.test/reference.png' && veoBody.generation_type==='frame' && veoBody.duration==='8','Veo 请求包含真实首帧及支持的8秒参数');
  scenario([]);
  await assert.rejects(mxapi.generateVideo({modelCfg:{...config,model:'veo-3.1-fast'},prompt:'test',imagePath:'reference.png',duration:5}),/不支持 5 秒/);
  check(calls.length===0,'不支持的时长在上传和付费生成前失败');
  scenario([{status:500,json:{code:500,message:'fixture-upload-failed'}}]);
  await assert.rejects(mxapi.generateVideo({modelCfg:config,prompt:'test',imagePath:'reference.png'}),/fixture-upload-failed/);
  check(calls.length===1,'参考图上传失败后不提交付费文生视频');
  scenario([{json:{code:200,data:{remaining_points:100}}}]);
  const catalog=await mxapi.listModels({...config,baseUrl:'https://open.mxapi.org/api/v2'});
  check(catalog.models.length===6 && calls[0].url.endsWith('/points/balance'),'原生厂商通过免费接口验证并列出已接入视频模型');
  const items=mxapi.videoModels([provider]);
  const store=load('electron/lib/store.js',{'electron':{app:{getPath:function getPath(){return root;}},nativeTheme:{shouldUseDarkColors:false}},'./mxapi':mxapi});
  const settings={providers:[provider],models:[]};
  const resolved=store.resolveModelCfg(items[0].id,settings);
  check(resolved.apiKey===provider.apiKey && resolved.providerId===provider.id && !JSON.stringify(items).includes(provider.apiKey),'直接视频候选可解析厂商，候选项不复制密钥');
  provider.apiKey='fixture-rotated-key';
  check(store.resolveModelCfg(items[0].id,settings).apiKey==='fixture-rotated-key','厂商换 Key 后槽位实时使用新凭据');
  check(store.resolveModelCfg(items[0].id,{providers:[],models:[]})===null,'厂商删除后引用失效，不使用旧凭据');
  console.log('RESULT '+JSON.stringify({checks:checked,paidRequests:0}));
}
main().catch(function failed(error){console.error(error.stack);process.exitCode=1;});

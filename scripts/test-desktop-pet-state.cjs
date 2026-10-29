// 核对并行调用、等待优先级、历史恢复与工具真实结束原因。
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const config=require('../electron/lib/desktop-pet-config.json');
const {Model,activity}=require('../electron/lib/desktop-pet-state');
const {execute}=require('../electron/lib/tool-activity');
const results=[];
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/** 并行工具按callId移除，单个工具结束不清掉其他动作。 */
async function run(){
 const m=new Model(config);m.bind('a',[],0);
 function event(data,time){m.apply(Object.assign({sessionKey:'a',turnId:'t'},data),time,false);}
 event({kind:'turn-start'},0);
 event({kind:'tool',callId:'r',name:'read_file',status:'running'},500);
 event({kind:'tool',callId:'w',name:'write_file',status:'running'},1000);
 ok('并行写入动作与数量来自真实调用集合',m.state==='writing'&&m.detail.includes('2'));
 event({kind:'tool',callId:'w',name:'write_file',status:'done'},1500);
 ok('一个并行任务结束后继续显示其他任务',m.state==='reading');
 event({kind:'ask',question:'需要确认'},1501);
 ok('等待用户优先于工具动作',m.state==='waiting');
 event({kind:'answered'},1502);
 ok('回答后恢复尚未结束的读文件动作',m.state==='reading');
 event({kind:'tool',callId:'r',name:'read_file',status:'done'},2000);
 event({kind:'turn-end',outcome:'stopped'},2001);
 ok('停止不会变成成功',m.state==='stopped');
 m.bind('a',[{sessionKey:'a',turnId:'old',kind:'turn-start'},{sessionKey:'a',turnId:'old',kind:'turn-end',outcome:'success'}],2100);
 ok('历史恢复不重新庆祝',m.state==='idle');
 event({kind:'turn-start'},3000);event({kind:'tool',callId:'bad',name:'run_command',status:'running'},3500);
 event({kind:'tool',callId:'bad',name:'run_command',status:'done',outcome:'error'},4000);
 ok('单次工具失败使用通用执行提示',m.state==='running'&&m.detail===config.labels.running);
 event({kind:'tool',callId:'retry',name:'run_command',status:'running'},4500);
 event({kind:'tool',callId:'retry',name:'run_command',status:'done',outcome:'success'},5000);
 event({kind:'turn-end',outcome:'success'},5001);
 ok('工具失败重试成功后不误报遇到问题',m.state==='success');
 event({kind:'turn-start'},7500);
 event({kind:'error',text:'真实轮次错误'},8000);
 ok('显式真实错误进入问题状态并保留错误内容',m.state==='error'&&m.detail==='真实轮次错误');
 event({kind:'turn-end',outcome:'error'},8500);
 ok('真实失败的轮次仍显示遇到问题',m.state==='error'&&m.detail===config.labels.error);
 ok('未单独分类的工具使用通用执行提示',activity('todo_write')==='running');
 const events=[];
 await execute('run_command',{activity:'test'},async function(progress){progress({type:'execution-result',outcome:'error'});return 'exit 1';},function(ev){events.push(ev);});
 ok('真实执行边界分配一致调用ID并保留失败结果',events.length===2&&events[0].callId===events[1].callId&&events[1].outcome==='error');
 ok('验证用途显式驱动测试动作',events[0].activity==='testing');
 fs.writeFileSync(path.join(__dirname,'../generated/desktop-pet-check/state-results.json'),JSON.stringify({passed:results},null,2));
}
run().catch(function(error){console.error(error.stack||error);process.exitCode=1;});

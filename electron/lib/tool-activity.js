// 工具的真实执行边界提供桌宠状态，不从界面文案推断行为。
'use strict';
const { randomUUID } = require('crypto');
/** 为每次实际调用分配唯一编号，嵌套进度事件仍按原通道传递。 */
async function execute(name, args, run, emit) {
  const callId=randomUUID();
  const activity=name==='run_command' && (args.activity==='build'||args.activity==='test')?'testing':'';
  let outcome='unknown';
  /** 命令等工具在拿到原始结果时报告结果，避免把文本中的“完成”当成功。 */
  function progress(ev) {
    if(ev.type==='execution-result'){outcome=ev.outcome;return;}
    emit(ev);
  }
  emit({type:'tool',activityOnly:true,name,callId,status:'running',activity,text:name});
  try {
    const result=await run(progress);
    emit({type:'tool',activityOnly:true,name,callId,status:'done',activity,outcome,text:name});
    return result;
  } catch(error) {
    emit({type:'tool',activityOnly:true,name,callId,status:'done',activity,outcome:error.name==='AbortError'?'stopped':'error',text:error.message});
    throw error;
  }
}
module.exports={execute};

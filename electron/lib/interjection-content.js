// 插话正文和附件共用一个载荷，保留到模型真正消费的请求边界。
'use strict';
/** 概要用于需求追踪与文字提示，不把对象隐式转成字符串。 */
function textOf(item) {
 if (typeof item === 'string') return item; // 验收需求追踪已将插话转成文字概要。
 const names=item.attachments.map(function(att){return att.name;});
 return [item.text,names.length?'【插话附件】'+names.join('、'):''].filter(Boolean).join('\n');
}
/** 单独的续办指令在模型接手原任务时即已落实；含附件或具体要求的插话仍须办理。 */
function isContinueOnly(text) {
  const message = text.trim().toLowerCase();
  return message === '继续' || message === 'continue';
}
/**
 * 从模型的只读回执提取本批知悉即完成的编号，保留独立摘要。
 * @param {string} reply 模型原文。@param {string[]} ids 实际提交的插话编号。
 * @returns {{summary:string, acknowledgedIds:string[]}} 排除重复及不属于本批的标记。
 */
function parseAcknowledgments(reply, ids) {
  const allowed = new Set(ids);
  const acknowledged = new Set();
  const summary = [];
  for (const line of reply.split('\n')) {
    const record = line.trim();
    if (record.startsWith('SPCODE_ACK ')) {
      const id = record.slice('SPCODE_ACK '.length);
      if (allowed.has(id)) acknowledged.add(id);
    } else {
      summary.push(line);
    }
  }
  return { summary: summary.join('\n').trim(), acknowledgedIds: Array.from(acknowledged) };
}
/** 生成本批原话顺序对应的编号，使模型能逐条确认处理结束。 */
function todoReference(items) {
 const ids = [];
 for (const item of items) if (item.todoId) ids.push(item.todoId);
 return ids.length ? '【本批插话待办编号，按原话顺序】' + ids.join('、') + '。只需知悉的插话看完即调用 interjection_done，传 acknowledgmentOnly=true。用户说无需回复、无需操作时仍要记录这条界面回执。要求答复、改动或操作的插话办妥后，按该条编号调用并在 result 填写给用户的具体结果，原卡片立即办结；中断或尚未办妥的事项保留待处理。' : '';
}
/** 将多条补充按到达顺序标为用户插话，编号保留在用户原文标记之外。 */
function block(items) {
 const body = '【用户实时插话】\n'+items.map(textOf).join('\n\n')+'\n【插话结束】\n补充内容与此前仍有效的要求一并处理。用户明确停止或调整范围时，按更新后的要求处理。';
 return [body, todoReference(items)].filter(Boolean).join('\n');
}
/** 解析真实附件，原生视觉模型接收像素，文本模型使用既有视觉槽位。 */
async function prepare(items,options) {
 const parts=[],texts=[block(items)];
 for(const item of items) {
  if(!item.attachments.length)continue;
  const parsed=await options.parse(item.attachments);
  texts.push.apply(texts,parsed.extraTexts);
  parts.push.apply(parts,parsed.parts);
 }
 if(parts.length&&!options.vision) {
  const urls=parts.filter(function(p){return p.type==='image_url';}).map(function(p){return p.image_url.url;});
  const described=await options.describe(urls);
  texts.push(described.text);
  return {text:texts.filter(Boolean).join('\n\n'),parts:described.parts};
 }
 return {text:texts.filter(Boolean).join('\n\n'),parts};
}
module.exports={textOf,isContinueOnly,parseAcknowledgments,block,prepare,todoReference};

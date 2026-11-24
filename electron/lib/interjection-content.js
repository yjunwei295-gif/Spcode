// 插话正文和附件共用一个载荷，保留到模型真正消费的请求边界。
'use strict';
/** 概要用于需求追踪与文字提示，不把对象隐式转成字符串。 */
function textOf(item) {
 if (typeof item === 'string') return item; // 验收需求追踪已将插话转成文字概要。
 const names=item.attachments.map(function(att){return att.name;});
 return [item.text,names.length?'【插话附件】'+names.join('、'):''].filter(Boolean).join('\n');
}
/** 将多条补充按到达顺序标为用户插话。 */
function block(items) {
 return '【用户实时插话】\n'+items.map(textOf).join('\n\n')+'\n【插话结束】\n补充内容与此前仍有效的要求一并处理。用户明确停止或调整范围时，按更新后的要求处理。';
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
module.exports={textOf,block,prepare};

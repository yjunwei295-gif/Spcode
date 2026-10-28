// AI 的本机进程只读观察工具，地址用十六进制字符串保持 64 位精度。
'use strict';
const path=require('path');
const {execFile}=require('child_process');
const LIMITS={readBytes:4096,searchBytes:16*1024*1024,results:128,timeoutMs:15000};
const toolSpec={type:'function',function:{name:'process_memory',description:'只读观察本机软件或游戏进程。先用 processes 按窗口标题确认 PID，再用 modules/regions 查地址；read 读取已知地址的类型值，search 在明确的地址区间内寻找字节、文字或数值。地址必须来自真实结果。返回的原始数值不自动代表血量等业务含义，应结合画面或代码核对。不修改内存。',parameters:{type:'object',properties:{action:{type:'string',enum:['processes','modules','regions','read','search']},pid:{type:'integer',description:'目标进程编号'},address:{type:'string',description:'十六进制地址字符串，例如 0x10000；regions 首次可用 0x0'},length:{type:'integer',description:'读取或搜索的字节数；read 最大4096，search最大16777216'},dataType:{type:'string',enum:['bytes','int32','uint32','int64','uint64','float32','float64','utf8','utf16'],description:'read 必填，按小端解释'},encoding:{type:'string',enum:['hex','utf8','utf16','int32','float32'],description:'search 必填，待查值的编码'},value:{type:'string',description:'search 必填，十六进制字节、文本或数字'},limit:{type:'integer',description:'regions/search 必填，最多返回128条'}},required:['action']}}};
/** 核对显式边界，错误直接返回，绝不换成别的进程或地址。 */
function validate(args){
 if(!['processes','modules','regions','read','search'].includes(args.action))throw new Error('未知内存操作');
 if(args.action==='processes')return;
 if(!Number.isInteger(args.pid)||args.pid<=0)throw new Error('必须明确目标 PID');
 if(args.action==='modules')return;
 if(typeof args.address!=='string'||!/^0x[0-9a-f]+$/i.test(args.address)||BigInt(args.address)>0x7fffffffffffffffn)throw new Error('地址必须为有效的64位十六进制字符串');
 if(['regions','search'].includes(args.action)&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>LIMITS.results))throw new Error('limit 必须为1至128');
 if(['read','search'].includes(args.action)){
  const max=args.action==='read'?LIMITS.readBytes:LIMITS.searchBytes;
  if(!Number.isInteger(args.length)||args.length<1||args.length>max)throw new Error('length 超出范围，最大'+max+'字节');
 }
 if(args.action==='read'&&!toolSpec.function.parameters.properties.dataType.enum.includes(args.dataType))throw new Error('read 必须指定 dataType');
}
/** 把明确的搜索值编码成字节；不做模糊或跨类型猜测。 */
function pattern(args){
 if(typeof args.value!=='string')throw new Error('search 必须提供 value');
 if(args.encoding==='hex'){
  const text=args.value.split(' ').join('');
  if(!/^(?:[0-9a-f]{2})+$/i.test(text))throw new Error('hex 必须为完整字节');
  return Buffer.from(text,'hex');
 }
 if(args.encoding==='utf8'||args.encoding==='utf16'){
  if(!args.value.length)throw new Error('搜索文本不能为空');
  return Buffer.from(args.value,args.encoding==='utf8'?'utf8':'utf16le');
 }
 const n=Number(args.value);
 if(!Number.isFinite(n))throw new Error('搜索数值无效');
 const bytes=Buffer.alloc(4);
 if(args.encoding==='int32'){if(!Number.isInteger(n)||n<-2147483648||n>2147483647)throw new Error('int32 搜索值越界');bytes.writeInt32LE(n);}
 else if(args.encoding==='float32')bytes.writeFloatLE(n);
 else throw new Error('search 必须指定 encoding');
 return bytes;
}
/** 对原始字节按调用方指定类型解码，64位整数保留为字符串。 */
function decode(bytes,type){
 if(type==='bytes')return bytes.toString('hex');
 if(type==='utf8'||type==='utf16')return bytes.toString(type==='utf8'?'utf8':'utf16le');
 const readers={int32:['readInt32LE',4],uint32:['readUInt32LE',4],int64:['readBigInt64LE',8],uint64:['readBigUInt64LE',8],float32:['readFloatLE',4],float64:['readDoubleLE',8]};
 const info=readers[type];
 if(bytes.length%info[1])throw new Error('length 必须是 '+info[1]+' 的整数倍');
 const values=[];for(let i=0;i<bytes.length;i+=info[1]){const v=bytes[info[0]](i);values.push(typeof v==='bigint'?String(v):v);}
 return values;
}
/** 使用结构化参数启动本机帮助程序；只申请查询与读取权限。 */
async function run(args,signal){
 if(process.platform!=='win32')throw new Error('进程内存工具当前支持Windows');
 validate(args);
 const request=Object.assign({},args);
 if(args.action==='search')request.pattern=pattern(args).toString('base64');
 const payload=Buffer.from(JSON.stringify(request),'utf8').toString('base64');
 // 外部PowerShell不能打开asar虚拟路径，打包时使用已声明解包的真实文件。
 const file=path.join(__dirname,'process-memory.ps1').split(path.sep+'app.asar'+path.sep).join(path.sep+'app.asar.unpacked'+path.sep);
 const result=await new Promise(function(resolve,reject){
  const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,'-Payload',payload],{windowsHide:true,timeout:LIMITS.timeoutMs,maxBuffer:1024*1024,signal},function(error,stdout,stderr){
   if(error){reject(new Error(stdout.trim()||stderr.trim()||error.message));return;}
   try{resolve(JSON.parse(stdout.trim()));}catch(parseError){reject(parseError);}
  });
 });
 if(args.action==='read'){const bytes=Buffer.from(result.base64,'base64');delete result.base64;result.dataType=args.dataType;result.value=decode(bytes,args.dataType);}
 return result;
}
module.exports={toolSpec,run,validate,decode,pattern,LIMITS};

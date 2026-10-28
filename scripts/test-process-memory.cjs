// 使用独立测试进程分配已知数据，核对跨进程真实读取、搜索与错误返回。
'use strict';
const assert=require('assert');
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const memory=require('../electron/lib/process-memory');
const results=[];
/** 目标进程只向自己的缓冲区写入样本，读取工具保持只读。 */
function fixture(){
 const script='$p=[Runtime.InteropServices.Marshal]::AllocHGlobal(256);[Runtime.InteropServices.Marshal]::WriteInt32($p,137);$f=[BitConverter]::GetBytes([single]23.5);[Runtime.InteropServices.Marshal]::Copy($f,0,[IntPtr]::Add($p,4),4);$t=[Text.Encoding]::UTF8.GetBytes("SP_CODE_MEMORY_FIXTURE");[Runtime.InteropServices.Marshal]::Copy($t,0,[IntPtr]::Add($p,8),$t.Length);[Console]::WriteLine((@{pid=$PID;address=("0x"+$p.ToInt64().ToString("X"))}|ConvertTo-Json -Compress));[Console]::ReadLine()|Out-Null;[Runtime.InteropServices.Marshal]::FreeHGlobal($p)';
 const child=spawn('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 return new Promise(function(resolve,reject){let text='';child.stdout.on('data',function(chunk){text+=chunk;if(text.includes('\n')){try{resolve({child,data:JSON.parse(text.trim())});}catch(error){reject(error);}}});child.on('error',reject);child.on('exit',function(code){if(!text)reject(new Error('样本进程提前退出:'+code));});});
}
/** 每条结果均来自工具原样返回。 */
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/** 实测类型值、模块、区域分页、精确查找及不可读地址失败。 */
async function run(){
 const sample=await fixture(),pid=sample.data.pid,address=sample.data.address;
 try{
  const integer=await memory.run({action:'read',pid,address,length:4,dataType:'int32'});
  ok('跨进程int32读取137',integer.value[0]===137);
  const floatAddress='0x'+(BigInt(address)+4n).toString(16);
  const float=await memory.run({action:'read',pid,address:floatAddress,length:4,dataType:'float32'});
  ok('跨进程float32读取23.5',float.value[0]===23.5);
  const hits=await memory.run({action:'search',pid,address,length:64,encoding:'utf8',value:'SP_CODE_MEMORY_FIXTURE',limit:8});
  ok('指定区间定位实际字符串',hits.matches.length===1&&BigInt(hits.matches[0])===BigInt(address)+8n);
  const regions=await memory.run({action:'regions',pid,address,limit:1});
  ok('VirtualQueryEx返回包含样本的可读区域',regions.regions.length===1&&regions.regions[0].readable&&BigInt(regions.regions[0].address)<=BigInt(address));
  const modules=await memory.run({action:'modules',pid});
  ok('读取目标真实模块与基址',modules.modules.length>0&&modules.modules.some(function(m){return m.name.toLowerCase()==='powershell.exe';}));
  let unreadable=false;try{await memory.run({action:'read',pid,address:'0x1',length:4,dataType:'int32'});}catch(error){unreadable=true;}
  ok('不可读地址明确失败',unreadable);
  let missing=false;try{await memory.run({action:'read',address,length:4,dataType:'int32'});}catch(error){missing=true;}
  ok('未指定PID时不猜目标进程',missing);
  fs.writeFileSync(path.join(__dirname,'../generated/desktop-pet-check/memory-results.json'),JSON.stringify({passed:results,fixture:{pid,address},integer,float,hits,regions},null,2));
 }finally{sample.child.stdin.end('\n');sample.child.kill();}
}
run().catch(function(error){console.error(error.stack||error);process.exitCode=1;});

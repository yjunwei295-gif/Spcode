// 导入实际ZIP并检查动作资源，缺图或缺动作的皮肤必须被明确拒绝。
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),JSZip=require('jszip');
const {createLibrary,validate}=require('../electron/lib/desktop-pet-skins');
const results=[];
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/** 临时用户目录隔离测试皮肤，不改用户已经安装的皮肤。 */
async function run(){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'spcode-skin-check-'));
 const library=createLibrary(base);
 const source=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko');
 const original=JSON.parse(fs.readFileSync(path.join(source,'skin.json'),'utf8')),png=fs.readFileSync(path.join(source,'atlas.png'));
 const manifest=JSON.parse(JSON.stringify(original));manifest.id='fixture-neko';manifest.name='验收皮肤';
 const zip=new JSZip();zip.file('skin.json',JSON.stringify(manifest));zip.file(manifest.atlas,png);
 const file=path.join(base,'skin.zip');fs.writeFileSync(file,await zip.generateAsync({type:'nodebuffer'}));
 const skin=await library.importZip(file);
 ok('真实ZIP导入并生成可解码本地图集地址',skin.id==='fixture-neko'&&skin.atlasUrl.startsWith('file:'));
 ok('导入皮肤出现在换肤列表',library.list().some(function(one){return one.id==='fixture-neko'&&!one.error;}));
 let duplicate=false;try{await library.importZip(file);}catch(error){duplicate=error.message.includes('同名');}
 ok('同名皮肤明确拒绝覆盖',duplicate);
 const missing=JSON.parse(JSON.stringify(manifest));delete missing.animations.waiting;
 let rejected=false;try{validate(missing,function(){return png;});}catch(error){rejected=error.message.includes('waiting');}
 ok('缺少等待确认动作时明确指出缺项',rejected);
 const outside=Object.assign({},manifest,{atlas:'../atlas.png'});let escaped=false;
 try{validate(outside,function(){return png;});}catch(error){escaped=true;}
 ok('皮肤资源限定为包内相对路径',escaped);
 fs.writeFileSync(path.join(__dirname,'../generated/desktop-pet-check/skin-results.json'),JSON.stringify({passed:results},null,2));
}
run().catch(function(error){console.error(error.stack||error);process.exitCode=1;});

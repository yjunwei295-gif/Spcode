// 原图无损像素重绘及局部变形；不加载PNG、不调用生图、不用几何五官覆盖原图。
'use strict';
/**
 * 将离线编译的RGBA与独立去底蒙版解码到Canvas。
 * encoded 是 compile-crystal-pixels.cjs 的输出；返回原图、透明底与可复用工作区。
 * 原图保留全部像素，透明底只更改背景的alpha，人物颜色不变。
 */
async function loadCrystalPixels(encoded) {
  /** 使用浏览器标准无损解压，一次初始化后所有动作复用同一数据。 */
  async function inflate(value) {
    var binary=atob(value),bytes=new Uint8Array(binary.length);
    for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    var stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  var rgba=await inflate(encoded.rgba),mask=await inflate(encoded.backgroundMask);
  var original=document.createElement('canvas');original.width=encoded.width;original.height=encoded.height;
  original.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),encoded.width,encoded.height),0,0);
  var foreground=new Uint8ClampedArray(rgba);
  for(var n=0;n<mask.length;n++)if(mask[n])foreground[n*4+3]=0;
  var work=document.createElement('canvas');work.width=encoded.width;work.height=encoded.height;
  var imageData=new ImageData(new Uint8ClampedArray(foreground),encoded.width,encoded.height);
  return {width:encoded.width,height:encoded.height,original:original,foreground:foreground,work:work,frame:imageData};
}
/**
 * 直接按原尺寸重绘完整参考像素，用于与附件逐像素验收。
 * 不进行缩放、去底、补画或调色；目标Canvas应使用原图宽高。
 */
function drawCrystalPixelReference(ctx,art) {
  ctx.clearRect(0,0,art.width,art.height);
  ctx.drawImage(art.original,0,0);
}
/**
 * 绘制透明底桌宠动作帧，参数phase只决定当前帧，不依赖实时计时器。
 * data给出眼嘴实测区域、动作和表情配置；形变只在眼嘴内部平滑重采样原像素。
 * 不叠加新嘴或遮眼色块；idle首帧不改五官，保持参考原貌。
 */
function drawCrystalPixelFrame(ctx,size,state,phase,data,art) {
  var profile=data.expressions[state],motion=data.motion,base=data.expressions.idle;
  var pixels=art.frame.data,source=art.foreground,w=art.width,h=art.height;
  pixels.set(source);
  var distance=Math.abs(phase-motion.blinkCenter);distance=Math.min(distance,1-distance);
  var blink=distance<motion.blinkHalfWidth?(1+Math.cos(distance/motion.blinkHalfWidth*Math.PI))/2:0;
  var closure=Math.max(0,profile.lid-base.lid,blink);
  /** 椭圆内部进行连续像素位移，边界位移归零，避免接缝或覆盖原有细节。 */
  function warp(box,strength,opening) {
    if(strength===0)return;
    var cx=box[0],cy=box[1],rx=box[2],ry=box[3],power=1+strength*4,normal=Math.tanh(power);
    for(var y=Math.floor(cy-ry);y<=cy+ry;y++){
      for(var x=Math.floor(cx-rx);x<=cx+rx;x++){
        var nx=(x-cx)/rx,ny=(y-cy)/ry;
        if(nx*nx+ny*ny>=1)continue;
        var falloff=Math.pow(1-nx*nx,2);
        var mapped=opening?Math.atanh(ny*normal)/power:Math.tanh(ny*power)/normal;
        var sy=y+(cy+mapped*ry-y)*falloff,y0=Math.floor(sy),y1=y0+1,t=sy-y0;
        var output=(y*w+x)*4,a=(y0*w+x)*4,b=(y1*w+x)*4;
        for(var k=0;k<4;k++)pixels[output+k]=Math.round(source[a+k]*(1-t)+source[b+k]*t);
      }
    }
  }
  warp(data.pixel.leftEye,closure,false);warp(data.pixel.rightEye,closure,false);
  var wave=Math.sin(phase*Math.PI*2);
  if(profile.mouth==='open')warp(data.pixel.mouth,data.pixel.mouthStretch*(.6+.4*wave),true);
  art.work.getContext('2d').putImageData(art.frame,0,0);
  var scale=Math.min(size*data.pixel.coverage/w,size*data.pixel.coverage/h);
  var width=w*scale,height=h*scale;
  var bounce=wave*motion.bounce*size/data.cellSize;
  if(state==='success')bounce=-Math.pow(Math.sin(phase*Math.PI),2)*motion.successJump*size/data.cellSize;
  if(state==='dragging')bounce=(-motion.dragLift+wave)*size/data.cellSize;
  var squash=state==='landing'?motion.landingSquash*(1-phase)*Math.sin(phase*Math.PI):0;
  var tilt=data.poses[state][4]*.4+wave*motion.hairSwing*.5;
  ctx.clearRect(0,0,size,size);ctx.save();
  ctx.translate(size/2,size*.98+bounce);ctx.rotate(tilt*Math.PI/180);
  ctx.scale(1+squash,1-squash);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(art.work,-width/2,-height,width,height);
  ctx.restore();
}
/** 同一函数源用于离屏烘焙与网页预览，避免两端表情实现不一致。 */
function getDrawSource() { return String(loadCrystalPixels)+'\n'+String(drawCrystalPixelReference)+'\n'+String(drawCrystalPixelFrame); }
if(typeof module!=='undefined'&&module.exports)module.exports={getDrawSource:getDrawSource};
else {window.loadCrystalPixels=loadCrystalPixels;window.drawCrystalPixelReference=drawCrystalPixelReference;window.drawCrystalPixelFrame=drawCrystalPixelFrame;}

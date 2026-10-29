/* 尖角墨镜独立叠加层：紫色长三角镜片、青蓝锐边与真实工作 HUD；不写入角色资源。 */
(function(root){
 'use strict';
 /**
  * 按当前皮肤、动作与帧号绘制尖角墨镜。
  * config 提供源图眼线、三角轮廓和外观参数；只更新独立画布，保留原图及角色像素。
  * 左右镜片共用眼部锚点高度；绕当前图集的下方支点位移、旋转，并同步落地压缩。
  */
 function paint(ctx,config,skin,state,frame){
  ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
  ctx.canvas.dataset.state=skin.id===config.skinId?state:'';
  ctx.canvas.dataset.frame=String(frame);
  if(skin.id!==config.skinId)return;
  var clip=skin.animations[state];
  var phase=clip.loop?frame/clip.frames:frame/(clip.frames-1);
  var wave=Math.sin(phase*Math.PI*2),motion=config.motion;
  var bounce=wave*motion.bounce*config.bounceFactor;
  if(state==='success')bounce=-Math.pow(Math.sin(phase*Math.PI),2)*motion.successJump*config.successFactor;
  if(state==='dragging')bounce=-motion.dragLift*config.dragFactor+wave;
  var tilt=config.tilts[state]*config.tiltFactor+wave*motion.hairSwing*config.swingFactor;
  var squash=state==='landing'?motion.landingSquash*(1-phase)*Math.sin(phase*Math.PI):0;
  var scale=Math.min(skin.cellSize*config.headRatio/config.crop[2],skin.cellSize*config.headRatio/config.crop[3]);
  var width=config.lensWidth,height=config.lensHeight;
  // 用户两轴偏移采用图集像素，在头部坐标中应用；镜片与鼻梁整体随同旋转和落地压缩，不移动角色。
  var y=(config.eyeLine-config.crop[1]-config.crop[3]*config.pivotY)*scale+config.verticalOffset;
  var centers=[];
  // 当前图集绕下方支点旋转；先应用整张角色的运动，再平移回已配准的静止眼部坐标。
  // 落地压缩必须作用于镜片形状和位置，不能只让鼻梁上下移动。
  ctx.save();ctx.translate(skin.cellSize/2,skin.cellSize*config.motionOriginY+bounce);ctx.rotate(tilt*Math.PI/180);
  ctx.scale(1+squash,1-squash);ctx.translate(0,skin.cellSize*(config.originY-config.motionOriginY));
  for(var i=0;i<config.eyes.length;i++){
   var x=(config.eyes[i]-config.crop[0]-config.crop[2]/2)*scale+config.horizontalOffset;
   centers.push(x);
   lens(ctx,x,y,width,height,i===0?-1:1,config,state,phase,i);
  }
  bridge(ctx,centers,y,width,height,config);
  ctx.restore();
 }
 /**
  * 创建向外上挑的三角镜片轮廓。
  * side 为左侧 -1 或右侧 1；六个形状参数分别控制外翼、内角和下角，左右严格镜像。
  * 原点为已配准的眼部锚点，不采用三角形重心定位，避免形状上挑后偏离眼睛。
  */
 function outline(ctx,width,height,side,shape){
  ctx.beginPath();
  ctx.moveTo(side*width*shape.wingReach,-height*shape.tipRise);
  ctx.lineTo(-side*width*shape.innerReach,-height*shape.innerRise);
  ctx.lineTo(-side*width*shape.lowerReach,height*shape.lowerDrop);
  ctx.closePath();
 }
 /**
  * 绘制皮肤同色的长三角镜片、青蓝锐利描边与斜向反光。
  * 轮廓使用抗锯齿矢量直线；反光与工作 HUD 均裁切在三角镜片中，眼睛透过半透明玻璃可见。
  */
 function lens(ctx,cx,cy,width,height,side,config,state,phase,index){
  ctx.save();ctx.translate(cx,cy);ctx.lineJoin='miter';ctx.lineCap='butt';
  outline(ctx,width,height,side,config.shape);
  var glass=ctx.createLinearGradient(0,-height*config.shape.tipRise,0,height*config.shape.lowerDrop);
  glass.addColorStop(0,config.lensTop);glass.addColorStop(1,config.lensBottom);
  ctx.fillStyle=glass;ctx.fill();
  ctx.strokeStyle=config.edgeColor;ctx.lineWidth=config.frameWidth*1.8;ctx.stroke();
  ctx.save();ctx.globalAlpha=config.rimGlowOpacity;ctx.strokeStyle=config.glowColor;
  ctx.shadowColor=config.glowColor;ctx.shadowBlur=config.glowBlur;ctx.lineWidth=config.frameWidth*1.5;ctx.stroke();ctx.restore();
  ctx.strokeStyle=config.rimColor;ctx.lineWidth=config.frameWidth;ctx.stroke();
  ctx.save();ctx.clip();
  // 反光沿上边倾斜，保留参考图中清晰的斜切高光，不增加厚重的机械装饰。
  ctx.save();ctx.globalAlpha=config.reflectionOpacity;ctx.strokeStyle=config.rimColor;ctx.lineWidth=height*.11;
  ctx.beginPath();
  ctx.moveTo(side*width*config.shape.wingReach,-height*(config.shape.tipRise-.15));
  ctx.lineTo(-side*width*config.shape.innerReach,-height*(config.shape.innerRise-.15));
  ctx.stroke();ctx.restore();
  if(index===0)glyph(ctx,config.symbols[state],-width*.08,height*.06,height*.24,config.hudColor);
  else scan(ctx,width,height,phase,config);
  ctx.restore();ctx.restore();
 }
 /**
  * 沿三角内角连接窄鼻梁。
  * 只连接现有镜片内端，不追加矩形眉梁、圆框或镜腿翼板，保持参考中的大 V 字轮廓。
  */
 function bridge(ctx,centers,y,width,height,config){
  var left=centers[0]+width*config.shape.innerReach,right=centers[1]-width*config.shape.innerReach;
  var innerY=y-height*config.shape.innerRise;
  ctx.save();ctx.lineJoin='miter';ctx.lineCap='butt';
  ctx.beginPath();ctx.moveTo(left,innerY);ctx.lineTo((left+right)/2,innerY-height*.04);ctx.lineTo(right,innerY);
  ctx.strokeStyle=config.edgeColor;ctx.lineWidth=config.frameWidth*1.8;ctx.stroke();
  ctx.strokeStyle=config.rimColor;ctx.lineWidth=config.frameWidth;ctx.stroke();ctx.restore();
 }
 /** 用平滑矢量线条显示真实状态图标；路径采用 24 单位视图，不显示命令或工具内容。 */
 function glyph(ctx,symbol,x,y,size,color){
  ctx.save();ctx.translate(x-size/2,y-size/2);ctx.scale(size/24,size/24);
  ctx.lineWidth=1.8;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=color;
  ctx.stroke(new Path2D(symbol));ctx.restore();
 }
 /**
  * 在右侧镜片中显示细扫描光带和瞄准环。
  * phase 来自角色的实际动画帧；减少动态时固定首帧，HUD 不影响三角镜形。
  */
 function scan(ctx,width,height,phase,config){
  var position=-width/2+width*phase;
  var beam=ctx.createLinearGradient(position-height*.15,0,position+height*.15,0);
  beam.addColorStop(0,'transparent');beam.addColorStop(.5,config.hudColor);beam.addColorStop(1,'transparent');
  ctx.save();ctx.globalAlpha=config.scanOpacity;ctx.fillStyle=beam;
  ctx.fillRect(-width,-height,width*2,height*2);ctx.restore();
  var x=width*.05,y=height*.04,radius=height*.1,angle=phase*Math.PI*2;
  ctx.strokeStyle=config.hudColor;ctx.lineWidth=config.frameWidth*.3;
  ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.stroke();
  ctx.lineWidth=config.frameWidth*.45;ctx.beginPath();ctx.arc(x,y,radius,angle,angle+Math.PI*.6);ctx.stroke();
  ctx.beginPath();ctx.moveTo(x-radius*1.5,y);ctx.lineTo(x-radius*.7,y);
  ctx.moveTo(x+radius*.7,y);ctx.lineTo(x+radius*1.5,y);ctx.stroke();
 }
 root.DesktopPetGlasses={paint:paint};
})(window);

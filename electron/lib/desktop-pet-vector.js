/* 高分辨率原创矢量原稿的部件烘焙与关节动画；运行时仍只使用透明PNG图集。 */
(function(root){
 'use strict';
 var parts={},settings=null,palette=null;
 /** 从完整SVG解码独立部件，按真实边界裁小缓存，保留大原稿的小切面而避免整张图片反复缩放。 */
 async function prepare(svgText,config,colors){
  settings=config;palette=colors;parts={};
  var doc=new DOMParser().parseFromString(svgText,'image/svg+xml'),svg=doc.documentElement;
  var paints=svg.querySelectorAll('[data-paint]');
  for(var i=0;i<paints.length;i++){
   var node=paints[i],color=colors[node.getAttribute('data-paint')];
   if(node.hasAttribute('fill')&&node.getAttribute('fill')!=='none')node.setAttribute('fill',color);
   if(node.hasAttribute('stroke'))node.setAttribute('stroke',color);
  }
  svg.style.position='absolute';svg.style.left='-10000px';document.body.appendChild(svg);
  for(var index=0;index<config.parts.length;index++){
   var id=config.parts[index],bounds=svg.querySelector('#'+id).getBBox(),padding=config.canvas.partPadding;
   var box={x:Math.floor(bounds.x-padding),y:Math.floor(bounds.y-padding),width:Math.ceil(bounds.width+padding*2),height:Math.ceil(bounds.height+padding*2)};
   var copy=svg.cloneNode(true);copy.removeAttribute('style');
   var groups=copy.querySelectorAll('[data-part]');
   for(var j=0;j<groups.length;j++)if(groups[j].id!==id)groups[j].remove();
   copy.setAttribute('viewBox',[box.x,box.y,box.width,box.height].join(' '));
   copy.setAttribute('width',box.width*config.canvas.rasterScale);
   copy.setAttribute('height',box.height*config.canvas.rasterScale);
   var image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(copy));await image.decode();
   parts[id]={image:image,box:box};
  }
  svg.remove();
 }
 /** 按部件自身边界绘制，不改变原稿中身体的宽高比。 */
 function part(c,id){
  var item=parts[id],b=item.box;c.drawImage(item.image,b.x,b.y,b.width,b.height);
 }
 /** 围绕明确的关节点旋转，角度使用度，旋转不会把肩、肘或膝盖分开。 */
 function rotate(c,pivot,degrees){
  c.translate(pivot[0],pivot[1]);c.rotate(degrees*Math.PI/180);c.translate(-pivot[0],-pivot[1]);
 }
 /** 上臂带动前臂，前臂再绕肘部独立运动；两段原稿在同一个关节位置重叠。 */
 function arm(c,side,upper,lower){
  var p=settings.pivots;c.save();rotate(c,p[side+'Arm'],upper);
  part(c,'arm-'+side+'-upper');rotate(c,p[side+'Elbow'],lower);part(c,'arm-'+side+'-lower');c.restore();
 }
 /** 大腿带动小腿和靴子，默认姿势保持三视图校准过的腿部体积。 */
 function leg(c,side,upper,lower){
  var p=settings.pivots;c.save();rotate(c,p[side+'Hip'],upper);
  part(c,'leg-'+side+'-upper');rotate(c,p[side+'Knee'],lower);part(c,'leg-'+side+'-lower');c.restore();
 }
 /** 尖牙已关闭：可爱赛博猫娘只保留软弧微笑，避免露牙吓人。 */
 function fangs(c,x,y,open){
  return;
 }
 /** 画锐利傲娇嘴：折线斜笑为主，浅开口不露尖牙，不做软萌圆嘴。 */
 function mouth(c,state,wave){
  var profile=settings.mouths[state],x=400+profile[0],y=428+profile[1],depth=Math.min(profile[2],10);
  c.lineCap='butt';c.lineJoin='miter';
  if(state==='speaking'||state==='success'||state==='generating'){
   var open=4+(wave+1)*2;if(state==='success')open=5+(wave+1)*2;
   c.beginPath();c.moveTo(x-20,y);c.lineTo(x-6,y+open);c.lineTo(x+6,y+open+2);c.lineTo(x+20,y-1);
   c.lineTo(x+6,y+open+depth*0.45);c.lineTo(x-6,y+open+depth*0.35);c.closePath();
   c.fillStyle=palette.faceEdge;c.fill();c.strokeStyle=palette.hair;c.lineWidth=4;c.stroke();
   fangs(c,x,y,open);return;
  }
  if(state==='error'){
   c.strokeStyle=palette.error;c.lineWidth=4;c.beginPath();
   c.moveTo(x-18,y+5);c.lineTo(x,y-2);c.lineTo(x+18,y+5);c.stroke();return;
  }
  // 默认锐利斜笑折线
  c.strokeStyle=palette.hair;c.lineWidth=4;c.beginPath();
  c.moveTo(x-20,y);c.lineTo(x-4,y+depth);c.lineTo(x+4,y+2);c.lineTo(x+20,y-1);c.stroke();
 }
 /** 填色折线用于小道具轮廓，线宽在原稿空间定义，缩到桌宠后仍保留细线。 */
 function shape(c,points,fill,stroke,width){
  c.beginPath();c.moveTo(points[0][0],points[0][1]);for(var i=1;i<points.length;i++)c.lineTo(points[i][0],points[i][1]);
  c.closePath();c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=width;c.stroke();}
 }
 /** 头旁大徽章图标：粗描边、高对比色块，各状态轮廓拉开，待机/拖动/落地不加。 */
 function badge(c,x,y,r,fill,stroke){
  c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fillStyle=fill;c.fill();
  if(stroke){c.strokeStyle=stroke;c.lineWidth=12;c.stroke();}
 }
 function prop(c,state,wave){
  var p=palette,ox=620,oy=220;c.lineJoin='round';c.lineCap='round';
  if(state==='idle'||state==='dragging'||state==='landing')return;
  // 思考 / 说话：大对话框 + 三点或声波，薄荷绿底一眼认
  if(state==='thinking'||state==='speaking'){
   badge(c,ox,oy,78,p.secondary,p.ink);
   shape(c,[[ox-48,oy-38],[ox+52,oy-42],[ox+48,oy+28],[ox+8,oy+28],[ox-8,oy+52],[ox-4,oy+28],[ox-52,oy+24]],p.jacket,p.ink,8);
   if(state==='thinking'){
    for(var d=0;d<3;d++){
     var bx=ox-28+d*28,by=oy-8+Math.sin(wave*Math.PI+d)*10;
     c.beginPath();c.arc(bx,by,10,0,Math.PI*2);c.fillStyle=p.ink;c.fill();
    }
   }else{
    c.strokeStyle=p.accent;c.lineWidth=10;c.beginPath();
    for(var w=0;w<3;w++){c.moveTo(ox-30,oy-18+w*16);c.quadraticCurveTo(ox,oy-28+w*16+wave*8,ox+34,oy-18+w*16);}
    c.stroke();
   }
   return;
  }
  // 阅读：翻开大书，页面亮白
  if(state==='reading'){
   badge(c,ox,oy,78,p.hair,p.ink);
   shape(c,[[ox-56,oy-8],[ox-2,oy+8],[ox,oy+58],[ox-58,oy+42]],p.jacket,p.ink,8);
   shape(c,[[ox-2,oy+8],[ox+56,oy-12],[ox+58,oy+38],[ox,oy+58]],'#fff8e8',p.ink,8);
   c.strokeStyle=p.hairShadow;c.lineWidth=7;c.beginPath();
   c.moveTo(ox-42,oy+12);c.lineTo(ox-14,oy+20);c.moveTo(ox-40,oy+28);c.lineTo(ox-16,oy+34);
   c.moveTo(ox+14,oy+16);c.lineTo(ox+42,oy+8);c.moveTo(ox+16,oy+32);c.lineTo(ox+44,oy+24);c.stroke();
   return;
  }
  // 写码 / 跑命令：黑终端 + 绿提示符与闪烁光标
  if(state==='writing'||state==='running'){
   badge(c,ox,oy,78,p.face,p.accent);
   shape(c,[[ox-52,oy-36],[ox+52,oy-36],[ox+52,oy+42],[ox-52,oy+42]],'#0a1220',p.accent,10);
   c.fillStyle=p.accent;c.fillRect(ox-44,oy-24,18,10);c.fillRect(ox-22,oy-24,28+(wave+1)*10,10);
   c.fillRect(ox-44,oy-4,40,10);c.fillRect(ox-44,oy+16,22+(state==='running'?wave*12:0),10);
   if(wave>0){c.fillStyle=p.metalLight;c.fillRect(ox-18,oy+16,12,18);}
   return;
  }
  // 搜索：超大放大镜
  if(state==='searching'){
   badge(c,ox,oy,78,p.faceEdge,p.secondary);
   c.beginPath();c.arc(ox-8,oy-8,36,0,Math.PI*2);c.fillStyle=p.jacket;c.fill();c.strokeStyle=p.accent;c.lineWidth=16;c.stroke();
   c.strokeStyle=p.secondary;c.lineWidth=22;c.beginPath();c.moveTo(ox+18,oy+18);c.lineTo(ox+52,oy+52);c.stroke();
   c.strokeStyle=p.ink;c.lineWidth=10;c.beginPath();c.moveTo(ox+18,oy+18);c.lineTo(ox+52,oy+52);c.stroke();
   return;
  }
  // 测试：锥形烧瓶 + 跳动液面
  if(state==='testing'){
   badge(c,ox,oy,78,p.hairLight,p.ink);
   shape(c,[[ox-14,oy-48],[ox+14,oy-48],[ox+14,oy-8],[ox+44,oy+48],[ox+36,oy+58],[ox-36,oy+58],[ox-44,oy+48],[ox-14,oy-8]],p.jacket,p.ink,8);
   shape(c,[[ox-30,oy+20+wave*8],[ox+30,oy+16+wave*8],[ox+36,oy+52],[ox-36,oy+52]],p.accent,p.ink,6);
   c.fillStyle=p.secondary;c.beginPath();c.arc(ox-8,oy+8+wave*10,8,0,Math.PI*2);c.fill();
   c.beginPath();c.arc(ox+12,oy+22-wave*8,6,0,Math.PI*2);c.fill();
   return;
  }
  // 桌面操作：显示器发光屏
  if(state==='desktop'){
   badge(c,ox,oy,78,p.bodyLight,p.ink);
   shape(c,[[ox-54,oy-40],[ox+54,oy-40],[ox+54,oy+28],[ox-54,oy+28]],p.face,p.secondary,10);
   shape(c,[[ox-44,oy-30],[ox+44,oy-30],[ox+44,oy+18],[ox-44,oy+18]],p.accent);
   shape(c,[[ox-10,oy+28],[ox+10,oy+28],[ox+10,oy+40],[ox+34,oy+48],[ox-34,oy+48],[ox-10,oy+40]],p.jacket,p.ink,6);
   return;
  }
  // 生成：旋转大星芒
  if(state==='generating'){
   badge(c,ox,oy,78,p.hairShadow,p.accent);
   c.save();c.translate(ox,oy);c.rotate(wave*0.6);
   shape(c,[[0,-62],[16,-16],[62,0],[16,16],[0,62],[-16,16],[-62,0],[-16,-16]],p.accent,p.metalLight,8);
   shape(c,[[0,-28],[8,-8],[28,0],[8,8],[0,28],[-8,8],[-28,0],[-8,-8]],p.metalLight);
   c.restore();
   return;
  }
  // 等待：大钟面 + 走动指针
  if(state==='waiting'){
   badge(c,ox,oy,78,p.jacket,p.hairShadow);
   c.beginPath();c.arc(ox,oy,52,0,Math.PI*2);c.fillStyle=p.face;c.fill();c.strokeStyle=p.ink;c.lineWidth=10;c.stroke();
   for(var tick=0;tick<12;tick++){
    var ang=tick*Math.PI/6;c.strokeStyle=p.trim;c.lineWidth=6;c.beginPath();
    c.moveTo(ox+Math.cos(ang)*40,oy+Math.sin(ang)*40);c.lineTo(ox+Math.cos(ang)*48,oy+Math.sin(ang)*48);c.stroke();
   }
   var hand=wave*Math.PI;c.strokeStyle=p.accent;c.lineWidth=12;c.beginPath();c.moveTo(ox,oy);c.lineTo(ox+Math.cos(hand-Math.PI/2)*34,oy+Math.sin(hand-Math.PI/2)*34);c.stroke();
   c.strokeStyle=p.secondary;c.lineWidth=8;c.beginPath();c.moveTo(ox,oy);c.lineTo(ox+Math.cos(hand*2)*22,oy+Math.sin(hand*2)*22);c.stroke();
   c.fillStyle=p.ink;c.beginPath();c.arc(ox,oy,8,0,Math.PI*2);c.fill();
   return;
  }
  // 出错：大红感叹号；停止：暂停双竖条
  if(state==='error'||state==='stopped'){
   if(state==='error'){
    badge(c,ox,oy,78,p.error,p.ink);
    c.fillStyle=p.jacket;c.fillRect(ox-12,oy-48,24,62);c.beginPath();c.arc(ox,oy+36,14,0,Math.PI*2);c.fill();
   }else{
    badge(c,ox,oy,78,p.trim,p.ink);
    c.fillStyle=p.jacket;c.fillRect(ox-34,oy-42,22,84);c.fillRect(ox+12,oy-42,22,84);
   }
   return;
  }
  // 成功：大勾 + 四散星片
  if(state==='success'){
   badge(c,ox,oy,78,p.accent,p.ink);
   c.strokeStyle=p.ink;c.lineWidth=18;c.beginPath();c.moveTo(ox-34,oy);c.lineTo(ox-8,oy+28);c.lineTo(ox+40,oy-32);c.stroke();
   var colors=[p.hair,p.secondary,p.metalLight,p.error];
   for(var i=0;i<6;i++){
    var x=ox+Math.cos(i*1.1+wave)*70,y=oy+Math.sin(i*1.4+wave)*58;
    shape(c,[[x,y-14],[x+10,y],[x,y+14],[x-10,y]],colors[i%4],p.ink,4);
   }
  }
 }
 /** 只画头部与侧旁状态图标；工作状态改嘴/眨眼/图标，不画身体。 */
 function draw(c,skin,state,t){
  var m=settings.motion,pose=settings.poses[state],wave=Math.sin(t*Math.PI*2),p=settings.pivots,canvas=settings.canvas;
  c.clearRect(0,0,c.canvas.width,c.canvas.height);
  c.fillStyle='rgba(25,32,55,.11)';c.beginPath();c.ellipse(canvas.anchor[0],canvas.anchor[1]+1,28,4,0,0,Math.PI*2);c.fill();
  var bounce=wave*m.bounce,stretch=1+wave*m.breath;
  if(state==='success')bounce=-Math.pow(Math.sin(t*Math.PI),2)*m.successJump;
  if(state==='dragging')bounce=-m.dragLift+wave*1.5;
  if(state==='landing')stretch=1-Math.sin(t*Math.PI)*m.landingSquash;
  c.save();c.translate(canvas.anchor[0],canvas.anchor[1]+bounce);
  var scale=canvas.figureHeight/canvas.sourceHeight;c.scale(scale,scale*stretch);c.translate(-canvas.foot[0],-canvas.foot[1]);
  // 头部轻微侧倾仍读 pose[4]；其余关节角不再使用。
  c.save();rotate(c,p.head,pose[4]+wave*m.hairSwing);
  part(c,'hair-back');
  part(c,'face');
  var blink=Math.max(0,1-Math.abs(t-m.blinkCenter)/m.blinkHalfWidth);
  blink=blink*blink*(3-2*blink);
  // 出错时额外眯眼，其余状态只靠嘴形与图标区分。
  var eyeSquint=state==='error'?0.42:1;
  c.save();c.translate(p.eyes[0],p.eyes[1]);c.scale(1,(1-blink*.92)*eyeSquint);c.translate(-p.eyes[0],-p.eyes[1]);part(c,'eyes');c.restore();
  part(c,'hair-front');
  mouth(c,state,wave);
  c.restore();
  prop(c,state,wave);
  c.restore();
 }
 root.DesktopPetVector={prepare:prepare,draw:draw};
})(typeof window!=='undefined'?window:globalThis);

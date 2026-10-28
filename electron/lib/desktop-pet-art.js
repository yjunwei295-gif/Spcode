/* 内置皮肤矢量原稿，按状态和时间烘焙透明图集，品牌角色使用项目现有图标。 */
(function (root) {
  'use strict';
  /** 圆角部件统一描边；坐标均为 192 像素原稿空间。 */
  function box(c,x,y,w,h,r,fill,stroke) { c.beginPath();if(c.petAngular)c.rect(x,y,w,h);else c.roundRect(x,y,w,h,r);c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=2;c.stroke();} }
  /** 绘制椭圆部件。 */
  function oval(c,x,y,rx,ry,fill) { c.beginPath();if(c.petAngular&&!c.roundEyes){c.moveTo(x-rx,y);c.lineTo(x,y-ry);c.lineTo(x+rx,y);c.lineTo(x,y+ry);c.closePath();}else c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fillStyle=fill;c.fill(); }
  /** 圆端线条用于手脚和道具。 */
  function line(c,points,color,width) { c.beginPath();c.moveTo(points[0][0],points[0][1]);for(var i=1;i<points.length;i++)c.lineTo(points[i][0],points[i][1]);c.strokeStyle=color;c.lineWidth=width;c.lineCap=c.petAngular?'square':'round';c.lineJoin=c.petAngular?'miter':'round';c.stroke(); }
  /** 不同工作动作使用轮廓明确的道具，不仅依靠颜色区别。 */
  function prop(c,state,t,p) {
    var wave=Math.sin(t*Math.PI*2),ink=p.ink;
    if(state==='reading'){
      box(c,49,117,47,38,4,'#fff7de',ink);box(c,96,117,47,38,4,'#fff7de',ink);line(c,[[96,120],[96,151]],p.accent,3);
      for(var j=0;j<3;j++){line(c,[[57,126+j*8],[86,126+j*8]],'#a2ada8',2);line(c,[[105,126+j*8],[134,126+j*8]],'#a2ada8',2);}
    }
    if(state==='searching'){c.save();c.translate(135+wave*3,111);oval(c,0,0,18,18,'#e1f4ef');c.strokeStyle=ink;c.lineWidth=5;c.stroke();line(c,[[12,14],[29,34]],p.accent,9);c.restore();}
    if(['writing','running','testing','desktop'].indexOf(state)>=0){
      box(c,40,116,112,43,6,'#243a35',ink);box(c,45,120,102,31,3,'#d5f7e5');
      if(state==='writing'){line(c,[[62,129],[55,135],[62,141]],p.accent,3);line(c,[[129,129],[136,135],[129,141]],p.accent,3);line(c,[[103,126],[92,145]],p.accent,3);}
      if(state==='running'){line(c,[[55,127],[64,135],[55,143]],ink,3);line(c,[[73,143],[94+wave*4,143]],p.accent,3);}
      if(state==='testing'){for(var k=0;k<3;k++){line(c,[[55,126+k*9],[58,129+k*9],[63,123+k*9]],p.accent,2);line(c,[[71,126+k*9],[128,126+k*9]],'#7caf99',2);}}
      if(state==='desktop')line(c,[[86,125],[86,143],[91,138],[97,147]],ink,3);
      box(c,34,156,124,9,3,p.accent,ink);
    }
    if(state==='generating'){box(c,58,114,75,48,4,'#fff7e8',ink);line(c,[[62,156],[81,133],[98,146],[111,125],[129,157]],p.accent,4);oval(c,78,124,5,5,p.secondary);line(c,[[140,113],[132+wave*4,143]],'#bc8059',6);oval(c,140,109,5,9,p.accent);}
    if(['waiting','error','stopped','success'].indexOf(state)>=0){line(c,[[139,115],[139,154]],ink,4);box(c,117,86,44,38,8,state==='error'?'#fff0e9':'#fffdf3',ink);c.fillStyle=state==='error'?'#c65c4a':p.accent;c.font='bold 27px "Segoe UI"';c.textAlign='center';c.fillText(state==='waiting'?'?':(state==='success'?'✓':(state==='error'?'!':'Ⅱ')),139,115);}
    if(state==='thinking'){for(var d=0;d<3;d++)oval(c,142+d*11,41-Math.sin((t+d/4)*Math.PI*2)*3,3,3,p.accent);}
    if(state==='speaking'){box(c,128,25,47,27,9,'#fffdf2',ink);for(var s=0;s<3;s++)oval(c,140+s*11,38,2,2,p.accent);}
  }
  /** 低多边形猫娘的切面、猫耳与长发，霓虹轮廓由皮肤配色控制。 */
  function polygon(c,points,fill,stroke) {
    c.beginPath();c.moveTo(points[0][0],points[0][1]);for(var i=1;i<points.length;i++)c.lineTo(points[i][0],points[i][1]);c.closePath();c.fillStyle=fill;c.fill();
    if(stroke){c.strokeStyle=stroke;c.lineWidth=1.6;c.stroke();}
  }
  /**
   * 生成固定方向的材质明暗，渐变只在烘焙时计算，运行时仍播放同一张图集。
   * @param {CanvasRenderingContext2D} c 原稿画布上下文。
   * @param {number[]} axis 渐变起点与终点，使用原稿坐标。
   * @param {string[]} colors 从受光到背光的皮肤配色。
   * @returns {CanvasGradient} 供多边形填充使用的材质。
   */
  function material(c,axis,colors) {
    var fill=c.createLinearGradient(axis[0],axis[1],axis[2],axis[3]);
    for(var i=0;i<colors.length;i++)fill.addColorStop(i/(colors.length-1),colors[i]);
    return fill;
  }
  // 每种工作动作都有独立的 w 折线；中央尖点偏左、左右谷底高低不同，保留不规整的猫嘴神态。
  var mouths={
    idle:[[87,93],[91,98],[95,94],[101,97],[105,91]],
    thinking:[[88,94],[92,97],[97,93],[101,96],[104,92]],
    speaking:[[85,92],[90,98],[95,94],[102,97],[107,91]],
    reading:[[89,94],[92,97],[95,94],[100,96],[103,92]],
    searching:[[86,92],[90,97],[95,94],[102,96],[107,91]],
    writing:[[88,93],[92,98],[97,95],[101,97],[104,92]],
    running:[[87,92],[91,96],[95,92],[101,95],[106,90]],
    testing:[[86,94],[91,97],[95,93],[101,96],[106,92]],
    desktop:[[88,92],[91,98],[95,95],[101,97],[105,91]],
    generating:[[85,91],[90,98],[95,93],[102,97],[108,90]],
    waiting:[[87,94],[91,99],[95,95],[101,98],[105,92]],
    success:[[84,91],[90,99],[95,93],[102,98],[108,89]],
    error:[[88,95],[92,99],[95,96],[100,98],[104,94]],
    stopped:[[89,95],[92,98],[95,95],[100,97],[103,93]],
    dragging:[[86,91],[90,97],[95,92],[102,96],[106,90]],
    landing:[[85,94],[90,99],[95,95],[102,98],[107,92]]
  };
  /**
   * 绘制动作专属的锐利 w 猫嘴，说话时按当前动画相位开合。
   * @param {CanvasRenderingContext2D} c 原稿上下文。
   * @param {object} p 皮肤配色。
   * @param {string} state 已声明的工作动作。
   * @param {number} wave 当前帧的周期相位；只影响说话开合，不依赖实时时钟。
   */
  function mouth(c,p,state,wave) {
    var points=mouths[state];
    if(state==='speaking'){
      var depth=2+(wave+1)*2;
      polygon(c,[points[0],points[1],points[2],points[3],points[4],[102,99+depth],[96,101+depth],[90,99+depth]],p.hairShadow,p.secondary);
      polygon(c,[[89,95],[92,98],[91,95]],p.metalLight);
      polygon(c,[[100,95],[102,98],[103,95]],p.metalLight);
    }
    line(c,points,p.secondary,1.8);
  }
  /**
   * 绘制侧倾的几何猫娘，以连续斜线连接肩、腰、髋和错开的双腿。
   * @param {CanvasRenderingContext2D} c 192 像素原稿上下文。
   * @param {object} p 洋红、黑色为主的皮肤配色，绿色仅用于局部标记。
   * @param {number} wave 周期相位，只驱动手腕轻摆。
   * @param {string} state 工作动作，控制默认伸展、提起和庆祝的关节位置。
   * 头身直接共用原稿坐标，避免分别压扁头部、拉长身体造成比例断裂。
   */
  function cyberNeko(c,p,wave,state) {
    // 后发用朝右上方的大片剪影形成方向，不再左右镜像铺成圆形大头。
    polygon(c,[[82,48],[133,15],[167,9],[145,39],[176,29],[152,58],[165,53],[136,88],[147,67],[113,87]],p.hair);
    polygon(c,[[132,34],[160,17],[141,44],[155,38],[132,65],[146,55],[121,80]],p.hairShadow);
    polygon(c,[[130,30],[159,15],[144,32]],p.hairLight);
    polygon(c,[[137,72],[148,62],[136,86],[125,96]],p.accent);
    // 黑色内面与洋红外面沿同一关节走势排列，用实面体积代替双重描边细杆。
    cyberNekoLimb(c,p,[[92,133],[85,157],[80,177]],[13,8,5]);
    cyberNekoLimb(c,p,[[103,133],[115,153],[131,174]],[12,8,4]);
    polygon(c,[[77,175],[83,175],[85,182],[72,182]],p.hair);
    polygon(c,[[128,173],[133,173],[140,181],[128,180]],p.hair);
    polygon(c,[[78,171],[82,171],[81,176],[77,177]],p.accent);
    polygon(c,[[128,169],[131,172],[133,176],[129,174]],p.hairLight);
    // 肩线、腰线与髋线交错倾斜，腰部留出明确内收，保持同一个重心。
    polygon(c,[[85,76],[98,75],[102,87],[88,91]],p.face);
    polygon(c,[[81,85],[102,82],[111,95],[102,111],[98,121],[108,132],[103,140],[88,138],[84,129],[91,116],[85,104],[77,95]],p.hair);
    polygon(c,[[95,87],[102,85],[107,95],[97,113],[98,122],[101,130],[94,132],[91,121],[95,108],[88,100]],p.face);
    polygon(c,[[78,94],[84,88],[91,89],[85,96],[88,103]],p.hairLight);
    polygon(c,[[88,128],[94,125],[103,132],[99,136],[89,134]],p.hairShadow);
    polygon(c,[[88,123],[94,125],[90,129],[86,128]],p.accent);
    polygon(c,[[96,91],[101,89],[99,95]],p.secondary);
    // 默认姿态一臂低垂、一臂向外折伸；手臂轮廓与肩部切面相接。
    var leftArm=[[81,91],[66,108],[70,129]];
    var rightArm=[[105,90],[123,102],[119,126]];
    if(state==='idle'){
      leftArm=[[81,91],[64,104],[69,125+wave*.5]];
      rightArm=[[105,90],[138,80+wave*.4],[153,100+wave*.7]];
    }
    if(state==='dragging'){
      leftArm=[[81,91],[73,116],[76,139+wave]];
      rightArm=[[105,90],[113,116],[111,138-wave]];
    }
    if(state==='success'){
      leftArm=[[81,91],[65,77],[54,63]];
      rightArm=[[105,90],[127,72],[144,61]];
    }
    cyberNekoLimb(c,p,leftArm,[10,7,4]);
    cyberNekoLimb(c,p,rightArm,[10,7,4]);
    var leftHand=leftArm[2],rightHand=rightArm[2];
    polygon(c,[[leftHand[0]-3,leftHand[1]-2],[leftHand[0]+2,leftHand[1]-1],[leftHand[0]+4,leftHand[1]+5],[leftHand[0],leftHand[1]+8],[leftHand[0]-3,leftHand[1]+3]],p.hair);
    polygon(c,[[rightHand[0]-2,rightHand[1]-2],[rightHand[0]+3,rightHand[1]],[rightHand[0]+5,rightHand[1]+6],[rightHand[0]+1,rightHand[1]+8],[rightHand[0]-3,rightHand[1]+3]],p.hair);
    cyberNekoHead(c,p,wave,state);
  }
  /**
   * 以关节宽度绘制逐段收细的几何四肢，洋红为外侧受光面，黑色为内侧切面。
   * @param {CanvasRenderingContext2D} c 已进入身体坐标的上下文。
   * @param {object} p 与头部共用的皮肤配色。
   * @param {number[][]} points 按肩肘腕或髋膝踝排列的不同关节点。
   * @param {number[]} widths 各关节的完整宽度，单位为身体原稿像素。
   */
  function cyberNekoLimb(c,p,points,widths){
    for(var i=0;i<points.length-1;i++){
      var a=points[i],b=points[i+1],dx=b[0]-a[0],dy=b[1]-a[1];
      var length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length;
      var aw=widths[i]/2,bw=widths[i+1]/2;
      polygon(c,[[a[0]+nx*aw,a[1]+ny*aw],[b[0]+nx*bw,b[1]+ny*bw],[b[0]-nx*bw,b[1]-ny*bw],[a[0]-nx*aw,a[1]-ny*aw]],p.hair);
      polygon(c,[[a[0]+nx*aw*.15,a[1]+ny*aw*.15],[b[0],b[1]],[b[0]-nx*bw,b[1]-ny*bw],[a[0]-nx*aw,a[1]-ny*aw]],p.face);
      // 高光只占外缘一个窄面，保留大块深浅关系，缩小时仍读得到肢体。
      polygon(c,[[a[0]+nx*aw,a[1]+ny*aw],[b[0]+nx*bw,b[1]+ny*bw],[b[0]+nx*bw*.6,b[1]+ny*bw*.6],[a[0]+nx*aw*.6,a[1]+ny*aw*.6]],p.hairLight);
    }
  }
  /**
   * 绘制独立头部原稿，头身比例由调用方的画布变换决定。
   * @param {CanvasRenderingContext2D} c 已设置姿态变换的上下文。
   * @param {object} p 材质配色。
   * @param {number} wave 动画相位，用于眨眼与嘴部开合。
   * @param {string} state 动作名称，用于选取对应表情。
   */
  function cyberNekoHead(c,p,wave,state){
    var hair=material(c,[45,15,139,109],[p.hairLight,p.hair,p.hairShadow]);
    var face=material(c,[65,60,127,105],[p.faceEdge,p.face,p.face]);
    // 碎片发束和猫耳沿用原有造型，缩小头部后让腰身和腿部比例清楚可见。
    polygon(c,[[20,12],[66,19],[90,10],[113,19],[174,10],[159,40],[182,35],[163,68],[177,78],[144,99],[128,91],[113,109],[77,109],[61,93],[20,105],[35,76],[12,67],[34,42]],p.hair);
    polygon(c,[[29,26],[16,6],[59,20],[69,41]],p.hair,p.ink);
    polygon(c,[[123,29],[170,7],[155,52]],p.hair,p.ink);
    polygon(c,[[58,44],[57,29],[73,42]],p.accent,p.ink);polygon(c,[[122,42],[136,29],[137,44]],p.secondary,p.ink);
    // 下颌向中央单点收尖，去掉原本横向的方下巴。
    polygon(c,[[62,58],[95,44],[131,58],[129,83],[118,98],[96,110],[74,98],[63,83]],face,p.accent);
    line(c,[[67,84],[77,97],[96,107]],p.faceEdge,1);
    line(c,[[126,84],[116,97],[98,107]],p.secondary,0.8);
    polygon(c,[[52,51],[75,35],[117,35],[142,51],[125,72],[111,51],[98,75],[82,49],[65,72]],p.hair,p.ink);
    polygon(c,[[75,35],[98,43],[82,49],[65,72]],hair);
    polygon(c,[[117,35],[142,51],[125,72],[111,51]],hair);
    // 发束细高光与背光切面分开绘制，避免只有单色大块。
    polygon(c,[[24,15],[66,22],[54,27],[37,25]],p.hairLight);
    polygon(c,[[115,22],[164,14],[151,24],[132,31]],p.hairLight);
    polygon(c,[[25,72],[38,67],[27,95],[22,100]],p.hairShadow);
    line(c,[[74,38],[84,42],[70,62]],p.hairLight,1.2);
    line(c,[[116,39],[133,51],[127,63]],p.hairLight,1.2);
    line(c,[[38,30],[53,34],[59,39]],p.metalLight,1);
    polygon(c,[[145,29],[151,25],[153,29],[147,34]],p.secondary,p.ink);
    line(c,[[69,69],[90,65],[96,87],[66,90],[69,69]],p.accent,2);
    line(c,[[102,65],[126,70],[127,91],[99,87],[102,65]],p.accent,2);
    var blink=state==='idle'&&wave>.8;
    c.roundEyes=true; // 圆形只用于眼睛和瞳孔，符合用户最终造型口径。
    if(blink){line(c,[[71,78],[84,78]],p.secondary,2);line(c,[[108,78],[121,78]],p.secondary,2);}
    else{
      var iris=material(c,[79,67,79,87],[p.metalLight,p.secondary,p.faceEdge]);
      oval(c,79,77,8,10,iris);oval(c,114,77,8,10,iris);
      oval(c,79,77,5,7,p.ink);oval(c,114,77,5,7,p.ink);
      oval(c,78,75,2,3,p.metalLight);oval(c,113,75,2,3,p.metalLight);
      oval(c,82,81,1,1,p.secondary);oval(c,117,81,1,1,p.secondary);
    }
    c.roundEyes=false;
    mouth(c,p,state,wave);
    polygon(c,[[58,75],[63,83],[58,92],[53,83]],p.accent,p.ink);
    polygon(c,[[134,75],[139,83],[134,92],[129,83]],p.secondary,p.ink);
  }
  /**
   * 绘制撑头半躺和侧躺，以屈膝、支撑臂及水平躯干组成独立姿态，不旋转整张站姿。
   * @param {CanvasRenderingContext2D} c 192 像素原稿上下文。
   * @param {object} p 材质配色。
   * @param {number} wave 动画相位，驱动轻缓呼吸与脚尖摆动。
   * @param {string} state reclining 为撑头屈膝，lying 为伸腿侧躺。
   * 两种姿态保持在帧边界内，并在相同地面高度落下肘部和脚部。
   */
  function cyberNekoRest(c,p,wave,state){
    var armor=material(c,[73,133,155,171],[p.hairShadow,p.body,p.ink]);
    var jacket=material(c,[76,134,101,154],[p.hairLight,p.hair,p.hairShadow]);
    var bent=state==='reclining',breath=wave*.8;
    // 后发顺着地面铺开，留出脸部、收腰与腿部的负空间。
    polygon(c,[[29,132],[14,157],[22,174],[65,177],[90,168],[70,149]],p.hair,p.ink);
    polygon(c,[[20,165],[42,169],[76,165],[64,174],[27,173]],p.hairLight);
    // 一条腿屈起、另一条伸出，或两腿错开侧放；膝盖与脚踝各自定位。
    if(bent){
      polygon(c,[[108,149],[125,123],[138,124],[162,161],[160,176],[145,176],[127,146],[120,165]],armor,p.ink);
      polygon(c,[[110,153],[139,159],[169,164],[182,172],[180,182],[163,180],[136,178],[108,171]],armor,p.ink);
      line(c,[[123,148],[130,137],[150,167]],p.secondary,1.5);
    }else{
      polygon(c,[[110,146],[139,143],[166,153+breath],[179,160],[179,172],[160,171],[135,161],[110,161]],armor,p.ink);
      polygon(c,[[110,155],[140,158],[170,166],[183,174],[181,184],[162,182],[135,177],[107,172]],armor,p.ink);
      line(c,[[123,164],[140,168],[169,174]],p.accent,1.5);
    }
    // 肩胸、收腰、髋部在水平方向分开转折，躺下后仍能读出身形。
    polygon(c,[[76,132+breath],[92,134+breath],[104,146],[99,159],[78,155],[73,144]],jacket,p.ink);
    polygon(c,[[80,135+breath],[90,137+breath],[99,146],[94,150],[81,147]],p.hairLight);
    polygon(c,[[101,145],[111,147],[117,144],[125,152],[119,167],[107,169],[98,158]],armor,p.ink);
    polygon(c,[[99,145],[109,148],[106,159],[100,157],[96,151]],p.faceEdge,p.hairLight);
    polygon(c,[[128,147],[138,151],[135,163],[124,160]],p.hairShadow,p.hair);
    line(c,[[102,148],[100,156],[107,162]],p.metalLight,1);
    line(c,[[109,148],[106,157],[112,164]],p.accent,2);
    // 半躺用手撑头；侧躺将前臂平放地面，并把另一手搭在腰侧。
    var support=bent?[[77,144],[61,174],[48,143]]:[[77,145],[62,171],[40,173]];
    line(c,support,p.secondary,11);line(c,support,p.faceEdge,9);
    oval(c,support[2][0],support[2][1],5,5,p.faceEdge);
    line(c,[[86,140],[98,153],[112,155]],p.accent,10);
    line(c,[[86,140],[98,153],[112,155]],p.faceEdge,8);
    polygon(c,[[79,134],[87,136],[86,145],[77,143]],jacket,p.hairLight);
    oval(c,112,155,5,5,p.faceEdge);
    line(c,[[110,153],[114,155]],p.secondary,1);
    // 共用脸部原稿，单独倾斜头部，使视线朝向用户而不是随身体横转九十度。
    c.save();c.translate(bent?51:47,bent?124:133);c.rotate((bent?-.16:-.32)+wave*.015);c.scale(.55,.55);c.translate(-96,-65);
    cyberNekoHead(c,p,wave,state);c.restore();
  }
  /** 输入时间只来自帧序号，正弦缓动使运动自然并可重复烘焙。 */
  function draw(c,skin,state,t,icon){
    // 猫娘由独立矢量关节稿烘焙；其它皮肤仍沿用自己的绘制入口。
    if(skin.character==='cyber-neko'){root.DesktopPetVector.draw(c,skin,state,t);return;}
    c.petAngular=skin.character==='cyber-neko';c.roundEyes=false;
    var p=skin.colors,wave=Math.sin(t*Math.PI*2),ink=p.ink;
    var bounce=state==='success'?-Math.pow(Math.sin(t*Math.PI),2)*13:wave*1.7;
    if(state==='dragging')bounce=-12+wave*3;
    if(state==='landing')bounce=Math.sin(t*Math.PI)*6;
    c.clearRect(0,0,192,192);oval(c,96,181,49,6,'rgba(23,48,38,.12)');c.save();c.translate(0,bounce);
    if(skin.character==='cyber-neko'){
      cyberNeko(c,p,wave,state);
    }else if(skin.character==='cat'){
      c.save();c.translate(130,144);c.rotate(wave*.16);line(c,[[0,0],[28,-1],[37,-20],[30,-33]],p.body,14);line(c,[[0,0],[28,-1],[37,-20],[30,-33]],ink,2);c.restore();
      oval(c,96,137,38,35,p.body);oval(c,81,172,17,8,p.body);oval(c,115,172,17,8,p.body);
      c.beginPath();c.moveTo(49,66);c.lineTo(48,25);c.lineTo(77,48);c.lineTo(115,48);c.lineTo(144,25);c.lineTo(143,72);c.closePath();c.fillStyle=p.body;c.fill();c.strokeStyle=ink;c.lineWidth=2;c.stroke();
      c.beginPath();c.moveTo(55,53);c.lineTo(54,36);c.lineTo(69,49);c.closePath();c.fillStyle=p.secondary;c.fill();c.beginPath();c.moveTo(123,49);c.lineTo(138,36);c.lineTo(137,55);c.closePath();c.fill();
      oval(c,96,82,51,39,p.body);oval(c,96,96,27,16,'#fff6e8');oval(c,96,90,4,3,p.secondary);
      line(c,[[96,94],[91,99],[87,96]],ink,2);line(c,[[96,94],[101,99],[105,96]],ink,2);
      line(c,[[61,89],[39,85]],ink,1.5);line(c,[[61,96],[39,100]],ink,1.5);line(c,[[131,89],[153,85]],ink,1.5);line(c,[[131,96],[153,100]],ink,1.5);
      box(c,68,112,56,10,4,p.accent);oval(c,96,120,6,6,'#f5cd66');
    }else{
      line(c,[[96,39],[96,24]],ink,4);oval(c,96,20,7,7,p.accent);box(c,48,42,96,67,24,p.body,ink);box(c,56,51,80,46,17,'#e6fbef',ink);
      box(c,65,116,62,48,17,p.body,ink);oval(c,76,174,20,8,p.accent);oval(c,117,174,20,8,p.accent);box(c,81,124,30,30,8,'#fff',ink);
      if(icon)c.drawImage(icon,84,127,24,24);
      line(c,[[50,66],[41,66],[41,84],[49,84]],p.accent,7);line(c,[[143,66],[151,66],[151,84],[144,84]],p.accent,7);
    }
    var eyeY=skin.character==='cat'?77:73,blink=t>.81&&t<.93,eyeH=blink?1.4:(state==='error'?5:7);
    if(skin.character!=='cyber-neko'){oval(c,77,eyeY,4,eyeH,ink);oval(c,115,eyeY,4,eyeH,ink);}
    if(state==='speaking'&&skin.character==='robot')oval(c,96,88,5,3+wave*1.4,p.accent);
    // 猫娘的手臂随自身轮廓绘制；通用手臂只供猫咪和机器人使用。
    if(skin.character!=='cyber-neko'){
      if(state==='success'){line(c,[[61,131],[48,111],[43,96]],p.body,12);line(c,[[131,131],[148,112],[155,96]],p.body,12);}
      else if(state==='dragging'){line(c,[[65,133],[55,148+wave*3]],p.body,11);line(c,[[128,133],[138,148-wave*3]],p.body,11);}
      else{oval(c,59,134+wave*1.2,10,13,p.body);oval(c,135,134-wave*1.2,10,13,p.body);}
    }
    prop(c,state,t,p);c.restore();
  }
  root.DesktopPetArt={draw:draw};
})(typeof window!=='undefined'?window:globalThis);

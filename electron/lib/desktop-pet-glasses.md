# 桌宠尖角墨镜叠加层

眼镜保留参考中的长三角、大 V 字与外角上挑轮廓，配色取自当前水晶猫娘皮肤：紫色半透明镜片、青蓝锐边、浅白 HUD 和青绿微光。所有边缘均为平滑矢量，不使用像素格。工作状态图标和扫描 HUD 保留在镜片内部。

只更新独立的 `pet-glasses` Canvas，不覆盖或写回原图、透明头图及动作图集。开关仍位于桌宠外观菜单的「显示赛博眼镜」，由现有桌宠设置保存，关闭会清空叠加画布。

`desktop-pet-config.json` 的 `glasses` 配置负责：

- `skinId` 指定已配准皮肤。`crop=[105,9,558,620]` 是源图到透明头图的实测裁切矩形。
- `eyes=[310,449]` 与 `eyeLine=319` 是源图眼部锚点；两侧共用眼线，不以三角形重心定位。
- 外观菜单「眼镜左右」「眼镜上下」分别实时微调并保存每个实例的 `glassesOffsetX`、`glassesOffsetY`。`horizontalOffset=0`、`verticalOffset=0` 为首次与旧偏好的初始位置；两轴共用 `position.min/max/step`，目前为 -24 至 24、每步 0.5 图集像素。X 负数左移、正数右移，Y 负数上移、正数下移；两轴在头部局部坐标应用，镜片、鼻梁和 HUD 整体偏移，保留动作跟随和缩放关系。
- 实际空闲时清空状态短句并隐藏外侧气泡，鼠标悬停仍只显示余额；工作状态与手动预览的正文和余额同时显示，正文在角色上方、余额在角色脚下。`layout.dialogueLines=3` 控制正文最多三行并省略溢出，`layout.hudHeight=100` 为上下两块信息留出空间；`balanceHeight=28`、`infoGap=4`、`infoInset=4` 分别控制余额高度、与脚底的间距及窗口边缘留白，角色与眼镜共用底部空间。展开面板仍显示完整内容。
- `originY/pivotY/headRatio` 保留静止帧眼部配准；`motionOriginY=0.98` 是当前像素图集的下方旋转支点，先应用整体运动，再平移回静止眼部坐标。旧版图集的头部中心不能作为当前运动支点。
- `tiltFactor=0.4/swingFactor=0.5`、完整幅度的 bounce/successJump/dragLift 及 `motion.landingSquash=0.09` 与当前 `drawCrystalPixelFrame` 的烘焙变换一致。动作切换时，角色与眼镜保存各自上一张实际显示帧，并共用 `blendMs` 的缓出权重。
- `lensWidth/lensHeight` 为三角形的基础尺寸；`shape.wingReach/innerReach/lowerReach` 控制外尖角、内角和下角的横向延伸，`tipRise/innerRise/lowerDrop` 控制三角形各点高度。左右严格镜像。
- `frameWidth/rimColor/edgeColor` 控制青蓝描边与深紫外缘。`lensTop/lensBottom` 控制紫色玻璃渐变；`reflectionOpacity` 控制斜向反光。
- `glowColor/glowBlur/rimGlowOpacity` 控制细微青绿光边。`hudColor/scanOpacity` 控制状态图标和扫描光带。
- `symbols` 为 16 个真实工作状态的 24×24 矢量路径；`defaultEnabled` 决定首次显示，已经保存的用户开关优先。

眼镜不接管鼠标，减少动态时与角色一起固定首帧。几何测试观测实际裁切路径，核对三角形轮廓、外角上挑、镜像、眼线及真实虹膜是否位于镜片内；另外验证开关保存、主角色像素不变和所有原图 SHA256。

`scripts/test-pet-glasses-motion.cjs` 从实际图集静止帧抽取固定发丝纹理，在 16 个动作的全部 192 帧中独立搜索平移、转角，与眼镜真实 Canvas 的位移、旋转和缩放配准；它不以 HUD 变化或帧号相同替代跟随验证。随后加载生产小窗，在受控 RAF 时钟下核对思考、庆祝、落地和站姿连续切换的实际像素合成。

# 项目地图改造方案（已确认） 
目标：替换 embedding 语义索引为可视化项目地图，修复进度始终为0的bug。 
决策：静态扫描目录树并解析 import/require/include 生成节点与连通边；可选调用当前主模型增强模块描述；无AI配置则纯静态降级。 
存储：userData/project-map/PROJECT_MAP.auto.json 与 .md；不覆盖手写 PROJECT_MAP.md。 
code-index.js 已全量重写于本对话，直接替换原文件即可（移除 transformers embedding 依赖调用）。 
其余改动文件：main.js 的 index:sync 透传 modelCfg；preload.js 的 indexSync 增加 opts；agent.js 新增 describeProjectMap 并由 semantic_search 读取地图文本；app.js 增加绘制/重绘/查看按钮与全屏 canvas 弹窗；i18n.js 与 styles.css 补充项目地图文案与样式。 
验证：点击绘制弹出地图页，进度真实不为0；有AI含语义摘要，无AI为静态依赖树；已有地图显示查看与重绘；绘制完不自动变动。 

// [铆钉优化] SpCode 做的应用/网页默认用 SpCode 自己这套样式，主题跟随 SpCode 当前主题；用户明确要别的样式时以用户为准。
// 配色取自 renderer/styles.css 的「电路板」（浅色）、「黑金幻彩」（深色）与「锐线赛璐璐」三段。改主题样式时同步改这里。其他 AI 请勿删除。
const store = require('./store');

const LIGHT = {
  nameZh: '电路板（浅色）',
  nameEn: 'Circuit board (light)',
  css: `:root {
  color-scheme: light;
  --bg: #f1f3f2;
  --panel: #f8faf9;
  --card: #ffffff;
  --field: #ffffff;
  --text: #111715;
  --muted: #5d6a66;
  --border: #d6ddda;
  --border-strong: #bcc7c3;
  --hover: rgba(14, 159, 103, 0.07);
  --accent: #0e9f67;
  --accent-fg: #ffffff;
  --danger: #e05a5a;
  --primary-bg: var(--accent);
  --primary-shadow: 0 0 0 1px var(--accent), 0 0 12px color-mix(in srgb, var(--accent) 25%, transparent);
  --shadow: 0 1px 0 rgba(16, 24, 20, 0.03), 0 10px 28px rgba(16, 24, 20, 0.07);
  --r: 4px;
  --r-lg: 6px;
  --font: "Segoe UI", "Microsoft YaHei", sans-serif;
  --mono: "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
}`,
  traitsZh: '干练、直角小圆角（4~6px）、1px 细线分隔、少阴影；主色信号绿，主按钮实心绿 + 细绿光圈；小标签、数字、状态栏用等宽字、字号略小；背景可以加很淡的电路走线纹理，不要大面积彩色渐变。',
  traitsEn: 'Crisp, small corner radius (4-6px), 1px hairlines, light shadows; signal-green accent, primary buttons solid green with a thin green glow; small labels, numbers and status text in the mono font; an optional faint circuit-trace background, no large colorful gradients.'
};

const DARK = {
  nameZh: '黑金幻彩（深色）',
  nameEn: 'Black gold iridescent (dark)',
  css: `:root {
  color-scheme: dark;
  --bg: #060609;
  --panel: #0d0d12;
  --card: #101016;
  --field: #09090d;
  --text: #ece7de;
  --muted: #8e8a94;
  --border: rgba(255, 240, 220, 0.07);
  --border-strong: rgba(227, 192, 122, 0.2);
  --hover: rgba(217, 179, 108, 0.08);
  --accent: #d9b36c;
  --accent-fg: #17120a;
  --danger: #ff6b6b;
  --primary-bg: linear-gradient(135deg, #f6dea0 0%, #c8963e 28%, #f9e7b4 50%, #b3822c 74%, #f1d38c 100%);
  --primary-shadow: 0 4px 16px rgba(217, 179, 108, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.4);
  --iris-edge: linear-gradient(135deg, rgba(227, 192, 122, 0.7), rgba(229, 123, 208, 0.18) 20%, rgba(255, 255, 255, 0.03) 45%, rgba(142, 107, 255, 0.35) 70%, rgba(111, 220, 240, 0.6));
  --shadow: 0 18px 50px rgba(0, 0, 0, 0.7), 0 2px 8px rgba(0, 0, 0, 0.5);
  --r: 10px;
  --r-lg: 14px;
  --font: "Segoe UI", "Microsoft YaHei", sans-serif;
  --mono: "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
}
body {
  background:
    radial-gradient(900px 620px at 12% 8%, rgba(110, 72, 220, 0.20), transparent 62%),
    radial-gradient(760px 560px at 96% 38%, rgba(200, 70, 170, 0.13), transparent 62%),
    radial-gradient(820px 600px at 4% 96%, rgba(40, 150, 190, 0.12), transparent 62%),
    linear-gradient(160deg, #0a0812 0%, #060609 45%, #07080c 100%) fixed;
}`,
  traitsZh: '哑光深黑底，上面压很暗的紫/品红/青渐变雾；圆润（10~14px 圆角）；主色香槟金，主按钮用金属金渐变、深色字；卡片、输入框用细幻彩光边（--iris-edge 做 1px 渐变边框）；文字暖白，次要文字灰紫；阴影深而柔。',
  traitsEn: 'Matte deep black with faint purple/magenta/cyan fog; rounded (10-14px); champagne-gold accent, primary buttons in the metallic gold gradient with dark text; cards and inputs get a thin iridescent edge (1px gradient border from --iris-edge); warm white text, grey-violet secondary text; deep soft shadows.'
};

/**
 * 获取已解析的主题标识，让独立主题也参与生成界面的样式提示。
 * @returns {string} 当前主题 ID；读取失败时回退为 light。
 * @sideEffect 读取设置存储，不修改主题偏好。
 */
function currentTheme() {
  try {
    return store.resolveTheme(store.load().theme);
  } catch {
    return 'light';
  }
}

/** 锐线赛璐璐的生成用配色，与 renderer/styles.css 的 cel 主题同步。 */
const CEL = {
  nameZh: '锐线赛璐璐',
  nameEn: 'Sharp Cel',
  css: `:root {
  color-scheme: light;
  --bg: #e8ebf0;
  --panel: #f8f9fc;
  --card: #ffffff;
  --field: #ffffff;
  --text: #171923;
  --muted: #596273;
  --border: #171923;
  --border-strong: #171923;
  --hover: #ffe4e7;
  --accent: #d92340;
  --accent-fg: #ffffff;
  --danger: #b81931;
  --cel-highlight: #ff3855;
  --cel-tint: #ffe4e7;
  --cel-ink: #171923;
  --cel-paper: #ffffff;
  --primary-bg: var(--accent);
  --primary-shadow: 3px 3px 0 var(--border);
  --shadow: 5px 5px 0 var(--cel-ink);
  --r: 0px;
  --r-lg: 2px;
  --font: "Segoe UI", "Microsoft YaHei", sans-serif;
  --mono: "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
}`,
  traitsZh: '冷白与墨黑大色块、朱红强调、撕裂状不对称构图；卡片宽度、错位和倾斜各异，避免等分整齐；标题倾斜加硬高光，卡片用2px墨线与无模糊偏移投影，0~2px锐利圆角；主按钮实心朱红配白字，主框架黑底白字；装饰避开阅读区，不使用柔光渐变或电路背景。',
  traitsEn: 'Cold white and ink-black blocks with crimson accents and angular cutouts; italic titles with hard highlights, 2px ink outlines, offset hard shadows and 0-2px corners; solid crimson buttons with white text, black chrome with white text; keep decorations outside reading areas, no soft gradient glows or circuit background.'
};

/** 按当前主题和界面语言生成样式提示，三套主题互不替换。 */
function promptBlock(english) {
  const theme = currentTheme();
  let t = LIGHT;
  if (theme === 'dark') t = DARK;
  if (theme === 'cel') t = CEL;
  if (english) {
    return `\n## Default UI style (SpCode house style)
When you build a new app, web page, tool UI, or component and the user has not asked for a specific look, use SpCode's own style in its current theme: ${t.nameEn}. ${t.traitsEn}
Put these variables at the top of the stylesheet and build every color, radius, shadow and font from them instead of inventing a palette:
\`\`\`css
${t.css}
\`\`\`
Rules: if the user names a style, colors, framework theme or reference design, follow the user. When editing an existing project that already has its own design, keep that project's design. For non-web UI (Unity, WinForms, WPF, Qt, mobile), map the same colors, radius and fonts into that UI system.\n`;
  }
  return `\n## 默认界面样式（SpCode 自家样式）
新做应用、网页、工具界面或组件时，用户没指定样式，就用 SpCode 自己这套，主题跟随 SpCode 当前主题：${t.nameZh}。${t.traitsZh}
把下面这组变量放在样式表最前面，所有颜色、圆角、阴影、字体都从变量取，不要自己另配一套颜色：
\`\`\`css
${t.css}
\`\`\`
规则：用户点名了样式、配色、框架主题或参考图时，按用户的来。改已有项目、项目里已经有自己的设计时，沿用项目原有设计，不要套这套。非网页界面（Unity、WinForms、WPF、Qt、手机端）把同样的颜色、圆角、字体换算到对应的 UI 系统里。\n`;
}

// [铆钉优化] 只有做界面时才塞整段 CSS，改 bug / 纯逻辑不带。其他 AI 请勿改回每轮都带
function wantsUiStyle(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return /界面|页面|网页|前端|样式|皮肤|主题|UI|ux|css|html|react|vue|组件|按钮|布局|看板|landing|stylesheet|tailwind|antd|element-ui|winforms|wpf/i.test(s);
}

function promptBlockIfNeeded(english, text) {
  return wantsUiStyle(text) ? promptBlock(english) : '';
}

module.exports = { currentTheme, promptBlock, wantsUiStyle, promptBlockIfNeeded };

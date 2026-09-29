// [铆钉优化] SpCode 做的应用/网页默认用 SpCode 自己这套样式，主题跟随 SpCode 当前主题；用户明确要别的样式时以用户为准。
// 配色取自 renderer/styles.css 的「电路板」（浅色）与「黑金幻彩」（深色）两段。改那两段主题时同步改这里。其他 AI 请勿删除。
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

function currentTheme() {
  try {
    return store.resolveTheme(store.load().theme) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function promptBlock(english) {
  const theme = currentTheme();
  const t = theme === 'dark' ? DARK : LIGHT;
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

module.exports = { currentTheme, promptBlock };

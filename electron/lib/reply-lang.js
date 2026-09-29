// 回复语言：默认跟界面 locale；对话里指定语言则覆盖软件设置。

const LANGS = [
  { code: 'zh', zh: '中文', en: 'Chinese', names: ['中文', '汉语', '漢語', '简体中文', '簡體中文', 'chinese', 'simplified chinese'] },
  { code: 'zh-Hant', zh: '繁体中文', en: 'Traditional Chinese', names: ['繁体中文', '繁體中文', '繁体', '繁體', 'traditional chinese'] },
  { code: 'en', zh: '英语', en: 'English', names: ['英文', '英语', '英語', 'english'] },
  { code: 'ja', zh: '日语', en: 'Japanese', names: ['日文', '日语', '日本語', 'japanese'] },
  { code: 'ko', zh: '韩语', en: 'Korean', names: ['韩文', '韩语', '韓語', '한국어', 'korean'] },
  { code: 'fr', zh: '法语', en: 'French', names: ['法文', '法语', '法語', 'french'] },
  { code: 'de', zh: '德语', en: 'German', names: ['德文', '德语', '德語', 'german'] },
  { code: 'es', zh: '西班牙语', en: 'Spanish', names: ['西班牙文', '西班牙语', '西班牙語', 'spanish'] },
  { code: 'ru', zh: '俄语', en: 'Russian', names: ['俄文', '俄语', '俄語', 'russian'] },
  { code: 'pt', zh: '葡萄牙语', en: 'Portuguese', names: ['葡萄牙文', '葡萄牙语', 'portuguese'] },
  { code: 'it', zh: '意大利语', en: 'Italian', names: ['意大利文', '意大利语', 'italian'] },
  { code: 'vi', zh: '越南语', en: 'Vietnamese', names: ['越南文', '越南语', 'vietnamese'] },
  { code: 'th', zh: '泰语', en: 'Thai', names: ['泰文', '泰语', 'thai'] },
  { code: 'ar', zh: '阿拉伯语', en: 'Arabic', names: ['阿拉伯文', '阿拉伯语', 'arabic'] }
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fromCode(code, source) {
  const hit = LANGS.find((x) => x.code === code) || LANGS[0];
  return { code: hit.code, zh: hit.zh, en: hit.en, source: source || 'ui' };
}

function fromLocale(locale) {
  return fromCode(locale === 'en' ? 'en' : 'zh', 'ui');
}

function matchOne(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const lang of LANGS) {
    const names = lang.names.slice().sort((a, b) => b.length - a.length);
    for (const n of names) {
      const q = escapeRe(n);
      const zhAsk = new RegExp(`(?:请)?(?:用|改用|换成|換用|切换到|切換到)\\s*${q}\\s*(?:来|來)?(?:回答|回复|回覆|说|寫|写|交流)?`, 'i');
      const enAsk = new RegExp(`(?:reply|respond|answer|speak|write|talk)\\s+in\\s+${q}\\b`, 'i');
      const useAsk = new RegExp(`\\b(?:use|switch to)\\s+${q}\\b`, 'i');
      if (zhAsk.test(s) || enAsk.test(s) || useAsk.test(s)) return fromCode(lang.code, 'chat');
    }
  }
  return null;
}

function userBlobs(userText, history) {
  const out = [];
  for (const m of history || []) {
    if (m.role !== 'user') continue;
    out.push(typeof m.content === 'string' ? m.content : (m.text || ''));
  }
  if (userText) out.push(String(userText));
  return out;
}

/**
 * 解析本轮回复语言：对话指定优先于界面语言。
 * @param {{ locale?: string, userText?: string, history?: object[] }} opts
 */
function resolve(opts = {}) {
  const blobs = userBlobs(opts.userText, opts.history);
  for (let i = blobs.length - 1; i >= 0; i -= 1) {
    const hit = matchOne(blobs[i]);
    if (hit) return hit;
  }
  return fromLocale(opts.locale);
}

/** 主模型系统提示里的语言指令（覆盖规则/人设里写死的中文） */
function systemLangLine(lang) {
  if (lang.source === 'chat') {
    return `The user specified the reply language as ${lang.en} (${lang.zh}). Ignore the software UI language. Reply entirely in ${lang.en}. 用户指定用${lang.zh}回答，无视软件语言设置。`;
  }
  if (lang.code === 'en') {
    return 'You are SimpleCode, a desktop AI coding assistant. Follow the software language setting: reply in English.';
  }
  return '你是 SimpleCode，桌面端 AI 编程助手。按软件语言设置用中文回复。';
}

function helperLangLine(lang) {
  if (lang.source === 'chat') {
    return `Reply in ${lang.en}. Ignore the software UI language. 用${lang.zh}回答。`;
  }
  if (lang.code === 'en') return 'Reply in English.';
  return '用中文回答。';
}

function visionAsk(lang) {
  const tail = lang.source === 'chat' || lang.code !== 'zh'
    ? `Write the description in ${lang.en}. Ignore the app UI language.`
    : '用中文描述画面。';
  return `Identify this image. Extract any visible text exactly as written. Briefly describe the scene. ${tail}`;
}

/** 规则/人设里写死「必须中文」时，避免盖过本轮语言指令 */
function softenForcedChinese(text) {
  return String(text || '')
    .replace(/默认用中文回复；除非用户明确要求其他语言。/g, '')
    .replace(/用中文回复用户[。.]?/g, '')
    .replace(/注释和界面文案用中文；/g, '注释和界面文案跟回复语言走；');
}

function promptInEnglish(lang) {
  return lang.code !== 'zh' && lang.code !== 'zh-Hant';
}

module.exports = {
  resolve, fromLocale, systemLangLine, helperLangLine, visionAsk,
  softenForcedChinese, promptInEnglish
};

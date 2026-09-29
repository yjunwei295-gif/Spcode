/*
  聊天气泡专用的极小 markdown 渲染器。

  两条硬约束：

  1. 输入是模型输出，**一律先 escape 再套格式**。任何时候都不能把原文直接交给
     innerHTML。所有分支都走 esc()，链接只放行 http/https/mailto。

  2. 这是编程工具，满屏都是 snake_case 和 *.ps1 之类的东西，所以**不支持 _斜体_**
     —— 否则 MAIN_STORY_001.story.json 会被中间那段切成斜体。单星号斜体也加了
     两侧不能贴单词的边界。宁可少认几种写法，不要把路径和代码改坏。

  没引现成库：package.json 里没有 markdown 依赖，为一个聊天气泡加一个包、
  再连带考虑离线安装，不值。
*/

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

// 行内规则。传进来的必须是**已经 escape 过**的文本。
function inline(text) {
  // 先把行内代码抽成占位符，免得里面的 * 和 [] 被后面的规则改掉
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    // 只认这三种协议。javascript: data: 一律原样留着当普通文字
    if (!/^(https?:|mailto:)/i.test(url)) return whole;
    return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });

  s = s.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '<del>$1</del>');
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '<em>$1</em>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const RE_FENCE = /^\s*```/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^\s*>/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+[.)]\s+/;
const RE_HR = /^\s*([-*_])[ \t]*(\1[ \t]*){2,}$/;
const RE_TR = /^\s*\|.*\|/;
const RE_TSEP = /^\s*\|?[\s:|-]*-[\s:|-]*$/;

function isBlockStart(l) {
  return RE_FENCE.test(l) || RE_HEAD.test(l) || RE_QUOTE.test(l)
    || RE_UL.test(l) || RE_OL.test(l) || RE_HR.test(l) || RE_TR.test(l);
}

function cells(l) {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// [铆钉优化] 同一段文字渲染结果缓存起来，重画对话时不必把每条消息的 Markdown 重算一遍。其他 AI 请勿去掉缓存
const MD_CACHE_MAX = 400;
const mdCache = new Map();
export function renderMarkdown(src) {
  const key = String(src ?? '');
  const hit = mdCache.get(key);
  if (hit !== undefined) {
    mdCache.delete(key);
    mdCache.set(key, hit);
    return hit;
  }
  const html = renderMarkdownRaw(key);
  mdCache.set(key, html);
  if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
  return html;
}

function renderMarkdownRaw(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块。流式输出时收尾的 ``` 往往还没到，所以没闭合也照样当代码块画，
    // 不然每次回答的中途都会闪一屏原始 markdown
    const fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      const cls = fence[1] ? ` class="lang-${esc(fence[1])}"` : '';
      out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }

    const head = RE_HEAD.exec(line);
    if (head) {
      const n = head[1].length;
      out.push(`<h${n}>${inline(esc(head[2]))}</h${n}>`);
      i++;
      continue;
    }

    if (RE_TR.test(line) && i + 1 < lines.length && RE_TSEP.test(lines[i + 1])) {
      const th = cells(line).map((c) => `<th>${inline(esc(c))}</th>`).join('');
      i += 2;
      const rows = [];
      while (i < lines.length && RE_TR.test(lines[i])) {
        rows.push(`<tr>${cells(lines[i++]).map((c) => `<td>${inline(esc(c))}</td>`).join('')}</tr>`);
      }
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(esc(body.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = !RE_UL.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && (ordered ? RE_OL : RE_UL).test(lines[i])) {
        const text = lines[i++].replace(ordered ? RE_OL : RE_UL, '');
        items.push(`<li>${inline(esc(text))}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // 段落。单个换行按 <br> 保留——聊天里换行几乎总是有意的，
    // 按 markdown 原义合并成一行反而更难读
    const body = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) body.push(lines[i++]);
    out.push(`<p>${inline(esc(body.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }

  return out.join('');
}

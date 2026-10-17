/*
  悬浮小窗（electron/lib/float-bar.html）专用的极小 Markdown 渲染器。

  为什么单独一份：小窗是 file:// 直接加载的独立页面，加载不了主窗的 ES module
  （renderer/markdown.js），所以这里用普通脚本（不是 ES module、不写 import/export）
  复制同一套逻辑，行为以 renderer/markdown.js 为准，末尾挂 window.FloatBarMd。

  三条硬约束：

  1. 输入是模型输出，一律先 escape 再套格式。块级内容在拼进 HTML 前逐段 esc()，
     行内规则只跑在 esc() 过的文本上；任何时候都不把原文直接交给 innerHTML。
     链接只放行 http/https/mailto，javascript:、data: 一律原样留成普通文字，不生成 <a>。

  2. 这是编程工具，满屏都是 snake_case 和 *.ps1 之类的东西，所以不支持 _斜体_
     —— 否则 MAIN_STORY_001.story.json 会被中间那段切成斜体。单星号斜体加了边界：
     两侧不贴单词字符也不贴星号。

  3. 不引现成库、不引 CDN、不联网：小窗是离线 Electron 页面，
     为一个消息气泡加一个包不值。

  比主窗多两样小窗里更需要的：
  - 裸 http(s) 链接自动成链（AI 常直接甩地址）；
  - 无序/有序列表支持缩进嵌套（用显式栈搭，不递归）。

  渲染结果按原文缓存：流式输出每帧都会整份重画消息区，命中缓存就不必重算整段。

  代码风格：具名函数 + 显式 for 循环，不用箭头函数、不用链式回调，宁可长也要直白。
*/

(function () {
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // HTML 转义：& < > " ' 全换成实体。只查单个字符，所以不会被 Object 原型的属性名带偏
  function esc(s) {
    var text = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var rep = ESC_MAP[ch];
      if (rep === undefined) out += ch;
      else out += rep;
    }
    return out;
  }

  // ---------- 占位符 ----------
  // 已经生成好的 <code> / <a> 片段先换成占位符藏进 stash，免得后面的粗体、斜体、
  // 裸链接规则把里面的字符改坏。占位符用输入里绝不会出现的控制字符包住序号。

  function stashMark(index) {
    return '\u0000' + index + '\u0001';
  }

  function putStash(stash, html) {
    stash.push(html);
    return stashMark(stash.length - 1);
  }

  // 收尾：把占位符原样换回片段
  function unstash(text, stash) {
    var out = '';
    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch !== '\u0000') {
        out += ch;
        i++;
        continue;
      }
      var end = text.indexOf('\u0001', i + 1);
      if (end < 0) {
        // 没有收尾标记（理论上不会发生）：剩下的原样带出去，绝不吞字
        out += text.slice(i);
        break;
      }
      var num = Number(text.slice(i + 1, end));
      if (isFinite(num) && num >= 0 && num < stash.length) out += stash[num];
      else out += text.slice(i, end + 1);
      i = end + 1;
    }
    return out;
  }

  var RE_SAFE_URL = /^(https?:|mailto:)/i;

  // 每个 <a> 都补 rel 与 target：小窗是 Electron 页面，链接只当外链看
  function anchorHtml(url, label) {
    return '<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + label + '</a>';
  }

  // ---------- 行内规则 ----------

  // 行内代码 `x`：内容（已转义）原样包进 <code> 并换成占位符
  function stashInlineCode(text, stash) {
    var re = /`([^`\n]+)`/g;
    var out = '';
    var last = 0;
    var m = re.exec(text);
    while (m !== null) {
      out += text.slice(last, m.index);
      out += putStash(stash, '<code>' + m[1] + '</code>');
      last = m.index + m[0].length;
      m = re.exec(text);
    }
    out += text.slice(last);
    return out;
  }

  // [文字](地址)：只认 http/https/mailto，其它协议原样留成普通文字（不生成 <a>）。
  // 标签文字用的就是转义后的原文，不再二次解析
  function stashExplicitLinks(text, stash) {
    var re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    var out = '';
    var last = 0;
    var m = re.exec(text);
    while (m !== null) {
      out += text.slice(last, m.index);
      if (RE_SAFE_URL.test(m[2])) out += putStash(stash, anchorHtml(m[2], m[1]));
      else out += m[0];
      last = m.index + m[0].length;
      m = re.exec(text);
    }
    out += text.slice(last);
    return out;
  }

  // 链接尾巴上黏着的半角标点：句末的句号、逗号不该算进地址。
  // 分号故意不进这个集合 —— 转义后的 &amp; 以分号收尾，切掉就把实体切坏了。
  // 中文全角标点不用在这里管：它们整个被下面正则的字符类挡在地址之外
  function isUrlTailPunct(ch) {
    return ch === '.' || ch === ',' || ch === ':' || ch === '!' || ch === '?';
  }

  function countChar(text, ch) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === ch) n++;
    }
    return n;
  }

  // 把地址切成「真正的地址」和「还回去的尾巴」
  function splitUrlTail(url) {
    var cut = url.length;
    while (cut > 0) {
      var ch = url.charAt(cut - 1);
      if (isUrlTailPunct(ch)) {
        cut--;
        continue;
      }
      if (ch === ')') {
        // 右括号只有在左边括号没配平时才算多余的，别切坏带括号的地址
        var head = url.slice(0, cut);
        if (countChar(head, '(') < countChar(head, ')')) {
          cut--;
          continue;
        }
      }
      break;
    }
    return { url: url.slice(0, cut), tail: url.slice(cut) };
  }

  // 裸链接：http:// https:// 开头的整段自动成链，标签就用地址本身。
  // 已转义文本里不会有裸露的 < > " ，只会出现 &amp; 这种实体，所以字符类放行 &amp;、挡住其它 & 开头的实体。
  // 另外三样也挡在地址外，免得把正文吃进链接里：
  //   - 全角标点与全角字符（\u3000-\u303f、\uff00-\uffef）：中文正文的句读不该算地址
  //   - 星号：那是 markdown 强调符
  // 地址里真实的中文、下划线、百分号编码都不受影响，照旧整个成链
  function stashBareLinks(text, stash) {
    var re = /https?:\/\/(?:&amp;|[^\s<>&"`*\u0000\u0001\u3000-\u303f\uff00-\uffef])+/gi;
    var out = '';
    var last = 0;
    var m = re.exec(text);
    while (m !== null) {
      var parts = splitUrlTail(m[0]);
      out += text.slice(last, m.index);
      if (parts.url) out += putStash(stash, anchorHtml(parts.url, parts.url));
      else out += m[0];
      out += parts.tail;
      last = m.index + m[0].length;
      m = re.exec(text);
    }
    out += text.slice(last);
    return out;
  }

  // 三段的边界和 renderer/markdown.js 完全一致，只是把替换写成具名函数，不用箭头函数
  function wrapStrong(whole, inner) {
    return '<strong>' + inner + '</strong>';
  }

  function wrapDel(whole, inner) {
    return '<del>' + inner + '</del>';
  }

  function wrapEm(whole, inner) {
    return '<em>' + inner + '</em>';
  }

  function applyEmphasis(text) {
    var s = text.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, wrapStrong);
    s = s.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, wrapDel);
    s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, wrapEm);
    return s;
  }

  // 行内总入口。传进来的必须是**已经 escape 过**的文本
  function inline(text) {
    var stash = [];
    var s = stashInlineCode(text, stash);
    s = stashExplicitLinks(s, stash);
    s = stashBareLinks(s, stash);
    s = applyEmphasis(s);
    return unstash(s, stash);
  }

  // ---------- 块级规则 ----------

  var RE_FENCE = /^\s*```/;
  var RE_HEAD = /^(#{1,6})\s+(.*)$/;
  var RE_QUOTE = /^\s*>/;
  var RE_UL = /^\s*[-*+]\s+/;
  var RE_OL = /^\s*\d+[.)]\s+/;
  var RE_HR = /^\s*([-*_])[ \t]*(\1[ \t]*){2,}$/;
  var RE_TR = /^\s*\|.*\|/;
  var RE_TSEP = /^\s*\|?[\s:|-]*-[\s:|-]*$/;
  // 剥掉列表行前缀用（只剥行首那一处）
  var RE_UL_STRIP = /^\s*[-*+]\s+/;
  var RE_OL_STRIP = /^\s*\d+[.)]\s+/;

  function isBlockStart(line) {
    return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_QUOTE.test(line)
      || RE_UL.test(line) || RE_OL.test(line) || RE_HR.test(line) || RE_TR.test(line);
  }

  // 行首缩进宽度：空格算 1，Tab 算 4。只用来判断列表嵌套层级
  function indentWidth(line) {
    var w = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === ' ') w += 1;
      else if (ch === '\t') w += 4;
      else break;
    }
    return w;
  }

  // 围栏代码块。流式输出时收尾的 ``` 往往还没到，所以没闭合也照样当代码块画，
  // 不然每次回答的中途都会闪一屏原始 markdown
  function renderFence(lines, start, out) {
    var open = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(lines[start]);
    var lang = open && open[1] ? open[1] : '';
    var body = [];
    var i = start + 1;
    while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++; // 吃掉收尾那行围栏
    var cls = lang ? ' class="lang-' + esc(lang) + '"' : '';
    out.push('<pre><code' + cls + '>' + esc(body.join('\n')) + '</code></pre>');
    return i;
  }

  // 引用：连续的 > 行合成一块，段内换行按 <br> 保留
  function renderQuote(lines, start, out) {
    var body = [];
    var i = start;
    while (i < lines.length && RE_QUOTE.test(lines[i])) {
      body.push(lines[i].replace(/^\s*>\s?/, ''));
      i++;
    }
    var html = inline(esc(body.join('\n')));
    out.push('<blockquote>' + html.replace(/\n/g, '<br>') + '</blockquote>');
    return i;
  }

  // 一行表格：去掉首尾竖线再按 | 切，每格 trim
  function splitCells(line) {
    var body = line.trim();
    if (body.charAt(0) === '|') body = body.slice(1);
    if (body.charAt(body.length - 1) === '|') body = body.slice(0, -1);
    var raw = body.split('|');
    var out = [];
    for (var i = 0; i < raw.length; i++) out.push(raw[i].trim());
    return out;
  }

  // 表格：第一行是表头，第二行是分隔行（判断交给调用方），后面连续的 | 行都是数据行
  function renderTable(lines, start, out) {
    var heads = splitCells(lines[start]);
    var html = '<table><thead><tr>';
    var i;
    for (i = 0; i < heads.length; i++) html += '<th>' + inline(esc(heads[i])) + '</th>';
    html += '</tr></thead><tbody>';
    var row = start + 2;
    while (row < lines.length && RE_TR.test(lines[row])) {
      var cells = splitCells(lines[row]);
      html += '<tr>';
      for (i = 0; i < cells.length; i++) html += '<td>' + inline(esc(cells[i])) + '</td>';
      html += '</tr>';
      row++;
    }
    html += '</tbody></table>';
    out.push(html);
    return row;
  }

  // 段落：单个换行按 <br> 保留 —— 聊天里换行几乎总是有意的，
  // 按 markdown 原义合并成一行反而更难读
  function renderParagraph(lines, start, out) {
    // 当前行先收下：isBlockStart 认作块开头、别的分支却都不接的行（如没有分隔行的「| a |」），
    // 不先收就一行不前进，死循环把内存撑爆
    var body = [lines[start]];
    var i = start + 1;
    // 收段落时也要在开工选项标记处停下，否则标记会被当普通行并进这一段正文
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])
      && lines[i].indexOf('[开工选项]') < 0) {
      body.push(lines[i]);
      i++;
    }
    var html = inline(esc(body.join('\n')));
    out.push('<p>' + html.replace(/\n/g, '<br>') + '</p>');
    return i;
  }

  // 连续列表行一次收齐：每条记下缩进宽度、是不是有序、正文
  function collectListItems(lines, start) {
    var items = [];
    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      var ordered;
      var strip;
      if (RE_UL.test(line)) {
        ordered = false;
        strip = RE_UL_STRIP;
      } else if (RE_OL.test(line)) {
        ordered = true;
        strip = RE_OL_STRIP;
      } else {
        break;
      }
      items.push({ indent: indentWidth(line), ordered: ordered, text: line.replace(strip, '') });
      i++;
    }
    return { items: items, next: i };
  }

  // 按缩进搭出嵌套列表。用显式栈记每一层「缩进 / 标签 / 有没有开着的 <li>」，
  // 不用递归：缩进变深就在上一层那个没闭合的 <li> 里嵌一个新列表，变浅就逐层闭合
  function renderList(items, out) {
    var stack = [];
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var one = items[i];
      var tag = one.ordered ? 'ol' : 'ul';

      // 缩进回退：比这一条更深的层全部闭合
      while (stack.length && one.indent < stack[stack.length - 1].indent) {
        var deep = stack.pop();
        if (deep.openLi) html += '</li>';
        html += '</' + deep.tag + '>';
      }

      if (!stack.length) {
        stack.push({ indent: one.indent, tag: tag, openLi: false });
        html += '<' + tag + '>';
      } else if (one.indent > stack[stack.length - 1].indent) {
        // 更深一层：嵌进上一层那个还没闭合的 <li>
        stack.push({ indent: one.indent, tag: tag, openLi: false });
        html += '<' + tag + '>';
      } else {
        var cur = stack[stack.length - 1];
        if (cur.tag !== tag) {
          // 同一层换列表类型（- 接 1.）：把这层收干净，原地另开一个列表
          if (cur.openLi) html += '</li>';
          html += '</' + cur.tag + '>';
          stack.pop();
          stack.push({ indent: one.indent, tag: tag, openLi: false });
          html += '<' + tag + '>';
        } else if (cur.openLi) {
          html += '</li>'; // 同层下一条：闭合上一条
        }
      }

      html += '<li>' + inline(esc(one.text));
      stack[stack.length - 1].openLi = true;
    }

    // 收尾：从最深的层往回逐层闭合
    while (stack.length) {
      var lv = stack.pop();
      if (lv.openLi) html += '</li>';
      html += '</' + lv.tag + '>';
    }

    out.push(html);
  }

  function renderMarkdownRaw(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 开工选项标记块只给按钮供数据，小窗正文不显示：从含 [开工选项] 的这行起整块吞掉，
      // 一直跳到含 [/开工选项] 的那行（含该行）；流式输出时收标记常常还没到，
      // 那就一路跳到文本末尾，免得标记原文在小窗里闪出来。
      // 这里刻意用 indexOf 字面量判断，本文件是独立渲染模块，不引 app.js 的常量
      if (line.indexOf('[开工选项]') >= 0) {
        var closedSameLine = line.indexOf('[/开工选项]') >= 0;
        i++;
        if (!closedSameLine) {
          while (i < lines.length && lines[i].indexOf('[/开工选项]') < 0) i++;
          if (i < lines.length) i++; // 收标记的那一行也一起吃掉
        }
        continue; // 跳过的行不参与围栏/标题/表格/列表/段落等任何渲染分支
      }

      if (RE_FENCE.test(line)) {
        i = renderFence(lines, i, out);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      if (RE_HR.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      var head = RE_HEAD.exec(line);
      if (head) {
        // 标题层级照 # 的个数来，内容照常走行内规则
        var n = head[1].length;
        out.push('<h' + n + '>' + inline(esc(head[2])) + '</h' + n + '>');
        i++;
        continue;
      }

      // 表格：本行是 | a | b |，下一行是 |---|---| 才算
      if (RE_TR.test(line) && i + 1 < lines.length && RE_TSEP.test(lines[i + 1])) {
        i = renderTable(lines, i, out);
        continue;
      }

      if (RE_QUOTE.test(line)) {
        i = renderQuote(lines, i, out);
        continue;
      }

      if (RE_UL.test(line) || RE_OL.test(line)) {
        var got = collectListItems(lines, i);
        renderList(got.items, out);
        i = got.next;
        continue;
      }

      i = renderParagraph(lines, i, out);
    }

    return out.join('');
  }

  // 渲染缓存：最多 60 条。命中时把这条挪到队尾（最近用过的留得住），
  // 超了就从队头淘汰最旧的。流式输出每帧整份重画消息区，稳定那几条靠它不必重算
  var MD_CACHE_MAX = 60;
  var mdCache = new Map();

  function renderMarkdown(src) {
    var key = String(src == null ? '' : src);
    var hit = mdCache.get(key);
    if (hit !== undefined) {
      mdCache.delete(key);
      mdCache.set(key, hit);
      return hit;
    }
    var html = renderMarkdownRaw(key);
    mdCache.set(key, html);
    while (mdCache.size > MD_CACHE_MAX) {
      var oldest = mdCache.keys().next().value;
      mdCache.delete(oldest);
    }
    return html;
  }

  window.FloatBarMd = { render: renderMarkdown };
})();

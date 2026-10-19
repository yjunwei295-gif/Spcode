// 本地提取紧邻声明的说明，不调用模型，也不从标识符猜测业务含义。

/**
 * 清理常见文档注释标记，保留参数说明等正文。
 * 原始注释另存为 commentRaw，地图详情可以显示未经清理的内容。
 */
function cleanComment(raw) {
  return raw.replace(/^\s*[ru]?("""|''')/i, '').replace(/("""|''')\s*$/, '')
    .replace(/^\s*(?:\/\*\*?|\*\/|\/\/\/?|\*|#)\s?/gm, '')
    .replace(/\*\/\s*$/gm, '')
    .replace(/<param\s+name=["']([^"']+)["']\s*>/gi, '参数 $1：')
    .replace(/<returns\s*>/gi, '返回：')
    .replace(/<\/?(?:summary|remarks|param|returns|example)>/gi, '')
    .trim();
}

/**
 * 为符号补充源码里的注释、注释行号及短标题。
 * 只关联紧邻声明的注释（允许中间有装饰器/特性），避免借用上个方法的正文。
 * Python 额外读取紧随声明的文档字符串；无法确定归属时保持为空。
 */
function attachComments(text, symbols, ext) {
  const lines = String(text || '').split(/\r?\n/);
  const lineComment = ['.py', '.sh', '.ps1', '.rb', '.yaml', '.yml', '.r'].includes(ext) ? /^\s*(?:\/\/|#)/ : /^\s*\/\//;
  for (const symbol of symbols || []) {
    const start = Math.max(0, (symbol.line || 1) - 1);
    let end = start - 1;
    while (end >= 0 && /^\s*(?:\[[^\]]+\]|@[\w.]+(?:\([^\n]*\))?)\s*$/.test(lines[end])) end--;
    let first = end + 1;
    let raw = '';
    if (end >= 0 && lineComment.test(lines[end])) {
      first = end;
      while (first > 0 && lineComment.test(lines[first - 1])) first--;
      raw = lines.slice(first, end + 1).join('\n');
    } else if (end >= 0 && /\*\/\s*$/.test(lines[end])) {
      first = end;
      while (first > 0 && !lines[first].includes('/*')) first--;
      if (/^\s*\/\*/.test(lines[first])) raw = lines.slice(first, end + 1).join('\n');
    }
    if (!raw && ext === '.py' && /:\s*(?:#.*)?$/.test(lines[start] || '')) {
      first = start + 1;
      const match = (lines[first] || '').match(/^\s*[ru]?("""|''')/i);
      if (match) {
        const delimiter = match[1];
        let last = first;
        const head = lines[first].slice(match[0].length);
        if (!head.includes(delimiter)) {
          while (++last < lines.length && !lines[last].includes(delimiter)) { /* 找文档字符串尾 */ }
        }
        if (last < lines.length) raw = lines.slice(first, last + 1).join('\n');
      }
    }
    symbol.commentRaw = raw;
    symbol.comment = cleanComment(raw);
    symbol.commentLine = raw ? first + 1 : null;
    symbol.title = symbol.comment.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 160) || '';
  }
  return symbols;
}

// 大脑、API 代码槽、直通代码槽共用一份注释要求，避免不同入口漏掉规则。
const COMMENT_POLICY = `\n【代码注释与地图检索规则】
大脑先读地图的方法名和注释标题来筛选，再读取相关条目的完整源码；代码模块复用派单中的已核实原文，缺少时只读目标区段。注释可能过期，不能单凭注释修改实现或跳过必要的调用方检查。
所有新增或修改的模块、类、方法、重要字段/配置和复杂逻辑都须有足够详细的注释。方法注释放在声明前，第一句独立概括用途，随后写适用的参数含义、返回值、状态变化/副作用、边界条件及设计原因；复杂分支、顺序依赖、坐标/单位转换在对应位置解释原因。简单代码写清职责即可，不逐行翻译语法。
本次处理范围内缺注释就补，过期或矛盾的注释按核实后的实现修正；不要猜测业务意图。补注释属于实现完成标准，大脑须写入派单和核对要求；代码模块执行，总结模块核对。遵循项目支持的注释格式（如 XML/JSDoc/docstring），JSON 等不支持注释的文件用配套文档。只为补注释不改变运行逻辑，不为这条规则扫描并重写任务外的整个仓库。\n`;

module.exports = { attachComments, COMMENT_POLICY };

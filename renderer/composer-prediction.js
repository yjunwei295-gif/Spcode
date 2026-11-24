/**
 * 从常用需求摘要生成灰字预测，并处理用户明确接受预测的键盘手势。
 * 候选只来自已提交的用户原稿；显示灰字不修改 textarea，也不调用模型或发送请求。
 */

/** 预测交互参数集中维护：三个字符开始匹配，快速双按使用同一个时间窗口。 */
export const COMPOSER_PREDICTION_OPTIONS = Object.freeze({
  minimumPrefixCharacters: 3,
  doublePressMs: 300
});

/**
 * 合并不同会话的需求摘要，按频次、最近会话和会话内最近位置排序。
 * @param {Array<object>} sources 每项含 id、updatedAt 和 requirements；调用方须先用已打开会话替换同编号旧摘要。
 * @returns {Array<object>} 独立候选数组，保留完整正文，不修改来源会话或历史记录。
 */
export function rankComposerRequirements(sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const requirement of source.requirements) {
      const text = requirement.text;
      const recentAt = source.updatedAt;
      let item = merged.get(text);
      if (!item) {
        item = { text, count: 0, recentAt, lastIndex: requirement.lastIndex };
        merged.set(text, item);
      }
      item.count += requirement.count;
      if (recentAt > item.recentAt || (recentAt === item.recentAt && requirement.lastIndex > item.lastIndex)) {
        item.recentAt = recentAt;
        item.lastIndex = requirement.lastIndex;
      }
    }
  }
  return Array.from(merged.values()).sort(compareRequirements);
}

/**
 * 比较两条常用需求；相同频次优先最近使用，最终按正文稳定排序。
 * @param {object} left 左侧摘要。
 * @param {object} right 右侧摘要。
 * @returns {number} Array.sort 使用的顺序值。
 */
function compareRequirements(left, right) {
  if (left.count !== right.count) return right.count - left.count;
  if (left.recentAt !== right.recentAt) return left.recentAt > right.recentAt ? -1 : 1;
  if (left.lastIndex !== right.lastIndex) return right.lastIndex - left.lastIndex;
  return left.text.localeCompare(right.text);
}

/**
 * 创建与当前输入框绑定的预测控制器。
 * @param {object} config 提供 input、ghost、hint 提示节点、getSessionKey、isBlocked、onSend，以及可覆盖的 options 交互参数。
 * @returns {object} 提供候选更新、刷新、键盘处理、取消和销毁方法；发送仍由现有 onSend 负责。
 * 补全只发生在双回车或空框双空格；切换会话、失焦、输入法或继续编辑会取消尚未发出的单回车。
 */
export function createComposerPrediction(config) {
  const input = config.input;
  const ghost = config.ghost;
  const hint = config.hint;
  const mirror = ghost.querySelector('.composer-prediction-text');
  const prefix = ghost.querySelector('.composer-prediction-prefix');
  const suffix = ghost.querySelector('.composer-prediction-suffix');
  const view = input.ownerDocument.defaultView;
  const options = { ...COMPOSER_PREDICTION_OPTIONS, ...config.options };
  let candidates = [];
  let composing = false;
  let sessionKey = config.getSessionKey();
  let pendingEnter = null;
  let enterTimer = null;
  let pendingSpace = null;
  let spaceTimer = null;

  /** 取消单回车的待发送状态，不修改当前输入内容。 */
  function cancelEnter() {
    if (enterTimer !== null) view.clearTimeout(enterTimer);
    enterTimer = null;
    pendingEnter = null;
  }

  /** 结束双空格识别；第一次空格始终保留浏览器原生输入，不需要事后补字。 */
  function cancelSpace() {
    if (spaceTimer !== null) view.clearTimeout(spaceTimer);
    spaceTimer = null;
    pendingSpace = null;
  }

  /** 取消当前会话的所有连按状态，供导航、失焦和显式发送复用。 */
  function reset() {
    cancelEnter();
    cancelSpace();
  }

  /** 同步当前会话编号；旧会话的延迟回车不得向新会话发送内容。 */
  function syncSession() {
    const next = config.getSessionKey();
    if (next === sessionKey) return;
    reset();
    sessionKey = next;
  }

  /**
   * 选择此刻可显示的完整候选。
   * @returns {string} 完整预测正文；未达到前缀门槛、光标不在末尾或菜单/输入法占用时为空串。
   */
  function suggestion() {
    if (composing || config.isBlocked()) return '';
    const value = input.value;
    // 连按窗口内固定已展示的候选，后台摘要更新不能让第二下接受另一句话。
    if (pendingSpace && (value === '' || value === ' ')) return pendingSpace.suggestion;
    if (value === '') return candidates.length ? candidates[0].text : '';
    if (Array.from(value).length < options.minimumPrefixCharacters) return '';
    if (input.selectionStart !== value.length || input.selectionEnd !== value.length) return '';
    if (pendingEnter && value === pendingEnter.text) return pendingEnter.suggestion;
    for (const candidate of candidates) {
      if (candidate.text.length > value.length && candidate.text.startsWith(value)) return candidate.text;
    }
    return '';
  }

  /** 使灰字镜像使用真实输入框的字体、内边距、宽度与滚动位置，兼容主题和多行折行。 */
  function syncLayout() {
    const style = view.getComputedStyle(input);
    const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'direction', 'tabSize',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
    for (const property of properties) mirror.style[property] = style[property];
    mirror.style.width = input.clientWidth + 'px';
    mirror.style.minHeight = input.clientHeight + 'px';
    mirror.style.transform = 'translate(' + -input.scrollLeft + 'px,' + -input.scrollTop + 'px)';
  }

  /**
   * 按当前输入同步刷新灰字和对应补全手势。
   * 无参数；空框提示双空格，已有文字提示双回车；没有候选时一并隐藏提示。
   * @returns {void} 只更新提示节点和镜像布局，不将提示文字写入输入正文或草稿。
   */
  function refresh() {
    syncSession();
    if (pendingEnter && input.value !== pendingEnter.text) cancelEnter();
    if (pendingSpace && input.value !== '' && input.value !== ' ') cancelSpace();
    const text = suggestion();
    if (pendingEnter && text !== pendingEnter.suggestion) cancelEnter();
    prefix.textContent = pendingSpace ? '' : input.value;
    suffix.textContent = text ? text.slice(pendingSpace ? 0 : input.value.length) : '';
    ghost.hidden = !text;
    hint.hidden = !text;
    hint.textContent = input.value === '' || pendingSpace ? '快速按两次空格补全' : '快速按两次回车补全';
    if (text) syncLayout();
  }

  /**
   * 更新按排名排好的候选池。
   * @param {Array<object>} values 每项含完整 text；异步历史回执不会直接补全当前输入。
   */
  function setCandidates(values) {
    candidates = values;
    refresh();
  }

  /**
   * 接受明确选中的预测，保留现有附件和上下文，并通过 input 事件保存草稿。
   * @param {string} text 用户通过连按接受的完整正文。
   */
  function accept(text) {
    reset();
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    refresh();
  }

  /** 单回车识别窗口结束后只发送原会话、原输入；失焦或编辑后的内容不自动发送。 */
  function submitPendingEnter() {
    const pending = pendingEnter;
    enterTimer = null;
    pendingEnter = null;
    if (!pending || config.getSessionKey() !== pending.sessionKey || input.value !== pending.text) return;
    if (input.ownerDocument.activeElement !== input || composing || config.isBlocked()) return;
    config.onSend();
    refresh();
  }

  /** 双空格窗口结束只撤掉提示状态，已输入的一个空格仍留在 textarea。 */
  function expireSpace() {
    spaceTimer = null;
    pendingSpace = null;
    refresh();
  }

  /**
   * 处理预测快捷键，返回是否已经消费本次按键。
   * @param {KeyboardEvent} event 由主输入框现有键盘处理器传入；长按重复不视为快速双按。
   * @returns {boolean} true 表示调用方不得再次发送；false 沿用现有输入或发送行为。
   */
  function handleKeydown(event) {
    syncSession();
    if (event.defaultPrevented) return true;
    if (composing || event.isComposing || event.keyCode === 229) {
      reset();
      // 不阻止输入法默认处理，只阻止主输入框继续把确认键当作发送。
      return true;
    }
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
      reset();
      return false;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      reset();
      return false;
    }
    if (event.repeat) {
      if (event.key === 'Enter') {
        // 长按不是第二次确认；第一次回车仍按原定时间发送一次。
        event.preventDefault();
        return true;
      }
      reset();
      return false;
    }
    const now = view.performance.now();
    if (event.key === ' ') {
      cancelEnter();
      if (pendingSpace && now <= pendingSpace.deadline && input.value === ' ') {
        event.preventDefault();
        accept(pendingSpace.suggestion);
        return true;
      }
      cancelSpace();
      const text = suggestion();
      if (input.value !== '' || !text) return false;
      pendingSpace = { suggestion: text, deadline: now + options.doublePressMs };
      spaceTimer = view.setTimeout(expireSpace, options.doublePressMs);
      return false;
    }
    cancelSpace();
    if (pendingEnter && now <= pendingEnter.deadline && input.value === pendingEnter.text) {
      event.preventDefault();
      accept(pendingEnter.suggestion);
      return true;
    }
    cancelEnter();
    const text = suggestion();
    if (!input.value || !text) return false;
    event.preventDefault();
    pendingEnter = { text: input.value, suggestion: text, sessionKey, deadline: now + options.doublePressMs };
    enterTimer = view.setTimeout(submitPendingEnter, options.doublePressMs);
    return true;
  }

  /** 用户编辑会取消延迟发送；空框第一下空格保留双按状态，其他编辑结束空格识别。 */
  function onInputChanged() {
    cancelEnter();
    if (pendingSpace && input.value !== ' ') cancelSpace();
    refresh();
  }

  /** 输入法开始组字时隐藏预测并取消连按，回车和空格继续归输入法使用。 */
  function onCompositionStart() {
    composing = true;
    reset();
    refresh();
  }

  /** 组字结束后按已提交的真实文字重新匹配，不把候选确认键当作发送。 */
  function onCompositionEnd() {
    composing = false;
    refresh();
  }

  /** 失焦后取消待发送回车，避免用户操作其他控件时提交原输入。 */
  function onBlur() {
    reset();
    refresh();
  }

  /** 光标或选区变化不应保留待发送手势；只更新当前可见的后缀。 */
  function onSelectionChanged() {
    if (pendingEnter && (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length)) cancelEnter();
    refresh();
  }

  /** 移除控制器注册的事件、观察器和计时器，不更改输入内容。 */
  function destroy() {
    reset();
    input.removeEventListener('input', onInputChanged);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('select', onSelectionChanged);
    input.removeEventListener('keyup', onSelectionChanged);
    input.removeEventListener('click', onSelectionChanged);
    input.removeEventListener('scroll', syncLayout);
    resizeObserver.disconnect();
    themeObserver.disconnect();
  }

  input.addEventListener('input', onInputChanged);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('blur', onBlur);
  input.addEventListener('select', onSelectionChanged);
  input.addEventListener('keyup', onSelectionChanged);
  input.addEventListener('click', onSelectionChanged);
  input.addEventListener('scroll', syncLayout);
  const resizeObserver = new view.ResizeObserver(refresh);
  resizeObserver.observe(input);
  const themeObserver = new view.MutationObserver(refresh);
  themeObserver.observe(input.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
  refresh();
  return { refresh, reset, setCandidates, destroy, handleKeydown };
}

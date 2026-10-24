/**
 * AGI 空闲时在本机识别屏幕请求，仅新请求才交给已有对话队列。
 * 不导入模型发送器；稳定、去重与开关生命周期都在本地处理。
 */

/** 只接受以“请帮我”开头且含实际内容的一行请求；其它屏幕文字不作为指令。 */
function requestsIn(frame) {
  const requests = [];
  if (!frame) return requests;
  for (const line of frame.lines) {
    const text = String(line.text).trim();
    if (!text.startsWith('请帮我')) continue;
    const body = text.slice('请帮我'.length).replace(/^[，,：:\s]+/, '').trim();
    if (!body || requests.includes(text)) continue;
    requests.push(text);
  }
  return requests;
}

/**
 * 建立串行观察器；observe 只读本地画面，deliver 返回渲染层是否接收。
 * interval 提供现有资源档位间隔；stop 会使在途观察和投递结果失效，不继续接单。
 */
function createScreenWatcher({ observe, ready, deliver, interval, onError }) {
  let enabled = false;
  let generation = 0;
  let timer = null;
  let observing = false;
  let owner = '';
  let stable = new Set();
  const seen = new Set();

  /** 安排下一次本地检查；上一轮完全结束后才计时，避免 OCR 重叠。 */
  function schedule() {
    if (!enabled || timer !== null || observing) return;
    timer = setTimeout(tick, interval());
    if (timer.unref) timer.unref();
  }

  /** 关闭后台监听；保留本会话去重记录，避免反复开关重复执行同一请求。 */
  function stop() {
    enabled = false;
    generation++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    stable = new Set();
  }

  /** 开启指定会话的监听；换会话时重新建立该会话的接单记录。 */
  function start(key) {
    stop();
    if (owner !== key) seen.clear();
    owner = key;
    enabled = true;
    schedule();
  }

  /**
   * 读取一次前台画面，连续两次一致的请求才投递，且收到接收回执才记为已执行。
   * 忙碌时不读屏，关闭后丢弃在途结果；观察失败明确报告并停止，不暗中重试模型。
   */
  async function tick() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!enabled || observing) return;
    const current = generation;
    observing = true;
    try {
      if (!ready()) { stable = new Set(); return; }
      const frame = await observe();
      if (!enabled || generation !== current || !ready()) return;
      const requests = requestsIn(frame);
      const next = new Set(requests);
      for (const text of requests) {
        if (!stable.has(text) || seen.has(text)) continue;
        const accepted = await deliver({ text, source: frame.source });
        if (!enabled || generation !== current) return;
        if (accepted) seen.add(text);
        // 接单后立刻让已有任务运行；下一次空闲再观察其它请求。
        if (accepted) break;
      }
      stable = next;
    } catch (error) {
      if (enabled && generation === current) {
        stop();
        onError(error);
      }
    } finally {
      observing = false;
      schedule();
    }
  }

  return { start, stop, tick };
}

module.exports = { createScreenWatcher, requestsIn };

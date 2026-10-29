/* 桌宠状态只消费真实事件；可在浏览器与 Node 测试中使用。 */
(function (root) {
  'use strict';
  var READ = ['read_file', 'list_dir', 'process_memory'];
  var SEARCH = ['search_text', 'semantic_search', 'map_lookup', 'goto_definition'];
  var WRITE = ['write_file', 'edit_file', 'create_dir', 'delete_file'];
  var DESKTOP = ['screen_read', 'screen_look', 'clipboard_look', 'mouse_click', 'mouse_drag', 'mouse_scroll', 'keyboard_key', 'keyboard_type', 'window_focus', 'window_list', 'ui_act', 'float_bar_move'];
  var MEDIA = ['generate_media', 'render_code_audio', 'render_code_video', 'analyze_audio', 'present_artifact', 'export_artifact'];
  /** 根据工具标识归类；命令用途只认上游显式提供的 activity。 */
  function activity(name, explicit) {
    if (explicit === 'testing') return 'testing';
    if (READ.indexOf(name) >= 0) return 'reading';
    if (SEARCH.indexOf(name) >= 0) return 'searching';
    if (WRITE.indexOf(name) >= 0) return 'writing';
    if (DESKTOP.indexOf(name) >= 0) return 'desktop';
    if (MEDIA.indexOf(name) >= 0) return 'generating';
    // 未单独分类的工具统一显示执行提示，不把普通调用当成异常。
    return 'running';
  }
  /** 为一个绑定会话保存独立轮次与并行调用，避免其他标签页污染动作。 */
  function Model(config) {
    this.config = config;
    this.key = '';
    this.turns = new Map();
    this.state = 'idle';
    this.detail = '';
    this.changedAt = 0;
    this.holdUntil = 0;
    this.terminalUntil = 0;
  }
  /** 重绑后从对应历史恢复；历史动作不会触发结束庆祝。 */
  Model.prototype.bind = function (key, items, now) {
    this.key = key;
    this.turns.clear();
    this.state = 'idle';
    this.detail = '';
    this.holdUntil = 0;
    this.terminalUntil = 0;
    for (var i = 0; i < items.length; i++) this.apply(items[i], now, true);
    this.select(now, true);
  };
  /** 获取指定轮次的状态；仅处理当前会话携带轮次编号的事件。 */
  Model.prototype.turn = function (id) {
    if (!this.turns.has(id)) this.turns.set(id, { tools: new Map(), waiting: false, phase: 'thinking', detail: '', reasoning: '', dialogue: '' });
    return this.turns.get(id);
  };
  /** 消费开始、输出、工具、等待与终止事件；done 仅代表调用结束。 */
  Model.prototype.apply = function (ev, now, replay) {
    if (ev.kind === 'history') { this.bind(ev.sessionKey, ev.items, now); return; }
    if (ev.sessionKey !== this.key || !ev.turnId || ev.kind === 'idle') return;
    var id = ev.turnId;
    var t = this.turn(id);
    if (ev.kind === 'user' || ev.kind === 'turn-start') { t.phase = 'thinking'; t.reasoning = ''; t.dialogue = ''; t.detail = ''; }
    // 气泡只展示对话和模型公开的思考文本；工具名、参数、命令输出不进入正文。
    if (ev.kind === 'ai') { t.dialogue = String(ev.text || ''); t.detail = t.dialogue; t.phase = 'speaking'; }
    if (ev.kind === 'ai-delta') { t.dialogue = (t.dialogue || '') + String(ev.text || ''); t.detail = t.dialogue; t.phase = 'speaking'; }
    // 推理增量拼全文；短提示只在尚无推理正文时占位，避免盖住思考全文。
    if (ev.kind === 'reason' && ev.text) { t.reasoning = (t.reasoning || '') + String(ev.text); t.detail = t.reasoning; t.phase = 'thinking'; }
    if (ev.kind === 'think' && ev.text) { t.phase = 'thinking'; if (!t.reasoning) t.detail = String(ev.text); }
    // 状态通知可能含完整命令；动作单独保留，正文只由思考和对话更新。
    if (ev.kind === 'tool' && ev.callId) {
      if (ev.status === 'running') {
        t.tools.set(ev.callId, { state: activity(ev.name, ev.activity) });
        t.phase = 'thinking';
      } else {
        t.tools.delete(ev.callId);
        // 单次工具失败可由后续调用修正；继续使用通用执行提示，整轮结论由 turn-end 决定。
        if (ev.outcome === 'error') { t.phase = 'running'; if (!t.reasoning && !t.dialogue) t.detail = this.config.labels.running; }
      }
    }
    if (ev.kind === 'ask') { t.waiting = true; t.detail = ev.question; }
    if (ev.kind === 'answered') { t.waiting = false; t.phase = 'thinking'; }
    // 显式轮次错误才进入错误状态；后续实际回复或思考可恢复正常阶段。
    if (ev.kind === 'error') { t.phase = 'error'; t.detail = ev.text; }
    if (ev.kind === 'turn-end') {
      this.turns.delete(id);
      if (!replay) {
        // 主进程的实际结束原因区分停止、失败和成功，不累积已经恢复的工具错误。
        this.state = ev.outcome === 'stopped' ? 'stopped' : (ev.outcome === 'error' ? 'error' : 'success');
        this.detail = this.config.labels[this.state];
        this.terminalUntil = now + this.config.motion.finishMs;
      }
    }
    // 旧 idle 没有结束原因，不据此显示成功，也不覆盖显式终止状态。
    if (ev.kind === 'idle' && !replay && this.terminalUntil > now) return;
    this.select(now, !!replay);
  };
  /** 按等待、活动工具、输出、思考决定动作；不同轮次的结束不会清掉其他任务。 */
  Model.prototype.select = function (now, immediate) {
    var next = 'idle';
    var detail = '';
    var count = 0;
    var waiting = false;
    for (var t of this.turns.values()) {
      if (t.waiting) { waiting = true; next = 'waiting'; detail = t.detail; break; }
      for (var tool of t.tools.values()) {
        next = tool.state;
        detail = t.reasoning || t.dialogue || t.detail || this.config.labels[tool.state];
        count++;
      }
      // 无工具时：思考相位优先推推理全文，否则用已有 detail。
      if (!count) { next = t.phase; detail = (t.phase === 'thinking' && t.reasoning) ? t.reasoning : t.detail; }
    }
    if (!this.turns.size && now < this.terminalUntil) return;
    if (count > 1) detail += ' · 共 ' + count + ' 项执行中';
    if (immediate || waiting || now >= this.holdUntil || this.state === 'waiting') {
      if (next !== this.state) {
        this.state = next;
        this.changedAt = now;
        this.holdUntil = now + this.config.motion.minStateMs;
      }
      this.detail = detail;
    }
  };
  var api = { Model: Model, activity: activity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DesktopPetState = api;
})(typeof window !== 'undefined' ? window : globalThis);

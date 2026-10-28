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
    if (name === 'run_command') return 'running';
    return 'thinking';
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
    if (!this.turns.has(id)) this.turns.set(id, { tools: new Map(), waiting: false, phase: 'thinking', detail: '', reasoning: '', failed: false });
    return this.turns.get(id);
  };
  /** 消费开始、输出、工具、等待与终止事件；done 仅代表调用结束。 */
  Model.prototype.apply = function (ev, now, replay) {
    if (ev.kind === 'history') { this.bind(ev.sessionKey, ev.items, now); return; }
    if (ev.sessionKey !== this.key || !ev.turnId || ev.kind === 'idle') return;
    var id = ev.turnId;
    var t = this.turn(id);
    if (ev.kind === 'user' || ev.kind === 'turn-start') { t.phase = 'thinking'; t.reasoning = ''; t.detail = ''; }
    if (ev.kind === 'ai' || ev.kind === 'ai-delta') t.phase = 'speaking';
    // 推理增量拼全文；短提示只在尚无推理正文时占位，避免盖住思考全文。
    if (ev.kind === 'reason' && ev.text) { t.reasoning = (t.reasoning || '') + String(ev.text); t.detail = t.reasoning; t.phase = 'thinking'; }
    if (ev.kind === 'think' && ev.text) { t.phase = 'thinking'; if (!t.reasoning) t.detail = String(ev.text); }
    if (ev.kind === 'status') { if (!t.reasoning) t.detail = ev.text; }
    if (ev.kind === 'tool' && ev.callId) {
      if (ev.status === 'running') {
        t.tools.set(ev.callId, { state: activity(ev.name, ev.activity), detail: ev.text });
        t.phase = 'thinking';
      } else {
        t.tools.delete(ev.callId);
        if (ev.outcome === 'error') { t.failed = true; t.detail = ev.text; }
      }
    }
    if (ev.kind === 'ask') { t.waiting = true; t.detail = ev.question; }
    if (ev.kind === 'answered') { t.waiting = false; t.phase = 'thinking'; }
    if (ev.kind === 'error') { t.failed = true; t.detail = ev.text; }
    if (ev.kind === 'turn-end') {
      this.turns.delete(id);
      if (!replay) {
        this.state = ev.outcome === 'stopped' ? 'stopped' : (ev.outcome === 'error' || t.failed ? 'error' : 'success');
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
      for (var tool of t.tools.values()) { next = tool.state; detail = tool.detail; count++; }
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

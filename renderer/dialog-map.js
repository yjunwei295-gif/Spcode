// 「塞给 AI 的上下文」导图：只画下一轮会发给 AI 的轮次。
// 每轮只发一行标题，AI 要细节时自己按编号查原文；根 → 「标题」支 → 轮次（超过 10 轮按每 10 轮一组）。
// 旁边列表勾选 = 塞给 AI，改动马上反映到图上，点「应用」才保存。和项目地图完全分开，不共用任何节点或样式名。
(function () {
  const GROUP_SIZE = 10;
  const PREVIEW_CHARS = 1500;

  function el(tag, props) {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    if (tag === 'button') n.classList.add('map-button');
    return n;
  }
  function oneLine(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  const btnCss = 'border:1px solid var(--border);background:var(--map-button-bg,var(--btn-bg));border-radius:var(--sub-r);padding:3px 8px;cursor:pointer;font-size:12px;color:inherit;';

  function clip(t, cap) {
    const s = String(t || '');
    return s.length <= cap ? s : s.slice(0, cap) + '\n…';
  }
  // 和后台 context-compact.roundTitleLine 保持一致
  function titleLine(r) {
    return `#R${r.n} ${oneLine(r.indexTitle) || oneLine(r.userText).slice(0, 60) || text('（空）', '(empty)')}`.slice(0, 120);
  }

  /** 按勾选算出每轮怎么发：'title' 发标题 / 'off' 不发 */
  function planOf(rounds, on) {
    const how = new Map();
    for (const r of rounds) how.set(r.n, on.has(r.n) ? 'title' : 'off');
    return how;
  }
  function isEnglish() {
    const lang = document.documentElement.lang || document.body.lang || '';
    return /^en(?:-|$)/i.test(lang);
  }
  function text(zh, en) { return isEnglish() ? en : zh; }
  function howLabel(how) { return text(how === 'title' ? '标题' : '不发', how === 'title' ? 'Title' : 'Not sent'); }

  function close() {
    const modal = document.getElementById('dialog-map-modal');
    if (!modal) return;
    if (modal._dispose) modal._dispose();
    modal.remove();
  }

  /**
   * opts: { title, rounds: [{ n, title, indexTitle, indexSummary, userText, asstText, skip }], onApply({ skipSet, removeSet }), onPreview }
   */
  function open(opts) {
    close();
    const rounds = (opts.rounds || []).map((r) => Object.assign({}, r));
    // 暂存的勾选：改动先只影响图，点「应用」才写回
    const on = new Set(rounds.filter((r) => !r.skip).map((r) => r.n));
    // 本趟点过删除、等「应用」才同时删除聊天记录的轮次
    const pendingRemove = new Set();

    const modal = el('div', { id: 'dialog-map-modal', className: 'map-modal' });
    modal.style.cssText = 'position:fixed;inset:0;z-index:91;background:var(--overlay);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';
    const card = el('div', { className: 'dialog-map-card' });
    card.style.cssText = 'position:relative;width:min(94vw,1120px);height:min(88vh,840px);background:var(--panel-solid);border:1px solid var(--border);'
      + 'border-radius:var(--sub-r-lg);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow);';

    const head = el('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);';
    const title = el('span', { textContent: `${text('塞给 AI 的上下文', 'Context sent to AI')} · ${opts.title || ''}` });
    title.style.cssText = 'font-size:14px;font-weight:600;';
    const right = el('div');
    right.style.cssText = 'display:flex;align-items:center;gap:8px;';
    if (opts.onPreview) {
      const prev = el('button', { textContent: text('查看实际发送', 'View what was sent') });
      prev.title = text('上一轮真正发给模型的完整内容，包括系统提示', 'Full content actually sent to the model in the previous turn, including system instructions');
      prev.style.cssText = btnCss;
      prev.onclick = () => { close(); opts.onPreview(); };
      right.appendChild(prev);
    }
    const filterBtn = el('button', { textContent: text('筛选', 'Filter') });
    filterBtn.style.cssText = btnCss;
    right.appendChild(filterBtn);
    const x = el('button', { textContent: '×' });
    x.style.cssText = 'border:0;background:none;font-size:20px;cursor:pointer;color:var(--muted);';
    x.onclick = close;
    right.appendChild(x);
    head.appendChild(title);
    head.appendChild(right);

    const body = el('div');
    body.style.cssText = 'position:relative;flex:1;overflow:hidden;';
    const canvas = el('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;';
    body.appendChild(canvas);
    card.appendChild(head);
    card.appendChild(body);
    modal.appendChild(card);
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);

    let popover = null;
    let panel = null;
    function hidePopover() { if (popover) { popover.remove(); popover = null; } }
    const view = drawTree(canvas, opts.title || text('对话', 'Conversation'), (r, how, sx, sy) => showPopover(r, how, sx, sy));
    modal._dispose = () => {
      view.dispose();
      document.removeEventListener('keydown', onEsc);
      if (panel && panel.node && panel.node._dispose) panel.node._dispose();
    };

    function refreshTree() {
      const how = planOf(rounds, on);
      // 导图只展示当前勾选、会发给 AI 的轮次；右侧列表仍保留全部轮次供筛选。
      view.setData(rounds.filter((r) => on.has(r.n)), how);
      return how;
    }
    function refreshAll() {
      const how = refreshTree();
      if (panel) panel.refresh(how);
    }

    function showPopover(r, how, sx, sy) {
      hidePopover();
      popover = el('div');
      popover.style.cssText = 'position:absolute;z-index:4;width:360px;max-height:60%;display:flex;flex-direction:column;background:var(--panel-solid);'
        + 'border:1px solid var(--border);border-radius:var(--sub-r);box-shadow:var(--shadow);padding:10px 12px;font-size:12px;line-height:1.6;';
      popover.style.left = Math.max(8, Math.min(sx + 12, body.clientWidth - 380)) + 'px';
      popover.style.top = Math.max(8, Math.min(sy + 12, body.clientHeight * 0.4)) + 'px';
      const h = el('div', { textContent: text(`R${r.n} ${r.title} · 发${howLabel(how)}`, `R${r.n} ${r.title} · ${how === 'title' ? 'Send title' : 'Not sent'}`) });
      h.style.cssText = 'font-weight:600;margin-bottom:6px;';
      const sent = el('div', { textContent: titleLine(r) });
      sent.style.cssText = 'white-space:pre-wrap;word-break:break-word;color:var(--text);background:var(--hover);border-radius:var(--sub-r);padding:6px 8px;';
      const label = el('div', { textContent: text('原文预览（不发，AI 需要时按编号查）', 'Original text preview (not sent; AI can look it up by number when needed)') });
      label.style.cssText = 'margin:8px 0 4px;color:var(--muted);';
      const pre = el('div', { textContent: `${text('【用户】', '[User]')}\n${clip(r.userText, PREVIEW_CHARS)}\n\n${text('【助手】', '[Assistant]')}\n${clip(r.asstText, PREVIEW_CHARS)}` });
      pre.style.cssText = 'flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--muted);border:1px solid var(--border);border-radius:var(--sub-r);padding:6px 8px;';
      const btns = el('div');
      btns.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;';
      const t = el('button', { textContent: text('标成不适用', 'Mark as not applicable') });
      t.style.cssText = btnCss;
      t.onclick = () => {
        on.delete(r.n);
        hidePopover();
        refreshAll();
      };
      const del = el('button', { textContent: text('删除本轮对话', 'Delete this round') });
      del.style.cssText = btnCss;
      del.onclick = () => { hidePopover(); removeRounds([r.n]); };
      btns.appendChild(t);
      btns.appendChild(del);
      popover.appendChild(h);
      popover.appendChild(sent);
      popover.appendChild(label);
      popover.appendChild(pre);
      popover.appendChild(btns);
      body.appendChild(popover);
    }
    canvas.addEventListener('mousedown', hidePopover);

    function removeRounds(ns) {
      const list = [...new Set(ns)].filter((n) => rounds.some((r) => r.n === n));
      if (!list.length) return;
      if (!confirm(text(`将删除 ${list.length} 轮的用户消息、AI 回复及对应上下文，点「应用」后保存。项目文件不会回滚。确定？`, `Delete ${list.length} round(s), including user messages, AI replies and context, when you click Apply? Project files will not be reverted.`))) return;
      for (const n of list) {
        pendingRemove.add(n);
        on.delete(n);
        const i = rounds.findIndex((r) => r.n === n);
        if (i >= 0) rounds.splice(i, 1);
      }
      refreshAll();
    }

    panel = buildFilterPanel(rounds, on, refreshAll, async () => {
      const skipSet = new Set(rounds.filter((r) => !on.has(r.n)).map((r) => r.n));
      const removeSet = new Set(pendingRemove);
      if (opts.onApply && await opts.onApply({ skipSet, removeSet }) === false) return false;
      for (const r of rounds) r.skip = skipSet.has(r.n);
      for (const n of removeSet) pendingRemove.delete(n);
      refreshAll();
      return true;
    }, removeRounds, refreshTree);
    body.appendChild(panel.node);
    filterBtn.onclick = () => {
      panel.node.style.display = panel.node.style.display === 'none' ? 'flex' : 'none';
    };
    refreshAll();
  }

  // 筛选列表：勾选 = 塞给 AI；按住拖选；可多选后点「删除所选」。全选 / 清空只作用于当前筛选看得到的轮次
  function buildFilterPanel(rounds, on, onChange, onApply, onRemove, onTree) {
    const node = el('div', { className: 'dialog-map-filter' });
    node.style.cssText = 'position:absolute;top:0;right:0;width:300px;height:100%;background:var(--panel-solid);border-left:1px solid var(--border);'
      + 'display:flex;flex-direction:column;z-index:3;box-shadow:var(--shadow);';
    const hint = el('div', { textContent: text('勾选的轮次塞给 AI，没勾的不发。按住左键拖过列表可连续勾选/取消。可多选后点「删除所选」同时删除对应聊天记录和上下文。取消勾选仅不发给 AI，聊天仍保留。点「应用」才保存；不点应用直接关掉就不改。', 'Checked rounds are sent to AI; unchecked rounds are omitted. Hold the left mouse button and drag across the list to check or uncheck multiple rounds. Choose “Delete selected” to delete the matching chat history and context. Unchecking only excludes a round from AI context and keeps the chat. Changes are saved only when you click “Apply”; closing without applying discards them.') });
    hint.style.cssText = 'padding:8px 10px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);line-height:1.5;';
    node.appendChild(hint);

    const bar = el('div');
    bar.style.cssText = 'display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;';
    let mode = 'all';
    const modeBox = el('div');
    modeBox.style.cssText = 'display:flex;border:1px solid var(--border);border-radius:var(--sub-r);overflow:hidden;';
    const modeBtns = [['all', text('全部', 'All')], ['on', text('适用', 'Applicable')], ['off', text('不适用', 'Not applicable')]].map(([id, label]) => {
      const b = el('button', { textContent: label });
      b.onclick = () => { mode = id; paintModes(); renderList(); };
      modeBox.appendChild(b);
      return [id, b];
    });
    function paintModes() {
      for (const [id, b] of modeBtns) {
        b.style.cssText = 'border:0;padding:3px 8px;cursor:pointer;font-size:12px;'
          + (id === mode ? 'background:var(--primary-bg);color:var(--primary-fg);' : 'background:var(--map-button-bg,var(--btn-bg));color:inherit;');
      }
    }
    paintModes();
    bar.appendChild(modeBox);
    // 筛选按已保存的状态分，勾选中途改动不会让行跳走
    const visible = (r) => mode === 'all' || (mode === 'on' ? !r.skip : r.skip);
    const selAll = el('button', { textContent: text('全选', 'Select all') });
    selAll.style.cssText = btnCss;
    const clearAll = el('button', { textContent: text('清空', 'Clear') });
    clearAll.style.cssText = btnCss;
    const delSel = el('button', { textContent: text('删除所选', 'Delete selected') });
    delSel.title = text('同时删除当前勾选轮次的聊天记录和上下文', 'Delete checked rounds from both chat history and context');
    delSel.style.cssText = btnCss;
    const apply = el('button', { textContent: text('应用', 'Apply') });
    apply.style.cssText = 'margin-left:auto;border:1px solid var(--border);background:var(--primary-bg);color:var(--primary-fg);border-radius:var(--sub-r);padding:3px 10px;cursor:pointer;font-size:12px;';
    bar.appendChild(selAll);
    bar.appendChild(clearAll);
    bar.appendChild(delSel);
    bar.appendChild(apply);
    node.appendChild(bar);

    const list = el('div');
    list.style.cssText = 'flex:1;overflow:auto;padding:8px 10px;font-size:12px;user-select:none;';
    node.appendChild(list);

    let how = planOf(rounds, on);
    // 按住拖选：按下那一行取反作为画笔，拖过的行刷成同一状态；拖选中不重绘列表，只刷新左边导图
    let dragPaint = null;
    function paintRow(row, r, want) {
      const had = on.has(r.n);
      if (want) on.add(r.n); else on.delete(r.n);
      const chk = row.querySelector('input[type="checkbox"]');
      if (chk) chk.checked = want;
      const text = row.querySelector('[data-round-text]');
      if (text) text.style.color = want ? '' : 'var(--muted)';
      const tag = row.querySelector('[data-round-tag]');
      if (tag) {
        tag.textContent = howLabel(want ? 'title' : 'off');
        tag.style.cssText = 'font-size:10px;padding:0 5px;border-radius:var(--sub-r);border:1px solid var(--border);'
          + (want ? 'color:var(--accent);border-color:var(--accent);' : 'color:var(--muted);');
      }
      return had !== want;
    }
    function endDrag() {
      if (dragPaint === null) return;
      dragPaint = null;
      how = planOf(rounds, on);
      if (typeof onTree === 'function') onTree();
    }
    window.addEventListener('mouseup', endDrag);
    list.addEventListener('mouseleave', () => { /* 拖出列表不结束，松手才结束 */ });

    function renderList() {
      const keep = list.scrollTop;
      list.innerHTML = '';
      // 最新的轮次排在最上面
      for (const r of [...rounds].reverse()) {
        if (!visible(r)) continue;
        const row = el('div');
        row.dataset.round = String(r.n);
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:default;';
        const lab = el('div');
        lab.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;min-width:0;cursor:pointer;';
        const chk = el('input', { type: 'checkbox' });
        chk.checked = on.has(r.n);
        chk.tabIndex = -1;
        // 勾选改走拖选 / 按下，避免和拖选抢 change
        chk.addEventListener('click', (e) => e.preventDefault());
        const rowText = el('span', { textContent: `R${r.n} ${r.title}` });
        rowText.dataset.roundText = '1';
        rowText.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (on.has(r.n) ? '' : 'color:var(--muted);');
        const h = how.get(r.n);
        const tag = el('span', { textContent: howLabel(h) });
        tag.dataset.roundTag = '1';
        tag.style.cssText = 'font-size:10px;padding:0 5px;border-radius:var(--sub-r);border:1px solid var(--border);'
          + (h === 'title' ? 'color:var(--accent);border-color:var(--accent);' : 'color:var(--muted);');
        const del = el('button', { type: 'button', textContent: text('删', 'Del') });
        del.title = text('从上下文删除这一轮', 'Remove this round from context');
        del.style.cssText = 'border:0;background:none;color:var(--muted);cursor:pointer;font-size:12px;padding:0 2px;';
        del.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (onRemove) onRemove([r.n]); };
        function hitPaint(want) {
          if (paintRow(row, r, want) || dragPaint !== null) {
            how = planOf(rounds, on);
            if (typeof onTree === 'function') onTree();
            else onChange();
          }
        }
        lab.onmousedown = (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          dragPaint = !on.has(r.n);
          hitPaint(dragPaint);
        };
        lab.onmouseenter = () => {
          if (dragPaint === null) return;
          hitPaint(dragPaint);
        };
        lab.appendChild(chk);
        lab.appendChild(rowText);
        lab.appendChild(tag);
        row.appendChild(lab);
        row.appendChild(del);
        list.appendChild(row);
      }
      list.scrollTop = keep;
    }
    selAll.onclick = () => { for (const r of rounds) if (visible(r)) on.add(r.n); onChange(); };
    clearAll.onclick = () => { for (const r of rounds) if (visible(r)) on.delete(r.n); onChange(); };
    delSel.onclick = () => {
      const ns = rounds.filter((r) => visible(r) && on.has(r.n)).map((r) => r.n);
      if (!ns.length) { alert(text('先勾选要删的轮次', 'Select the rounds to delete first')); return; }
      if (onRemove) onRemove(ns);
    };
    apply.onclick = async () => {
      if (apply.disabled) return;
      const label = text('应用', 'Apply');
      apply.disabled = true;
      try {
        const result = onApply ? await onApply() : true;
        if (result === false) return;
        apply.textContent = text('已应用', 'Applied');
        setTimeout(() => {
          if (apply.isConnected) apply.textContent = label;
        }, 1400);
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
      } finally {
        apply.disabled = false;
      }
    };
    const _disposePanel = node._dispose;
    node._dispose = () => {
      window.removeEventListener('mouseup', endDrag);
      if (_disposePanel) _disposePanel();
    };
    renderList();
    return {
      node,
      refresh(nextHow) {
        how = nextHow;
        renderList();
      }
    };
  }

  // 横向树：根 → 标题支 → 轮次（超过 10 轮每 10 轮一组）。拖动平移、滚轮缩放、点轮次弹出发出去的标题和原文预览
  function drawTree(canvas, rootTitle, onPick) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    let textColor, muted, accent, panelBg, hoverBg;
    const ROW = 30;
    const COL = 200;
    let nodes = [];
    let links = [];
    let root = null;
    let scale = 1;
    let ox = 40;
    let oy = 0;

    function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

    function setData(rounds, how) {
      nodes = [];
      links = [];
      root = { label: clip(rootTitle, 24), x: 0, y: 0, kind: 'root' };
      nodes.push(root);
      let row = 0;
      function leafCol(col, list) {
        const first = row;
        const leaves = list.map((r) => {
          const leaf = { label: clip(`R${r.n} ${r.title}`, 26), x: col, y: row * ROW, kind: 'leaf', how: (how && how.get(r.n)) || 'title', round: r };
          row += 1;
          nodes.push(leaf);
          return leaf;
        });
        return { leaves, y: ((first + row - 1) / 2) * ROW };
      }
      let branch;
      const branchHow = rounds.some((r) => how && how.get(r.n) === 'title') ? 'title' : 'off';
      if (!rounds.length) {
        branch = { label: text('没有上下文会塞给 AI', 'No context will be sent to AI'), x: COL, y: 0, kind: 'empty', how: 'off' };
        nodes.push(branch);
      } else if (rounds.length <= GROUP_SIZE) {
        const part = leafCol(COL * 2, rounds);
        branch = { label: text(`轮次（${rounds.length} 轮）`, `Rounds (${rounds.length})`), x: COL, y: part.y, kind: 'branch', how: branchHow };
        nodes.push(branch);
        for (const leaf of part.leaves) links.push([branch, leaf]);
      } else {
        const groups = [];
        for (let g = 0; g * GROUP_SIZE < rounds.length; g++) {
          const list = rounds.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE);
          const part = leafCol(COL * 3, list);
          const grp = { label: `R${list[0].n}-R${list[list.length - 1].n}`, x: COL * 2, y: part.y, kind: 'group', how: branchHow };
          nodes.push(grp);
          for (const leaf of part.leaves) links.push([grp, leaf]);
          groups.push(grp);
          row += 0.4;
        }
        branch = { label: text(`轮次（${rounds.length} 轮）`, `Rounds (${rounds.length})`), x: COL, y: groups.reduce((s, g) => s + g.y, 0) / groups.length, kind: 'branch', how: branchHow };
        nodes.push(branch);
        for (const g of groups) links.push([branch, g]);
      }
      // 根标题长度不固定；固定 COL 会让长标题和分支节点压在一起。把整棵子树
      // 一起向右移，给根节点留出完整宽度和间距，同时保持后续列之间的距离不变。
      const branchX = Math.max(COL, boxOf(root).w + 36);
      const shiftX = branchX - COL;
      for (const node of nodes) {
        if (node !== root) node.x += shiftX;
      }
      root.y = branch.y;
      links.push([root, branch]);
      console.log('[上下文应用诊断] 导图数据已更新', { roundCount: rounds.length, nodeCount: nodes.length, linkCount: links.length });
      fitToData();
      console.log('[上下文应用诊断] 开始重绘');
      redraw();
      console.log('[上下文应用诊断] 重绘是否发生', true);
      console.log('[上下文应用诊断] 重绘完成');
    }

    function colorOf(n) {
      if (n.how === 'title') return accent;
      if (n.how === 'off') return muted;
      return textColor;
    }
    function boxOf(n) {
      ctx.font = (n.kind === 'leaf' ? '12px' : '600 13px') + ' sans-serif';
      const w = ctx.measureText(n.label).width + 20;
      const h = n.kind === 'empty' ? 30 : 22;
      return { x: n.x, y: n.y - h / 2, w, h };
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      if (root && nodes.length) fitToData();
      redraw();
    }
    function fitToData() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || !nodes.length) return;
      const boxes = nodes.map(boxOf);
      const minX = Math.min(...boxes.map((b) => b.x));
      const maxX = Math.max(...boxes.map((b) => b.x + b.w));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxY = Math.max(...boxes.map((b) => b.y + b.h));
      const contentWidth = Math.max(1, maxX - minX);
      const contentHeight = Math.max(1, maxY - minY);
      // 右侧筛选面板覆盖画布，按左侧约 72% 的可视宽度适配。
      const availableWidth = rect.width * 0.72;
      const padding = 36;
      scale = Math.min(1.4, Math.max(0.25,
        Math.min((availableWidth - padding * 2) / contentWidth, (rect.height - padding * 2) / contentHeight)));
      ox = (availableWidth - contentWidth * scale) / 2 - minX * scale;
      oy = (rect.height - contentHeight * scale) / 2 - minY * scale;
    }
    function redraw() {
      const theme = getComputedStyle(document.documentElement);
      textColor = theme.getPropertyValue('--text').trim();
      muted = theme.getPropertyValue('--muted').trim();
      accent = theme.getPropertyValue('--accent').trim();
      panelBg = theme.getPropertyValue('--panel-solid').trim();
      hoverBg = theme.getPropertyValue('--hover').trim();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      ctx.lineWidth = 1.2;
      for (const [a, b] of links) {
        const sx = a.x + boxOf(a).w;
        const ex = b.x;
        ctx.strokeStyle = colorOf(b);
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(sx, a.y);
        ctx.bezierCurveTo((sx + ex) / 2, a.y, (sx + ex) / 2, b.y, ex, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (const n of nodes) {
        const bx = boxOf(n);
        ctx.fillStyle = n.kind === 'empty' ? hoverBg : panelBg;
        ctx.strokeStyle = colorOf(n);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx.x, bx.y, bx.w, bx.h, 6); else ctx.rect(bx.x, bx.y, bx.w, bx.h);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label, bx.x + 10, n.y);
      }
    }
    function toWorld(mx, my) { return { x: (mx - ox) / scale, y: (my - oy) / scale }; }
    function leafAt(mx, my) {
      const p = toWorld(mx, my);
      for (const n of nodes) {
        if (n.kind !== 'leaf') continue;
        const b = boxOf(n);
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return n;
      }
      return null;
    }
    let drag = null;
    canvas.addEventListener('mousedown', (e) => {
      const r = canvas.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, ox, oy, moved: false, mx: e.clientX - r.left, my: e.clientY - r.top };
      canvas.style.cursor = 'grabbing';
    });
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      ox = drag.ox + dx;
      oy = drag.oy + dy;
      redraw();
    };
    const onUp = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      canvas.style.cursor = 'grab';
      if (d.moved) return;
      const hit = leafAt(d.mx, d.my);
      if (hit) onPick(hit.round, hit.how, d.mx, d.my);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const before = toWorld(mx, my);
      scale = Math.min(3, Math.max(0.25, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      ox = mx - before.x * scale;
      oy = my - before.y * scale;
      redraw();
    }, { passive: false });
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const themeObserver = new MutationObserver(redraw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return {
      setData,
      dispose() {
        themeObserver.disconnect();
        ro.disconnect();
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
    };
  }

  window.DialogMap = { open, close };
})();

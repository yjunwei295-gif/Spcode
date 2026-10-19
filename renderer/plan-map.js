// 方案导图：根是需求，下面每条方案一个节点，按程序核对 / 验收的状态着色。执行中后台每改一次状态就推一次，开着时实时刷新。
// 和项目地图、对话导图分开，不共用节点或样式名。
(function () {
  const STATUS_COLOR = {
    待核对: 'var(--muted)',
    可开工: 'var(--success)',
    不一致: 'var(--danger)',
    进行中: 'var(--warning)',
    通过: 'var(--success)',
    退回: 'var(--danger)'
  };
  const btnCss = 'border:1px solid var(--border);background:var(--map-button-bg,var(--btn-bg));border-radius:var(--sub-r);padding:3px 8px;cursor:pointer;font-size:12px;color:inherit;';

  function el(tag, props) {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    if (tag === 'button') n.classList.add('map-button');
    return n;
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  let current = null;

  function close() {
    const modal = document.getElementById('plan-map-modal');
    if (!modal) return;
    if (modal._dispose) modal._dispose();
    modal.remove();
    current = null;
  }

  /** opts: { title, map: { nodes:[{ id, desc, status, file, reason }], edges } } */
  function open(opts) {
    close();
    const workspace = opts.workspace;
    const tabId = opts.tabId;
    const locked = !!opts.locked;
    const modal = el('div', { id: 'plan-map-modal', className: 'map-modal' });
    modal.style.cssText = 'position:fixed;inset:0;z-index:91;background:var(--overlay);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';
    const card = el('div');
    card.style.cssText = 'position:relative;width:min(94vw,1120px);height:min(88vh,840px);background:var(--panel-solid);border:1px solid var(--border);'
      + 'border-radius:var(--sub-r-lg);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow);';
    const head = el('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);';
    const title = el('span', { textContent: `方案导图 · ${opts.title || ''}` });
    title.style.cssText = 'font-size:14px;font-weight:600;';
    const legend = el('div');
    legend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--muted);margin-left:auto;';
    for (const [name, color] of Object.entries(STATUS_COLOR)) {
      const s = el('span', { textContent: name });
      s.style.cssText = `border-left:8px solid ${color};padding-left:4px;`;
      legend.appendChild(s);
    }
    const x = el('button', { textContent: '×' });
    x.style.cssText = 'border:0;background:none;font-size:20px;cursor:pointer;color:var(--muted);';
    x.onclick = close;
    head.appendChild(title);
    head.appendChild(legend);
    head.appendChild(x);

    const body = el('div');
    body.style.cssText = 'position:relative;flex:1;display:flex;overflow:hidden;';
    const canvasWrap = el('div');
    canvasWrap.style.cssText = 'position:relative;flex:1;overflow:hidden;';
    const canvas = el('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;';
    canvasWrap.appendChild(canvas);
    const side = el('div');
    side.style.cssText = 'width:320px;border-left:1px solid var(--border);overflow:auto;padding:8px 10px;font-size:12px;';
    body.appendChild(canvasWrap);
    body.appendChild(side);
    card.appendChild(head);
    card.appendChild(body);
    modal.appendChild(card);
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);

    let popover = null;
    function hidePopover() { if (popover) { popover.remove(); popover = null; } }
    function showDetail(n, sx, sy) {
      hidePopover();
      popover = el('div');
      popover.style.cssText = 'position:absolute;z-index:4;width:340px;background:var(--panel-solid);border:1px solid var(--border);border-radius:var(--sub-r);'
        + 'box-shadow:var(--shadow);padding:10px 12px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;';
      popover.style.left = Math.max(8, Math.min(sx + 12, canvasWrap.clientWidth - 360)) + 'px';
      popover.style.top = Math.max(8, Math.min(sy + 12, canvasWrap.clientHeight - 160)) + 'px';
      const color = STATUS_COLOR[n.status] || 'var(--muted)';
      popover.textContent = [`${n.id}`, `状态：${n.status || '—'}`, n.file ? `文件：${n.file}` : '', n.reason ? `说明：${n.reason}` : ''].filter(Boolean).join('\n');
      popover.style.borderLeft = `4px solid ${color}`;
      canvasWrap.appendChild(popover);
    }
    canvas.addEventListener('mousedown', hidePopover);

    const view = drawTree(canvas, (n, sx, sy) => showDetail(n, sx, sy));
    function removeItem(n) {
      if (!confirm(`确认删除方案「${n.id}」？删除后无法恢复。`)) return;
      const api = window.simple || window.sinpo;
      if (!api || typeof api.planRemoveItem !== 'function') {
        alert('当前环境不支持删除操作');
        return;
      }
      Promise.resolve(api.planRemoveItem({ workspace, tabId, no: n.no }))
        .then((res) => {
          if (!res) return;
          if (res.notFound) { alert('未找到该方案，可能已被删除'); return; }
          if (res.map) update(res.map);
        })
        .catch(() => { alert('删除失败，请稍后重试'); });
    }
    function renderSide(map) {
      side.innerHTML = '';
      const items = (map.nodes || []).filter((n) => n.id !== '需求');
      const count = {};
      for (const n of items) count[n.status] = (count[n.status] || 0) + 1;
      const sum = el('div', { textContent: `共 ${items.length} 条 · ` + Object.entries(count).map(([k, v]) => `${k} ${v}`).join(' · ') });
      sum.style.cssText = 'color:var(--muted);margin-bottom:8px;';
      side.appendChild(sum);
      for (const n of items) {
        const row = el('div');
        row.style.cssText = `border-left:4px solid ${STATUS_COLOR[n.status] || 'var(--border)'};padding:4px 8px;margin-bottom:6px;background:var(--hover);border-radius:var(--sub-r);cursor:pointer;`;
        const top = el('div');
        top.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const t = el('div', { textContent: `${n.id}` });
        t.style.cssText = 'font-weight:600;flex:1;min-width:0;';
        // 每条右侧放删除按钮，点击 confirm 后按 no 调后端删除
        const del = el('button', { textContent: '×', title: '删除该条方案' });
        del.style.cssText = 'border:1px solid var(--border);background:transparent;border-radius:var(--sub-r);width:20px;height:20px;'
          + 'line-height:1;font-size:14px;cursor:pointer;color:var(--muted);flex:none;padding:0;';
        del.onclick = (e) => { e.stopPropagation(); removeItem(n); };
        top.appendChild(t);
        top.appendChild(del);
        const s = el('div', { textContent: `${n.status || ''}${n.reason ? ' · ' + n.reason : ''}` });
        s.style.cssText = 'color:var(--muted);';
        row.appendChild(top);
        row.appendChild(s);
        row.onclick = () => showDetail(n, 40, 40);
        side.appendChild(row);
      }
    }
    function update(map) {
      if (!map) return;
      view.setData(map);
      renderSide(map);
    }
    modal._dispose = () => {
      view.dispose();
      document.removeEventListener('keydown', onEsc);
    };
    current = { update };
    update(opts.map);
  }

  function update(map) { if (current) current.update(map); }
  function isOpen() { return !!current; }

  // 横向树：根（需求）→ 各条方案。拖动平移、滚轮缩放、点节点看详情
  function drawTree(canvas, onPick) {
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    let textColor, muted, panelBg;
    let statusColors = {};
    const ROW = 34;
    const COL = 220;
    let nodes = [];
    let links = [];
    let scale = 1;
    let ox = 40;
    let oy = 0;
    let placed = false;
    let rootY = 0;

    function setData(map) {
      const items = (map.nodes || []).filter((n) => n.id !== '需求');
      nodes = [];
      links = [];
      const root = { label: '需求', x: 0, y: 0, kind: 'root', data: (map.nodes || []).find((n) => n.id === '需求') || { id: '需求' } };
      items.forEach((n, i) => {
        const leaf = { label: clip(n.id, 30), x: COL, y: i * ROW, kind: 'leaf', data: n };
        nodes.push(leaf);
        links.push([root, leaf]);
      });
      root.y = items.length ? ((items.length - 1) * ROW) / 2 : 0;
      rootY = root.y;
      nodes.unshift(root);
      if (!placed) {
        const r = canvas.getBoundingClientRect();
        if (r.height) { oy = r.height / 2 - rootY; placed = true; }
      }
      redraw();
    }
    function colorOf(n) { return statusColors[n.data && n.data.status] || muted; }
    function boxOf(n) {
      ctx.font = (n.kind === 'leaf' ? '12px' : '600 13px') + ' sans-serif';
      return { x: n.x, y: n.y - 12, w: ctx.measureText(n.label).width + 24, h: 24 };
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      if (!placed && r.height && nodes.length) { oy = r.height / 2 - rootY; placed = true; }
      redraw();
    }
    function redraw() {
      const theme = getComputedStyle(document.documentElement);
      textColor = theme.getPropertyValue('--text').trim();
      muted = theme.getPropertyValue('--muted').trim();
      panelBg = theme.getPropertyValue('--panel-solid').trim();
      statusColors = Object.fromEntries(Object.entries(STATUS_COLOR).map(([status, color]) =>
        [status, theme.getPropertyValue(color.slice(4, -1)).trim()]));
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
        ctx.fillStyle = panelBg;
        ctx.strokeStyle = n.kind === 'root' ? textColor : colorOf(n);
        ctx.lineWidth = n.kind === 'root' ? 1.2 : 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx.x, bx.y, bx.w, bx.h, 6); else ctx.rect(bx.x, bx.y, bx.w, bx.h);
        ctx.fill();
        ctx.stroke();
        if (n.kind === 'leaf') {
          ctx.fillStyle = colorOf(n);
          ctx.beginPath();
          ctx.arc(bx.x + 9, n.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = textColor;
        ctx.textBaseline = 'middle';
        ctx.fillText(n.label, bx.x + (n.kind === 'leaf' ? 18 : 12), n.y);
      }
    }
    function toWorld(mx, my) { return { x: (mx - ox) / scale, y: (my - oy) / scale }; }
    function nodeAt(mx, my) {
      const p = toWorld(mx, my);
      for (const n of nodes) {
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
      const hit = nodeAt(d.mx, d.my);
      if (hit) onPick(hit.data, d.mx, d.my);
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

  window.PlanMap = { open, close, update, isOpen };
})();

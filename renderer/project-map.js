// 项目地图：绘制与查看（canvas 思维导图布局）
// 独立于 app.js，自行在设置里的「项目地图」卡片挂按钮，并在绘制完成后自动弹出画布。
// 布局：思维导图。骨架 = 目录树（根在左，向右逐层展开；目录是分支节点、文件是叶子），
//   每层横向间距按该层最长文件名自适应，长名字不会压进下一层；纵向叶子逐行均摊、目录取子节点中点。
//   import 依赖以虚线贝塞尔曲线叠加在骨架上。布局一次同步算完（无动画、无物理模拟），
//   首次显示自动缩放居中让整图适配可视范围。
// 节点直接显示模块名（文件名），同目录同色便于识别归属；依赖线未选择时为虚线、选择后变实线（选中相关高亮）。
// 交互：点空白取消选中；拖动任意节点时，与之相连的邻居一起跟随平移（预览），松手所有节点回弹到布局原位；
//  滚轮缩放、拖拽空白平移；悬停任意节点显示完整路径；点节点弹出归纳漂浮窗（方法名+关键值+说明）；
//  目录分支节点仅作展示，不可点选。
// 「筛选」面板用白名单方式勾选要显示的模块。
// 绘制遮罩：布局计算 / 首次空地图期间，整界面盖一层全屏「正在生成项目地图…」遮罩，完成才展示，避免看到半成品。
// 白名单规则：只有勾选（include）的模块才会显示在地图；首次进入未勾选任何模块时自动弹出筛选面板，
//  勾选并应用后持久化并自动对该模块做 AI 方法归纳，后续进入只显示并只归纳勾选的模块。
// 老用户已有的 excludes（黑名单）会在首次读取时自动迁移成 includes。
(function () {
  const api = window.simple;
  if (!api) return;

  let pendingOpen = false;
  let observer = null;

  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    if (children) (Array.isArray(children) ? children : [children]).forEach((c) =>
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 白名单过滤：只保留 include.includes 集合里的节点；未初始化(initialized=false)时返回空地图（需先勾选）
  function applyIncludes(map, include) {
    if (!include || !include.initialized) return Object.assign({}, map, { nodes: [], edges: [] });
    const set = new Set(include.includes || []);
    const nodes = (map.nodes || []).filter((n) => set.has(n.id));
    const keep = new Set(nodes.map((n) => n.id));
    const edges = (map.edges || []).filter((e) => keep.has(e.from) && keep.has(e.to));
    return Object.assign({}, map, { nodes, edges });
  }

  // 构建筛选侧边面板：目录树统计 + 文件勾选 + 仅显示未引用 + 全选/清空
  // 白名单语义：勾选 = 该模块显示在地图；未勾选 = 不显示
  function buildFilterPanel(map, include, onApply) {
    const panel = el('div', { className: 'map-filter' });
    panel.style.cssText =
      'position:absolute;top:0;right:0;width:320px;height:100%;background:var(--panel);' +
      'border-left:1px solid var(--border);display:flex;flex-direction:column;z-index:3;box-shadow:-4px 0 12px rgba(0,0,0,0.12);';

    const hint = el('div');
    hint.style.cssText = 'padding:8px 10px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);line-height:1.5;';
    hint.textContent = '白名单：勾选的模块才会显示在地图，未勾选的不显示。「应用显示」后持久化并自动归纳方法。';
    panel.appendChild(hint);

    // 计算每个节点的入度（被多少边指向），入度为 0 即疑似孤立/未引用
    const inDeg = {};
    for (const e of (map.edges || [])) inDeg[e.to] = (inDeg[e.to] || 0) + 1;

    // 按目录聚合：目录 -> 节点数组
    const dirMap = new Map();
    for (const n of (map.nodes || [])) {
      const parts = n.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(根目录)';
      if (!dirMap.has(dir)) dirMap.set(dir, []);
      dirMap.get(dir).push(n);
    }

    const checked = new Set(include.includes || []);
    const list = el('div');
    list.style.cssText = 'flex:1;overflow:auto;padding:8px 10px;font-size:12px;';

    const bar = el('div');
    bar.style.cssText = 'display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center;';

    const onlyUnref = el('label');
    onlyUnref.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;';
    const onlyChk = el('input', { type: 'checkbox' });
    onlyUnref.appendChild(onlyChk);
    onlyUnref.appendChild(document.createTextNode('仅显示未引用'));
    bar.appendChild(onlyUnref);

    const selAll = el('button', { textContent: '全选' });
    selAll.style.cssText = 'border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;';
    bar.appendChild(selAll);

    const clearAll = el('button', { textContent: '清空' });
    clearAll.style.cssText = 'border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;';
    bar.appendChild(clearAll);

    const applyBtn = el('button', { textContent: '应用显示' });
    applyBtn.style.cssText = 'margin-left:auto;border:1px solid var(--border);background:var(--accent);color:var(--accent-fg);border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;';
    bar.appendChild(applyBtn);

    panel.appendChild(bar);
    panel.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      const only = onlyChk.checked;
      for (const [dir, items] of dirMap) {
        const visItems = only ? items.filter((n) => !inDeg[n.id]) : items;
        if (!visItems.length) continue;
        const grp = el('div');
        grp.style.cssText = 'margin-bottom:6px;';
        const head = el('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:600;margin:4px 0;';
        const grpChk = el('input', { type: 'checkbox' });
        grpChk.checked = visItems.every((n) => checked.has(n.id));
        grpChk.onchange = () => {
          for (const n of visItems) { if (grpChk.checked) checked.add(n.id); else checked.delete(n.id); }
          renderList();
        };
        head.appendChild(grpChk);
        head.appendChild(document.createTextNode(dir + ' (' + visItems.length + ')'));
        grp.appendChild(head);
        for (const n of visItems) {
          const row = el('label');
          row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0 2px 18px;cursor:pointer;';
          const chk = el('input', { type: 'checkbox' });
          chk.checked = checked.has(n.id);
          chk.onchange = () => { if (chk.checked) checked.add(n.id); else checked.delete(n.id); };
          row.appendChild(chk);
          const name = (n.path.split('/').pop() || n.path);
          row.appendChild(document.createTextNode(name));
          if (!inDeg[n.id]) {
            const tag = el('span');
            tag.textContent = '未引用';
            tag.style.cssText = 'color:var(--muted);font-size:10px;margin-left:4px;';
            row.appendChild(tag);
          }
          grp.appendChild(row);
        }
        list.appendChild(grp);
      }
    }

    onlyChk.onchange = renderList;
    selAll.onclick = () => {
      for (const n of (map.nodes || [])) {
        if (onlyChk.checked && inDeg[n.id]) continue;
        checked.add(n.id);
      }
      renderList();
    };
    clearAll.onclick = () => { checked.clear(); renderList(); };
    applyBtn.onclick = () => { onApply(Array.from(checked)); };

    renderList();
    return panel;
  }

  async function openMapModal() {
    let map = null;
    try { map = await api.indexGetMap(); } catch (e) { map = null; }
    if (!map || !Array.isArray(map.nodes) || !map.nodes.length) {
      alert('还没有项目地图，请先点击「绘制项目地图」。');
      return;
    }
    let include = { initialized: false, includes: [] };
    try { include = await api.indexGetInclude() || include; } catch (_) {}
    showCanvas(map, include);
    try { if (api.indexSummarize) api.indexSummarize().catch(() => {}); } catch (_) {}
  }

  function showCanvas(map, include) {
    let modal = document.getElementById('map-modal');
    if (!modal) {
      modal = el('div', { id: 'map-modal', className: 'hidden' });
      modal.style.cssText =
        'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
      document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.innerHTML = '';

    const card = el('div', { className: 'map-card' });
    card.style.cssText =
      'position:relative;width:min(94vw,1120px);height:min(88vh,840px);background:var(--panel);border:1px solid var(--border);' +
      'border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow);';

    const head = el('div', { className: 'map-head' });
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);';
    const title = el('span');
    title.style.cssText = 'font-size:14px;font-weight:600;';

    const close = el('button', { textContent: '×' });
    close.style.cssText = 'border:0;background:none;font-size:20px;cursor:pointer;color:var(--muted);';

    const filterBtn = el('button', { textContent: '筛选' });
    filterBtn.style.cssText = 'margin-right:10px;border:1px solid var(--border);background:var(--hover);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:12px;';

    const headRight = el('div');
    headRight.style.cssText = 'display:flex;align-items:center;';
    headRight.appendChild(filterBtn);
    headRight.appendChild(close);

    head.appendChild(title);
    head.appendChild(headRight);
    card.appendChild(head);
    modal.appendChild(card);

    // 画布：铺满卡片 head 以下区域，目录骨架、依赖曲线、节点与标签全部由 canvas 自绘
    const canvas = el('canvas', { className: 'map-canvas' });
    canvas.style.cssText = 'flex:1;display:block;width:100%;min-height:0;';
    card.appendChild(canvas);

    // 绘制 / 归纳期间遮罩：盖住画布，完成后才展示，避免看到半成品
    const overlay = el('div', { className: 'map-overlay' });
    overlay.style.cssText =
      'position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;' +
      'background:var(--bg);color:var(--muted);font-size:13px;letter-spacing:.5px;';
    overlay.textContent = '正在生成项目地图…';
    card.appendChild(overlay);

    let drawCleanup = null;
    let currentMap = include && include.initialized ? applyIncludes(map, include) : Object.assign({}, map, { nodes: [], edges: [] });
    let filterPanel = null;
    let activePopover = null;
    let activePopoverNode = null;
    let offProgress = null;
    let legend = null;

    // 全屏遮罩：绘制 / 布局计算期间盖住整个界面，完成才露出 viewer（避免看到半成品）
    const fullMask = el('div', { className: 'map-fullmask' });
    fullMask.style.cssText =
      'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
      'background:var(--bg);color:var(--muted);font-size:14px;letter-spacing:1px;';
    fullMask.textContent = '正在生成项目地图…';
    document.body.appendChild(fullMask);

    function updateTitle(m) {
      if (!m || !m.nodes || !m.nodes.length) {
        title.textContent = '项目地图 · 请点击右上「筛选」勾选要显示的模块';
        return;
      }

      title.textContent = '项目地图 · 共 ' + m.nodes.length + ' 个模块 · ' + m.edges.length +
        ' 条连接' +
        ' · 思维导图布局；悬停看路径，点击节点看归纳，滚轮缩放；拖动节点会带动相连邻居，松手回原位';
    }
    // 连线图例：只列当前地图里真实出现的关系类型，颜色与画布一致
    function renderLegend(m) {
      if (legend) { legend.remove(); legend = null; }
      const kinds = new Set((m && m.edges ? m.edges : []).map((e) => e.kind || 'ref'));
      if (!kinds.size) return;
      legend = el('div', { className: 'map-legend' });
      legend.style.cssText =
        'position:absolute;right:12px;bottom:12px;z-index:5;background:var(--panel);' +
        'border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);' +
        'padding:8px 10px;font-size:11px;line-height:1.7;pointer-events:none;';
      const t = el('div');
      t.style.cssText = 'font-weight:600;margin-bottom:4px;';
      t.textContent = '连线含义';
      legend.appendChild(t);
      for (const key of ['ref', 'dep', 'implicit', 'include']) {
        if (!kinds.has(key)) continue;
        const s = EDGE_STYLE[key];
        const row = el('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const bar = el('span');
        bar.style.cssText = 'width:18px;height:0;border-top:2px solid rgb(' + s.color + ');flex:none;';
        const txt = el('span');
        txt.textContent = s.label + ' · ' + s.hint;
        row.appendChild(bar);
        row.appendChild(txt);
        legend.appendChild(row);
      }
      card.appendChild(legend);
    }

    function relayout(m) {
      if (drawCleanup) { drawCleanup(); drawCleanup = null; }
      const hasNodes = m && m.nodes && m.nodes.length > 0;
      overlay.style.display = hasNodes ? 'flex' : 'none';
      drawCleanup = drawMap(canvas, m, () => {
        overlay.style.display = 'none';
        if (fullMask && fullMask.parentNode) fullMask.parentNode.removeChild(fullMask);
      }, (n) => renderPopover(n));
      updateTitle(m);
      renderLegend(m);
    }

    // 点击节点后弹出的归纳漂浮窗（方法名 + 作用 + 关键值）
    const explainTried = new Set();
    const explainingIds = new Set();
    function hasStoredExplain(n) {
      return !!(n && n.methodsMtime != null && n.methodsMtime === n.mtime && Array.isArray(n.methods));
    }
    function kickExplain(node) {
      if (!node || !node.id || explainTried.has(node.id) || hasStoredExplain(node)) return;
      explainTried.add(node.id);
      explainingIds.add(node.id);
      const id = node.id;
      const done = (res) => {
        explainingIds.delete(id);
        if (res && res.ok) applyNodeMethods(id, res);
        else if (activePopoverNode && activePopoverNode.id === id) {
          activePopoverNode._explainError = (res && res.reason === 'no-model') ? '未设置当前模型，无法归纳' : '归纳失败';
          renderPopover(activePopoverNode);
        }
      };
      try {
        if (!api.indexSummarizeOne) { done({ ok: false }); return; }
        api.indexSummarizeOne(id).then(done).catch(() => done({ ok: false }));
      } catch (_) { done({ ok: false }); }
    }
    function renderPopover(node) {
      activePopoverNode = node || null;
      if (activePopover) { activePopover.remove(); activePopover = null; }
      if (!node) return;
      if (!hasStoredExplain(node) && !explainTried.has(node.id)) explainingIds.add(node.id);
      const methods = mergeMethods(node);
      const pop = el('div', { className: 'map-popover' });
      pop.style.cssText = 'position:absolute;right:12px;top:54px;z-index:6;width:300px;max-height:62%;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:10px 12px;font-size:12px;line-height:1.55;';
      const h = el('div');
      h.style.cssText = 'font-weight:600;margin-bottom:6px;word-break:break-all;';
      h.textContent = node.path;
      pop.appendChild(h);
      if (!methods.length) {
        const tip = el('div');
        tip.style.cssText = 'color:var(--muted);';
        tip.textContent = '该模块未解析出方法（非源码文件，或正在归纳中）。';
        pop.appendChild(tip);
      } else {
        for (const m of methods) {
          const item = el('div');
          item.style.cssText = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px dashed var(--border);';
          const name = el('div');
          name.style.cssText = 'font-weight:600;color:var(--accent);';
          name.textContent = m.name || '(未命名)';
          item.appendChild(name);
          const pending = explainingIds.has(node.id) && !m.desc;
          const kv = el('div');
          kv.style.cssText = 'margin-top:2px;';
          kv.textContent = '关键值：' + (m.keyValues || (pending ? '正在归纳…' : '—'));
          item.appendChild(kv);
          const ds = el('div');
          ds.style.cssText = 'margin-top:2px;color:var(--muted);';
          ds.textContent = '作用：' + (m.desc || (pending ? '正在归纳…' : (node._explainError || '—')));
          item.appendChild(ds);
          pop.appendChild(item);
        }
      }
      card.appendChild(pop);
      activePopover = pop;
      if (!hasStoredExplain(node)) kickExplain(node);
    }

    // 把某个模块的最新方法摘要写进原始数据和画布上的渲染节点，漂浮窗开着就一并重绘
    function applyNodeMethods(id, patch) {
      const methods = patch && patch.methods;
      const desc = patch && patch.desc;
      for (const list of [map.nodes, currentMap.nodes]) {
        const n = (list || []).find((x) => x.id === id);
        if (!n) continue;
        if (methods) n.methods = methods;
        if (desc) n.desc = desc;
        if (patch.symbols) n.symbols = patch.symbols;
        if (patch.mtime != null) n.mtime = patch.mtime;
        if (patch.methodsMtime != null) n.methodsMtime = patch.methodsMtime;
      }
      const drawn = drawCleanup && drawCleanup.updateNode
        ? drawCleanup.updateNode(id, patch || {})
        : null;
      if (drawn && activePopoverNode && activePopoverNode.id === id) renderPopover(drawn);
    }

    // 单个模块归纳完成：立刻更新它，不等整批结束
    function applyJustSummarized(js) {
      if (!js || !js.id) return;
      applyNodeMethods(js.id, {
        methods: js.methods, symbols: js.symbols, desc: js.desc || '',
        mtime: js.mtime, methodsMtime: js.methodsMtime
      });
    }

    // 整批归纳结束后从磁盘拉一次最新地图兜底，确保中途漏掉的事件也能补上
    function refreshMethodsFromDisk() {
      if (!api.indexGetMap) return;
      api.indexGetMap().then((fresh) => {
        if (!fresh || !Array.isArray(fresh.nodes)) return;
        for (const f of fresh.nodes) {
          applyNodeMethods(f.id, {
            methods: f.methods, symbols: f.symbols, desc: f.desc || '',
            mtime: f.mtime, methodsMtime: f.methodsMtime
          });
        }
      }).catch(() => {});
    }

    // 打开已有地图只展示，不自动归纳

    // 监听归纳进度：每归纳完一个模块就实时更新该节点，不必等整批结束
    if (api.onIndexProgress) {
      offProgress = api.onIndexProgress((st) => {
        if (!st) return;
        if (st.summarizing) {
          title.textContent = '项目地图 · 归纳方法 ' + (st.done || 0) + '/' + (st.total || 0) + ' …';
          applyJustSummarized(st.justSummarized);
        } else if (st.summarizeDone) {
          title.textContent = '项目地图';
          refreshMethodsFromDisk();
        }
      });
    }

    const hide = () => {
      window.__releaseFocus?.(modal);
      modal.classList.add('hidden');
      if (drawCleanup) { drawCleanup(); drawCleanup = null; }
      if (filterPanel) { filterPanel.remove(); filterPanel = null; }
      if (legend) { legend.remove(); legend = null; }
      if (activePopover) { activePopover.remove(); activePopover = null; }
      if (offProgress) { try { offProgress(); } catch (_) {} offProgress = null; }
      if (fullMask && fullMask.parentNode) fullMask.parentNode.removeChild(fullMask);
      window.__focusComposer?.();
    };
    close.onclick = hide;
    modal.onclick = (e) => { if (e.target === modal) hide(); };
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { hide(); document.removeEventListener('keydown', onEsc); }
    });

    relayout(currentMap);

    function openFilter(inc) {
      if (filterPanel) { filterPanel.remove(); filterPanel = null; return; }
      // 面板基于原始全量地图列出所有模块供勾选；应用显示时只保留勾选的
      filterPanel = buildFilterPanel(map, inc, (newIncludes) => {
        const next = { initialized: true, includes: newIncludes };
        try { if (api.indexSetInclude) api.indexSetInclude(next).catch(() => {}); } catch (_) {}
        currentMap = applyIncludes(map, next);
        relayout(currentMap);
      });
      card.appendChild(filterPanel);
    }
    filterBtn.onclick = () => openFilter(include);

    // 首次进入未勾选任何模块：自动打开筛选面板让用户勾选要显示的模块
    if (!include || !include.initialized) openFilter(include || { initialized: false, includes: [] });
  }

  // 连线配色：颜色只表示关系类型，虚线/实线仍然只表示未选中/选中，两套视觉互不干扰
  const EDGE_STYLE = {
    ref: { color: '255,150,60', label: '引用', hint: '导入了并且用到了对方的方法' },
    dep: { color: '80,200,120', label: '仅依赖', hint: '导入了但没用到对方的符号' },
    implicit: { color: '90,160,255', label: '隐式引用', hint: '没有导入语句，直接用了对方独有的符号' },
    include: { color: '180,180,190', label: '头文件包含', hint: 'C/C++ 的 #include' }
  };
  function edgeRgb(kind) {
    return (EDGE_STYLE[kind] || EDGE_STYLE.ref).color;
  }

  // 方法名和行号只认当前源码符号。AI 说明只挂在还存在的符号上，已经删掉的方法不再显示
  function mergeMethods(n) {
    const sym = Array.isArray(n && n.symbols) ? n.symbols : [];
    const ai = Array.isArray(n && n.methods) ? n.methods : [];
    if (!sym.length) return [];
    const aiByName = new Map();
    for (const m of ai) {
      const key = String(m.name || '').toLowerCase();
      if (key && !aiByName.has(key)) aiByName.set(key, m);
    }
    const trust = n.methodsMtime != null && n.methodsMtime === n.mtime;
    return sym.map((s) => {
      const extra = trust ? aiByName.get(String(s.name || '').toLowerCase()) : null;
      return {
        name: s.name,
        line: s.line,
        keyValues: extra ? String(extra.keyValues || '') : '',
        desc: extra ? String(extra.desc || '') : ''
      };
    });
  }

  // 目录稳定配色：路径哈希映射到区分度较高的色相
  function dirColor(dir) {
    let h = 0;
    for (let i = 0; i < dir.length; i++) h = (h * 31 + dir.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ',55%,58%)';
  }

  function drawMap(canvas, map, onReady, onPick) {
    const dpr = window.devicePixelRatio || 1;
    const allNodes = map.nodes.map((n) => {
      const parts = n.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(根目录)';
      return {
        id: n.id,
        label: (parts.pop() || n.path).slice(0, 30),
        path: n.path,
        dir: dir,
        color: dirColor(dir),
        desc: n.desc || '',
        symbols: Array.isArray(n.symbols) ? n.symbols : [],
        methods: Array.isArray(n.methods) ? n.methods : [],
        mtime: n.mtime || 0,
        methodsMtime: n.methodsMtime,
        x: 0, y: 0, col: 0, size: 16
      };
    });
    const idMap = new Map(allNodes.map((n) => [n.id, n]));
    let edges = (map.edges || [])
      .map((e) => ({ a: idMap.get(e.from), b: idMap.get(e.to), kind: e.kind || 'ref' }))
      .filter((e) => e.a && e.b);

    const nodes = allNodes;
    const shownEdges = edges;

    const accent = cssVar('--accent') || '#3b6cff';
    const textColor = cssVar('--text') || '#111';
    const selColor = '#ff7a3c';
    const pad = 40;
    let W = 960, H = 640;
    let scale = 1, panX = 0, panY = 0;
    let selectedNode = null;
    let hoverNode = null;
    let lastMx = 0, lastMy = 0;

    function isNeighbor(n) {
      if (!selectedNode || n.id === selectedNode.id) return false;
      return shownEdges.some((e) =>
        (e.a.id === selectedNode.id && e.b.id === n.id) ||
        (e.b.id === selectedNode.id && e.a.id === n.id));
    }
    // 拖动时：被拖节点及其相连邻居一起偏移（跟随预览）
    function neighborOf(n) {
      if (!dragNode) return false;
      return shownEdges.some((e) =>
        (e.a.id === dragNode.id && e.b.id === n.id) ||
        (e.b.id === dragNode.id && e.a.id === n.id));
    }
    function offOf(n) {
      if (dragNode && (n.id === dragNode.id || neighborOf(n))) return dragOffset;
      return { dx: 0, dy: 0 };
    }

    // ---- 思维导图布局 ----
    // 骨架 = 目录树：顶层目录在最左列，逐层向右；文件是叶子，目录是分支节点（仅展示，不可点选）。
    // 横向：每列 x = 前列最大占用(圆+最长标签) + GAP_X，保证长文件名不会压进下一列；
    // 纵向：叶子逐行均摊（每行 ROW_H），目录 y = 子节点中点，自然形成思维导图分支形。
    const ROW_H = 26;   // 相邻叶子行的垂直间距
    const GAP_X = 64;   // 相邻列之间的横向间隙
    let positioned = false;
    let dirNodes = [];  // 目录分支节点 {dir,name,col,x,y,r,color}
    let treeEdges = []; // 目录骨架连线 {a,b}（a=父目录，b=子目录或文件）
    let contentBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minScale = 0.2; // 滚轮缩小下限（大图整图适配后 scale 很小，下限需低于它）

    function layoutMindmap() {
      dirNodes = []; treeEdges = [];
      if (!nodes.length) { contentBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }; return; }
      const ctx = canvas.getContext('2d');
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      // 建目录树：虚拟根（不绘制），顶层目录挂根，文件挂各自目录
      const root = { name: '', col: -1, sub: new Map(), files: [], x: 0, y: 0, r: 0, color: '' };
      const dirByKey = new Map();
      const maxW = []; // 每列最大横向占用宽度（圆 + 标签）
      function ensureDir(path) {
        if (dirByKey.has(path)) return dirByKey.get(path);
        const segs = path.split('/');
        const parentPath = segs.slice(0, -1).join('/');
        const parent = parentPath ? ensureDir(parentPath) : root;
        const tn = {
          dir: path, name: segs[segs.length - 1], col: segs.length - 1,
          sub: new Map(), files: [], x: 0, y: 0, r: 5, color: dirColor(path)
        };
        dirByKey.set(path, tn);
        parent.sub.set(path, tn);
        const w = 12 + ctx.measureText(tn.name).width;
        maxW[tn.col] = Math.max(maxW[tn.col] || 0, w);
        return tn;
      }
      for (const n of nodes) {
        const segs = n.path.split('/');
        const dirPath = segs.slice(0, -1).join('/');
        const parent = dirPath ? ensureDir(dirPath) : root;
        parent.files.push(n);
        n.col = segs.length - 1;
        const w = 16 + ctx.measureText(n.label).width;
        maxW[n.col] = Math.max(maxW[n.col] || 0, w);
      }
      // 列 x：按各列最大宽度从左往右递推
      const colX = [pad];
      for (let c = 1; c < maxW.length; c++) colX[c] = colX[c - 1] + (maxW[c - 1] || 0) + GAP_X;
      // 纵向：叶子逐行排，目录 y = 子节点中点；先深后浅（递归先算子）
      let rowCursor = 0;
      function place(tn) {
        const kidDirs = Array.from(tn.sub.values()).sort((a, b) => (a.name < b.name ? -1 : 1));
        const kidFiles = tn.files.slice().sort((a, b) => (a.label < b.label ? -1 : 1));
        let yMin = Infinity, yMax = -Infinity;
        for (const d of kidDirs) {
          place(d);
          if (tn !== root) treeEdges.push({ a: tn, b: d });
          if (d.y < yMin) yMin = d.y;
          if (d.y > yMax) yMax = d.y;
        }
        for (const f of kidFiles) {
          f.y = rowCursor * ROW_H;
          rowCursor++;
          if (tn !== root) treeEdges.push({ a: tn, b: f });
          if (f.y < yMin) yMin = f.y;
          if (f.y > yMax) yMax = f.y;
        }
        tn.y = (yMin === Infinity) ? rowCursor * ROW_H : (yMin + yMax) / 2;
      }
      for (const d of Array.from(root.sub.values()).sort((a, b) => (a.name < b.name ? -1 : 1))) place(d);
      dirNodes = Array.from(dirByKey.values());
      for (const d of dirNodes) d.x = colX[d.col];
      for (const n of nodes) n.x = colX[n.col];
      // 内容包围盒（含标签区），供初始整图适配
      let minY = Infinity, maxY = -Infinity;
      for (const n of nodes) { if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; }
      for (const d of dirNodes) { if (d.y < minY) minY = d.y; if (d.y > maxY) maxY = d.y; }
      const lastCol = maxW.length - 1;
      const rightX = colX[lastCol] + (maxW[lastCol] || 0);
      contentBounds = { minX: pad, minY: minY - pad, maxX: rightX + pad, maxY: maxY + pad };
    }

    // 初始整图适配：内容包围盒缩放并居中到可视区
    function fitView() {
      const bw = contentBounds.maxX - contentBounds.minX;
      const bh = contentBounds.maxY - contentBounds.minY;
      if (bw <= 0 || bh <= 0) { scale = 1; panX = 0; panY = 0; minScale = 0.2; return; }
      const s = Math.max(0.02, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1));
      scale = s;
      minScale = Math.min(0.2, s * 0.8);
      panX = (W - bw * s) / 2 - contentBounds.minX * s;
      panY = (H - bh * s) / 2 - contentBounds.minY * s;
    }

    function render() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(panX, panY);
      ctx.scale(scale, scale);
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      // 目录骨架连线：思维导图分支形（父目录右侧 -> 子左侧的贝塞尔曲线）
      ctx.setLineDash([]);
      ctx.strokeStyle = selectedNode ? 'rgba(150,170,200,0.08)' : 'rgba(150,170,200,0.30)';
      ctx.lineWidth = 1 / scale;
      for (const t of treeEdges) {
        const ra = t.a.r || 5;
        const rb = t.b.size != null ? t.b.size / 2 : (t.b.r || 5);
        const ax = t.a.x + ra, ay = t.a.y;
        const bx = t.b.x - rb, by = t.b.y;
        const mx = (ax + bx) / 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.stroke();
      }

      // 关系连线：颜色区分类型（见图例）；未选择时虚线，选择后相关实线高亮、无关淡出
      const hasSel = !!selectedNode;
      for (const e of shownEdges) {
        const oa = offOf(e.a), ob = offOf(e.b);
        const ax = e.a.x + (e.a.size || 16) / 2 + oa.dx, ay = e.a.y + oa.dy;
        const bx = e.b.x - (e.b.size || 16) / 2 + ob.dx, by = e.b.y + ob.dy;
        const mx = (ax + bx) / 2;
        const onSel = selectedNode && (e.a.id === selectedNode.id || e.b.id === selectedNode.id);
        const rgb = edgeRgb(e.kind);
        if (!hasSel) {
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = 'rgba(' + rgb + ',0.62)';
          ctx.lineWidth = 1 / scale;
        } else if (onSel) {
          ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(' + rgb + ',1)';
          ctx.lineWidth = 1.8 / scale;
        } else {
          ctx.setLineDash([]);
          ctx.strokeStyle = 'rgba(150,170,200,0.10)';
          ctx.lineWidth = 1 / scale;
        }
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 目录分支节点：小圆点 + 目录名（仅展示不可点选；选中后整体淡化）
      for (const d of dirNodes) {
        ctx.globalAlpha = selectedNode ? 0.30 : 0.85;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.color;
        ctx.fill();
        if (scale >= 0.5) {
          const fs = 10;
          ctx.font = fs + 'px "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'left';
          ctx.lineWidth = Math.max(2.5, fs * 0.24);
          ctx.strokeStyle = '#000';
          ctx.strokeText(d.name, d.x + d.r + 4, d.y);
          ctx.fillStyle = '#fff';
          ctx.fillText(d.name, d.x + d.r + 4, d.y);
        }
        ctx.globalAlpha = 1;
      }

      // 文件节点：圆形 + 右侧名字标签（同目录同色；选中橙色、邻居高亮、无关节点淡出）
      for (const n of nodes) {
        const off = offOf(n);
        const x = n.x + off.dx, y = n.y + off.dy;
        const r = (n.size || 16) / 2;
        const isSel = selectedNode && n.id === selectedNode.id;
        const nb = isNeighbor(n);
        const dim = selectedNode && !isSel && !nb;
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? selColor : n.color;
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2 / scale;
          ctx.stroke();
        }
        // 名字标签：缩放较远时只画圆点不画字（避免糊成一团）；选中/悬停显示完整路径；白字黑描边保证压线时仍可读
        const showLabel = scale >= 0.5;
        if (showLabel) {
          const fs = Math.max(9, 10 * Math.min(1.5, scale));
          const text = (isSel || n === hoverNode) ? n.path : n.label;
          ctx.globalAlpha = dim ? 0.22 : (selectedNode ? (isSel || nb ? 1 : 0.4) : 0.92);
          ctx.font = (isSel ? '600 ' : '') + fs + 'px "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'left';
          ctx.lineWidth = Math.max(2.5, fs * 0.24);
          ctx.strokeStyle = '#000';
          ctx.strokeText(text, x + r + 4, y);
          ctx.fillStyle = '#fff';
          ctx.fillText(text, x + r + 4, y);
          ctx.globalAlpha = 1;
        }
      }

      // 屏幕坐标层：悬停 / 选中 信息条（显示完整路径）
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const infoNode = hoverNode || selectedNode;
      if (infoNode) {
        const text = infoNode.path;
        ctx.font = '12px sans-serif';
        const tw = ctx.measureText(text).width;
        const padX = 8, bh = 22;
        let bw = tw + padX * 2;
        let bx = lastMx + 14, by = lastMy + 14;
        if (bx + bw > W) bx = Math.max(4, W - bw - 4);
        if (by + bh > H) by = Math.max(4, H - bh - 4);
        ctx.fillStyle = 'rgba(20,20,28,0.92)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + padX, by + bh / 2);
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      W = Math.max(320, rect.width);
      H = Math.max(320, rect.height);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      if (!positioned && nodes.length) {
        layoutMindmap(); // 思维导图布局：一次同步算完（目录树骨架 + 依赖线坐标）
        fitView();       // 初始整图适配可视范围
        positioned = true;
        if (onReady) onReady(); // 布局完成即移除遮罩
      }
      render();
    }

    function toWorld(mx, my) {
      return { x: (mx - panX) / scale, y: (my - panY) / scale };
    }
    function nodeAt(mx, my) {
      const w = toWorld(mx, my);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = (n.size || 16) / 2 + 4;
        const dx = w.x - n.x, dy = w.y - n.y;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }
    let dragNode = null, panning = false, lastX = 0, lastY = 0;
    let pressNode = null, pressX = 0, pressY = 0, moved = false, down = false;
    let dragOffset = { dx: 0, dy: 0 };
    let pressWorld = { x: 0, y: 0 };
    const DRAG_THRESH = 4;

    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const w = toWorld(mx, my);
      scale = Math.max(minScale, Math.min(4, scale * factor));
      panX = mx - w.x * scale;
      panY = my - w.y * scale;
      render();
    }
    function onDown(e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      down = true;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      lastMx = mx; lastMy = my;
      const hit = nodeAt(mx, my);
      pressNode = hit; pressX = e.clientX; pressY = e.clientY; moved = false;
      dragNode = null; dragOffset = { dx: 0, dy: 0 };
      panning = !hit;          // 只有按在空白处才平移
      lastX = e.clientX; lastY = e.clientY;
      pressWorld = toWorld(mx, my);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
    function onMove(e) {
      const rect = canvas.getBoundingClientRect();
      lastMx = e.clientX - rect.left; lastMy = e.clientY - rect.top;
      if (!down) {
        // 未按住：仅刷新悬停高亮与提示，不移动任何东西
        const hit = nodeAt(lastMx, lastMy);
        if (hit !== hoverNode) { hoverNode = hit; render(); }
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        return;
      }
      if (!moved && (Math.abs(e.clientX - pressX) > DRAG_THRESH || Math.abs(e.clientY - pressY) > DRAG_THRESH)) moved = true;
      if (moved) {
        if (pressNode) {
          // 拖动任意节点：它和与之相连的邻居一起平移（预览），松手回原位
          dragNode = pressNode;
          const w = toWorld(lastMx, lastMy);
          dragOffset = { dx: w.x - pressWorld.x, dy: w.y - pressWorld.y };
          canvas.style.cursor = 'grabbing';
          render();
        } else if (panning) {
          panX += e.clientX - lastX;
          panY += e.clientY - lastY;
          lastX = e.clientX; lastY = e.clientY;
          canvas.style.cursor = 'grabbing';
          render();
        }
      }
    }
    function onUp(e) {
      try { if (e && e.pointerId != null) canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      down = false;
      if (!moved) {
        if (pressNode) {
          selectedNode = (selectedNode && selectedNode.id === pressNode.id) ? null : pressNode;
        } else {
          selectedNode = null;
        }
        if (onPick) onPick(selectedNode); // 点击节点弹出归纳漂浮窗，点空白关闭
        render();
      }
      // 松手：清除拖动偏移，所有节点回到布局原位（回弹）；复位交互状态
      dragNode = null; dragOffset = { dx: 0, dy: 0 };
      panning = false; canvas.style.cursor = 'grab';
    }

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', resize);

    resize();
    // 无节点（首次空地图）时直接通知就绪，隐藏遮罩
    if (!nodes.length && onReady) onReady();

    function cleanup() {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      window.removeEventListener('resize', resize);
    }
    // 归纳边跑边更新：按 id 就地改渲染节点的方法与说明，不重算布局
    cleanup.updateNode = function (id, patch) {
      const n = idMap.get(id);
      if (!n || !patch) return null;
      if (patch.methods) n.methods = patch.methods;
      if (patch.desc) n.desc = patch.desc;
      if (patch.symbols) n.symbols = patch.symbols;
      if (patch.mtime != null) n.mtime = patch.mtime;
      if (patch.methodsMtime != null) n.methodsMtime = patch.methodsMtime;
      return n;
    };
    return cleanup;
  }

  function ensureCardButtons() {
    const card = document.getElementById('idx-card');
    if (!card || card.querySelector('#idx-map-view')) return;
    const view = el('button', { id: 'idx-map-view', textContent: '查看项目地图' });
    view.style.cssText = 'margin-left:8px;border:1px solid var(--border);background:var(--hover);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:12px;';
    view.onclick = () => openMapModal();
    card.appendChild(view);
    api.indexStatus().then((st) => {
      if (!st || !st.nodes) view.style.display = 'none';
    }).catch(() => { view.style.display = 'none'; });

    const sync = document.getElementById('idx-sync');
    if (sync && !sync._mapHooked) {
      sync._mapHooked = true;
      sync.addEventListener('click', () => { pendingOpen = true; });
    }
  }

  if (api.onIndexProgress) {
    api.onIndexProgress((st) => {
      if (st && !st.running && pendingOpen) {
        pendingOpen = false;
        setTimeout(openMapModal, 350);
      }
    });
  }

  function observe() {
    const settingsModal = document.getElementById('modal');
    if (settingsModal) {
      observer = new MutationObserver(() => {
        if (!settingsModal.classList.contains('hidden')) ensureCardButtons();
      });
      observer.observe(settingsModal, { childList: true, subtree: true });
    }
    ensureCardButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
})();

// 链路导图：把一条回复的调用链按「入口 → 中间 → 展示」三列横向画出来，点任一节点看六段说明。
// 数据结构来自 electron/lib/chain-tree.js 的 mapOf：nodes 带 kind/title/role/impl/impact/file/up，edges 是相邻连线。
// 与方案导图分开：DOM id、样式类都不共用，方案导图的改动不会影响这里。
(function () {
  // 三类节点的颜色沿用主题变量，浅色/深色主题都跟着变
  const KIND_COLOR = { 入口: 'var(--success)', 中间: 'var(--warning)', 展示: 'var(--accent)' };
  // 列的顺序固定：链路从入口走到展示
  const KIND_ORDER = ['入口', '中间', '展示'];

  let current = null;

  /** 建一个元素并设置类名、文本；文本一律走 textContent，避免把模型输出当 HTML 注入 */
  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 空值兜底显示：链路节点缺某一段时给出可读提示，而不是留空白 */
  function textOr(value) {
    const s = String(value || '').trim();
    return s || '（没写）';
  }

  /** 关闭弹层：清掉当前实例与 document 上的 keydown 监听 */
  function close() {
    const modal = document.getElementById('chain-map-modal');
    if (!modal) return;
    if (modal._dispose) modal._dispose();
    modal.remove();
    current = null;
  }

  /** 弹层是否开着：后台推来新导图时据此决定要不要实时刷新 */
  function isOpen() {
    return !!current;
  }

  /** 用新导图刷新已打开的弹层；没开着就什么都不做 */
  function update(map) {
    if (current) current.render(map);
  }

  /**
   * 渲染节点详情：点节点后把六段写在弹层底部，六段固定顺序，缺的写「（没写）」。
   * @param {HTMLElement} host 详情容器，每次整块替换内容
   * @param {object} node 被点的链路节点
   */
  function renderDetail(host, node) {
    host.textContent = '';
    if (!node) {
      host.appendChild(makeEl('div', 'chain-map-detail-empty', '点任意节点查看这一段链路的作用、实现、影响与出处'));
      return;
    }
    const head = makeEl('div', 'chain-map-detail-head');
    const badge = makeEl('span', 'chain-map-badge', node.kind || '链路');
    badge.style.color = KIND_COLOR[node.kind] || 'var(--muted)';
    badge.style.borderColor = KIND_COLOR[node.kind] || 'var(--border)';
    head.appendChild(makeEl('span', 'chain-map-detail-title', `${node.no}. ${node.title || ''}`));
    head.appendChild(badge);
    host.appendChild(head);
    // 六段顺序固定：作用 → 具体实现 → 会改变什么 → 文件·方法 → 上游调用者 → 序号
    const rows = [
      ['作用', node.role],
      ['具体实现', node.impl],
      ['会改变什么', node.impact],
      ['文件·方法', node.file],
      ['上游调用者', node.up],
      ['序号', node.no ? String(node.no) : '']
    ];
    for (let i = 0; i < rows.length; i++) {
      const row = makeEl('div', 'chain-map-detail-row');
      row.appendChild(makeEl('span', 'chain-map-detail-key', rows[i][0]));
      row.appendChild(makeEl('span', 'chain-map-detail-val', textOr(rows[i][1])));
      host.appendChild(row);
    }
  }

  /**
   * 画整张链路图：三列（入口 / 中间 / 展示），列内节点竖排，列间用箭头表示流向。
   * @param {HTMLElement} body 弹层内容区，每次整块替换
   * @param {object} map { nodes, edges }
   * @param {HTMLElement} detailHost 详情容器
   */
  function renderChain(body, map, detailHost) {
    body.textContent = '';
    const nodes = (map && Array.isArray(map.nodes)) ? map.nodes : [];
    // 按类型分列，列内保持原文顺序（链路是有序的，不能按名字重排）
    const columns = { 入口: [], 中间: [], 展示: [] };
    for (let i = 0; i < nodes.length; i++) {
      const kind = KIND_ORDER.indexOf(nodes[i].kind) >= 0 ? nodes[i].kind : '中间';
      columns[kind].push(nodes[i]);
    }
    let shown = 0;
    for (let c = 0; c < KIND_ORDER.length; c++) {
      const kind = KIND_ORDER[c];
      const list = columns[kind];
      // 空列不占位：短链路只有入口和展示时，中间列整块省略
      if (!list.length) continue;
      if (shown > 0) body.appendChild(makeEl('div', 'chain-map-arrow', '→'));
      const col = makeEl('div', 'chain-map-col');
      const colHead = makeEl('div', 'chain-map-col-head', kind);
      colHead.style.color = KIND_COLOR[kind] || 'var(--muted)';
      col.appendChild(colHead);
      for (let j = 0; j < list.length; j++) {
        const node = list[j];
        const card = makeEl('button', 'chain-map-node');
        card.type = 'button';
        // 左侧竖条用节点类型色，一眼区分入口/中间/展示
        card.style.borderLeftColor = KIND_COLOR[kind] || 'var(--border)';
        card.appendChild(makeEl('span', 'chain-map-node-no', `${node.no}.`));
        card.appendChild(makeEl('span', 'chain-map-node-title', node.title || ''));
        card.onclick = function () {
          const marked = body.querySelector('.chain-map-node.on');
          if (marked) marked.classList.remove('on');
          card.classList.add('on');
          renderDetail(detailHost, node);
        };
        col.appendChild(card);
      }
      body.appendChild(col);
      shown++;
    }
    renderDetail(detailHost, null);
  }

  /**
   * 打开链路导图弹层。
   * @param {object} opts
   * @param {string} opts.title 会话标题，显示成「链路导图 · 标题」
   * @param {object} opts.map 导图数据；有 nodes 时画图，没有就进空态
   * @param {string} opts.emptyText 空态说明（这条回复没有【链路】段时的提示）
   * @param {string} opts.workspace 工作区，仅随实例留存，重开时由调用方重新取图
   * @param {string} opts.tabId 会话 id
   * @param {string} opts.turnId 本轮回复编号
   * 副作用：先关掉上一个实例，再往 document.body 挂 #chain-map-modal，并注册 Esc 关闭监听。
   */
  function open(opts) {
    close();
    const options = opts || {};
    const modal = makeEl('div', 'chain-map-modal');
    modal.id = 'chain-map-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:92;background:var(--overlay);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';

    const card = makeEl('div', 'chain-map-card');
    card.style.cssText = 'position:relative;width:min(94vw,1180px);height:min(88vh,860px);background:var(--panel-solid);border:1px solid var(--border);'
      + 'border-radius:var(--sub-r-lg);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow);';

    const head = makeEl('div', 'chain-map-head');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);';
    const title = makeEl('span', 'chain-map-title', `链路导图 · ${options.title || ''}`);
    title.style.cssText = 'font-size:14px;font-weight:600;';
    const closeBtn = makeEl('button', 'chain-map-close', '×');
    closeBtn.style.cssText = 'border:0;background:none;font-size:20px;cursor:pointer;color:var(--muted);';
    closeBtn.onclick = close;
    head.appendChild(title);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = makeEl('div', 'chain-map-body');
    body.style.cssText = 'flex:1;overflow:auto;padding:16px;display:flex;align-items:flex-start;gap:10px;';
    const detail = makeEl('div', 'chain-map-detail');
    detail.style.cssText = 'border-top:1px solid var(--border);padding:12px 14px;max-height:42%;overflow:auto;font-size:12px;';
    card.appendChild(body);
    card.appendChild(detail);
    modal.appendChild(card);

    // 点遮罩关闭，点卡片内部不关
    modal.onclick = function (e) {
      if (e.target === modal) close();
    };
    // Esc 关闭：监听挂在 document 上，关闭时移除，避免多次打开叠出一堆监听
    const onKey = function (e) {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    modal._dispose = function () {
      document.removeEventListener('keydown', onKey);
    };

    const instance = {
      map: null,
      render: function (nextMap) {
        instance.map = nextMap || { nodes: [], edges: [] };
        const nodes = Array.isArray(instance.map.nodes) ? instance.map.nodes : [];
        if (!nodes.length) {
          body.textContent = '';
          body.appendChild(makeEl('div', 'chain-map-empty', textOr(options.emptyText)));
          renderDetail(detail, null);
          return;
        }
        renderChain(body, instance.map, detail);
      }
    };
    current = instance;
    document.body.appendChild(modal);
    instance.render(options.map);
  }

  window.ChainMap = { open: open, update: update, isOpen: isOpen, close: close };
})();

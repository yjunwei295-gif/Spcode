// 视觉设置（独立模块）：管理每个模型的「支持视觉」开关，以及本地视觉代理配置。
// 视觉代理来源：本地 GGUF 视觉模型 + mmproj。缺看图引擎时自动下载并在后台拉起，
// 识图结果以文字注入主模型。点「完成」或发图时都会按需启动。
// 入口按钮在 index.html 文件菜单「视觉设置」，复用 modal 容器。
import { t } from './i18n.js';

const api = window.simple || window.sinpo;

// —— 内联注入视觉设置弹窗样式 ——
// 放在本模块内而不是 styles.css，避免样式表缓存/加载顺序导致弹窗退化成白底；
// 颜色和圆角复用主界面的主题变量，避免模块加载顺序覆盖全局主题。
(function injectVsStyles() {
  const css = `
.vs-card { background: var(--panel); }
.vs-head { border-bottom: 1px solid var(--border); }
.vs-model-row { background: var(--sub-surface); border: 1px solid var(--border); }

/* ===== 弹窗按钮组（与主界面 pill / modal-actions 风格协调） ===== */
.vs-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 14px 18px 16px;
  border-top: 1px solid var(--border);
}
.vs-btn {
  border: 1px solid var(--border);
  background: var(--btn-bg);
  color: var(--text);
  border-radius: var(--sub-r);
  padding: 8px 18px;
  min-height: 36px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.06s;
}
.vs-btn:hover { background: var(--btn-hover); border-color: var(--accent); }
.vs-btn:active { transform: scale(0.97); }
.vs-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.vs-btn.primary {
  background: var(--primary-bg);
  color: var(--primary-fg);
  border-color: var(--accent);
}
.vs-btn.primary:hover { background: var(--primary-bg); filter: brightness(1.07); }
.vs-btn.primary:active { filter: brightness(0.97); }
.vs-close {
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: var(--muted);
  width: 30px;
  height: 30px;
  border-radius: var(--sub-r);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.vs-close:hover { background: var(--hover); color: var(--text); }

.vs-start-status.running { color: var(--warning); }
.vs-start-status.ok { color: var(--success); }
.vs-start-status.err { color: var(--danger); }
.vs-bar {
  height: 4px;
  background: var(--border);
  border-radius: 99px;
  overflow: hidden;
}
.vs-bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width 0.15s; }

.vs-slot {
  border: 1px solid var(--border); border-radius: var(--sub-r); padding: 10px 12px; margin-top: 8px;
  background: var(--sub-surface);
}
.vs-slot-head { display: flex; gap: 8px; align-items: center; }
.vs-slot-head select { flex: 1; min-width: 0; }
.vs-slot-del {
  border: 1px solid var(--border); background: var(--hover); color: var(--danger);
  border-radius: var(--sub-r); padding: 4px 10px; cursor: pointer; font-size: 12px;
}
.vs-primary-name { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
`;
  const style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
})();

function $vs(id) { return document.getElementById(id); }

function escapeHtmlVs(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openModalVs(html) {
  const card = $vs('modal-card');
  const modal = $vs('modal');
  // 上一个弹窗可能排了 200ms 延迟隐藏，打开新弹窗前先取消，避免被它一起关掉
  if (modal.__closeTimer) {
    clearTimeout(modal.__closeTimer);
    modal.__closeTimer = null;
  }
  card.classList.add('vs-card');
  card.classList.remove('wide');
  card.onclick = null;
  card.innerHTML = html;
  modal.classList.remove('hidden');
  modal.classList.remove('is-open');
  void modal.offsetWidth;
  requestAnimationFrame(() => modal.classList.add('is-open'));
}

function closeModalVs() {
  const modal = $vs('modal');
  const card = $vs('modal-card');
  // 弹窗内容已被别的模块换成别的弹窗时不要动它，否则会把别人的弹窗变透明甚至关掉
  if (!modal || !card || !card.classList.contains('vs-card')) return;
  window.__releaseFocus?.(modal);
  modal.classList.remove('is-open');
  window.__focusComposer?.();
  const hide = () => {
    modal.__closeTimer = null;
    modal.classList.add('hidden');
    card.classList.remove('vs-card');
  };
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      hide();
      return;
    }
  } catch {
    hide();
    return;
  }
  if (modal.__closeTimer) clearTimeout(modal.__closeTimer);
  modal.__closeTimer = setTimeout(hide, 200);
}

const ROLES = [
  { id: 'vision', key: 'roleVision' },
  { id: 'summary', key: 'roleSummary' },
  { id: 'code', key: 'roleCode' },
  { id: 'planning', key: 'rolePlanning' },
  { id: 'imageGen', key: 'roleImageGen' },
  { id: 'videoGen', key: 'roleVideoGen' },
  { id: 'model3d', key: 'roleModel3d' },
  { id: 'docGen', key: 'roleDocGen' }
];

let visionState = {
  models: [],
  currentModelId: '',
  assemblyKey: '',
  slots: [],
  localFiles: [],
  modelsDir: '',
  zbaingModules: [],
  started: false,
  startError: ''
};

function paintVisionStatus(p) {
  const wrap = $vs('vs-start-status');
  const textEl = $vs('vs-start-text');
  const bar = $vs('vs-bar');
  const fill = $vs('vs-bar-fill');
  if (!wrap) return;
  const kind = p.error ? 'err' : (p.ok ? 'ok' : 'running');
  wrap.className = `vs-start-status ${kind}`;
  if (textEl) textEl.textContent = p.text || '';
  else wrap.textContent = p.text || '';
  const pct = Number(p.pct);
  if (bar && fill && Number.isFinite(pct) && pct > 0) {
    bar.classList.remove('hidden');
    fill.style.width = `${Math.min(100, pct)}%`;
  } else if (bar && !p.keepBar) {
    bar.classList.add('hidden');
  }
}

function statusBox(kind, text) {
  return `<div class="vs-start-status ${kind}" id="vs-start-status">
    <div id="vs-start-text">${text}</div>
    <div class="vs-bar hidden" id="vs-bar"><i id="vs-bar-fill"></i></div>
  </div>`;
}

function currentPrimary() {
  const m = visionState.models.find((x) => x.id === visionState.currentModelId);
  if (m && m.type === 'local') return `${t('local')} · ${m.model || m.modelPath || t('noFilePicked')}`;
  if (m) return `${m.name} · ${m.model || ''}`;
  return t('noPrimary');
}

async function openVisionSettings() {
  const s = await api.getState();
  const local = await api.listLocalModels().catch(() => ({ files: [], dir: '' }));
  const status = await api.visionAgentStatus().catch(() => ({ started: false, error: '' }));
  const zbMods = api.listZbaingModules
    ? await api.listZbaingModules().catch(() => [])
    : [];
  const key = (s && s.assemblyKey) || '';
  const pack = ((s && s.assemblies) || {})[key] || { slots: [] };
  visionState = {
    models: (s && s.models) || [],
    providers: (s && s.providers) || [],
    currentModelId: (s && s.currentModelId) || '',
    assemblyKey: key,
    slots: Array.isArray(pack.slots) ? pack.slots.map((x) => ({ ...x })) : [],
    localFiles: (local && local.files) || [],
    modelsDir: (local && local.dir) || (s && s.modelsDir) || '',
    zbaingModules: Array.isArray(zbMods) ? zbMods : [],
    started: !!(status && status.started),
    startError: (status && status.error) || ''
  };
  renderVisionModal();
}

async function guessMmprojFor(modelName) {
  if (!modelName) return '';
  try {
    const r = await api.findMmproj(modelName);
    if (r && r.path) return r.path;
  } catch { /* 搜不到就空着，启动时会自动下 */ }
  return '';
}

async function saveAssembly() {
  try {
    await api.saveAssembly({ key: visionState.assemblyKey, slots: visionState.slots });
  } catch (err) {
    alert(err && err.message ? err.message : t('saveFail'));
  }
}

function modelOptions(slot) {
  const local = visionState.localFiles.map((f) => {
    const tag = f.purposeLabel || f.meta?.purpose || '';
    const tagText = tag ? ` · ${tag}` : '';
    return `<option value="local:${escapeHtmlVs(f.name)}" ${slot.type !== 'api' && slot.type !== 'zbaingModule' && slot.model === f.name ? 'selected' : ''}>${t('local')} · ${escapeHtmlVs(f.name)}${escapeHtmlVs(tagText)}</option>`;
  }).join('');
  const zmods = (visionState.zbaingModules || [])
    .filter((m) => m.kind === 'zlm' && m.id)
    .map((m) => {
      const tag = m.trained ? '✓' : '○';
      const sel = slot.type === 'zbaingModule' && slot.moduleId === m.id ? 'selected' : '';
      const label = `${tag} zbaing · ${m.name || m.id} · ${m.params || ''}`;
      return `<option value="zbaing:${escapeHtmlVs(m.id)}" ${sel}>${escapeHtmlVs(label)}</option>`;
    }).join('');
  const apis = visionState.models.filter((m) => m.type !== 'local').map((m) =>
    `<option value="api:${escapeHtmlVs(m.id)}" ${slot.apiId === m.id ? 'selected' : ''}>${t('api')} · ${escapeHtmlVs(m.name)} · ${escapeHtmlVs(m.model || '')}</option>`
  ).join('');
  return `<option value="">${t('unset')}</option>${zmods}${local}${apis}`;
}

function renderSlots() {
  if (!visionState.slots.length) {
    return `<div class="vs-empty">${t('noSlots')}</div>`;
  }
  return visionState.slots.map((slot, i) => {
    const roleOpts = ROLES.map((r) =>
      `<option value="${r.id}" ${slot.role === r.id ? 'selected' : ''}>${t(r.key)}</option>`
    ).join('');
    const extra = slot.role === 'vision' ? `
      <label class="vs-field">
        <span class="vs-field-label">${t('mmproj')}</span>
        <input type="text" data-slot-mmproj="${i}" value="${escapeHtmlVs(slot.mmproj || '')}" placeholder="${t('mmprojPh')}" />
      </label>
      <label class="vs-field">
        <span class="vs-field-label">${t('endpoint')}</span>
        <input type="text" data-slot-endpoint="${i}" value="${escapeHtmlVs(slot.endpoint || '')}" placeholder="http://127.0.0.1:1234/v1" />
      </label>` : '';
    return `<div class="vs-slot">
      <div class="vs-slot-head">
        <select data-slot-role="${i}">${roleOpts}</select>
        <select data-slot-model="${i}">${modelOptions(slot)}</select>
        <button type="button" class="vs-slot-del" data-slot-del="${i}">${t('remove')}</button>
      </div>
      ${extra}
    </div>`;
  }).join('');
}

function renderVisionModal() {
  const apiRows = visionState.models
    .filter((m) => m.type !== 'local')
    .map((m) => `
      <div class="vs-model-row">
        <label class="vs-switch" title="${m.vision ? t('visionOff') : t('visionOnHint')}">
          <input type="checkbox" data-vision="${escapeHtmlVs(m.id)}" ${m.vision ? 'checked' : ''}>
          <span class="vs-track"></span>
        </label>
        <div class="vs-model-info">
          <div class="vs-model-name">${escapeHtmlVs(m.name)}</div>
          <div class="vs-model-sub">${escapeHtmlVs(m.model || m.providerId || '')}</div>
        </div>
        <span class="vs-badge ${m.vision ? 'on' : ''}">${m.vision ? t('supportsVision') : t('noVision')}</span>
      </div>`)
    .join('');

  const hasVision = visionState.slots.some((s) => s.role === 'vision' && s.model);
  const statusHtml = visionState.started
    ? statusBox('ok', t('visionStarted'))
    : (visionState.startError
      ? statusBox('err', t('visionStartFail', { msg: escapeHtmlVs(visionState.startError) }))
      : statusBox('running', hasVision ? t('visionNotStarted') : t('visionNoSlot')));

  openModalVs(`
    <div class="vs-head">
      <div class="vs-title">
        <span class="vs-ico">👁</span>
        <div>
          <div class="vs-h3">${t('comboTitle')}</div>
          <div class="vs-sub">${t('comboSub')}</div>
        </div>
      </div>
      <button type="button" class="vs-close" id="vs-close" title="${t('close')}">×</button>
    </div>

    <div class="vs-body">
      <section class="vs-sec">
        <div class="vs-sec-head">
          <span class="vs-sec-title">${t('currentPrimary')}</span>
          <span class="vs-sec-hint">${t('comboHint')}</span>
        </div>
        <div class="vs-primary-name">${escapeHtmlVs(currentPrimary())}</div>
        <div class="vs-tip">
          ${t('comboTip')}
        </div>
        ${renderSlots()}
        <div class="vs-actions" style="border:0;padding:10px 0 0;justify-content:flex-start">
          <button type="button" class="vs-btn" id="vs-add-slot">${t('addSlot')}</button>
        </div>
        ${statusHtml}
      </section>

      <section class="vs-sec">
        <div class="vs-sec-head">
          <span class="vs-sec-title">${t('apiVision')}</span>
          <span class="vs-sec-hint">${t('apiVisionHint')}</span>
        </div>
        <div class="vs-rows">
          ${apiRows || `<div class="vs-empty">${t('noApiYet')}</div>`}
        </div>
      </section>
    </div>

    <div class="vs-actions">
      <button type="button" class="vs-btn" id="vs-cancel">${t('cancel')}</button>
      <button type="button" class="vs-btn primary" id="vs-done">${t('done')}</button>
    </div>`);

  $vs('vs-close').onclick = closeModalVs;
  $vs('vs-cancel').onclick = closeModalVs;
  $vs('vs-add-slot').onclick = async () => {
    visionState.slots.push({
      id: `slot-${Date.now()}`,
      role: visionState.slots.some((s) => s.role === 'vision') ? 'summary' : 'vision',
      type: 'local',
      model: '',
      mmproj: '',
      endpoint: ''
    });
    await saveAssembly();
    renderVisionModal();
  };
  $vs('vs-done').onclick = async () => {
    const statusEl = $vs('vs-start-status');
    try {
      await saveAssembly();
      await api.saveModels(visionState.models, visionState.currentModelId, visionState.providers);
    } catch (err) {
      alert(err && err.message ? err.message : t('saveFail'));
      return;
    }
    const vision = visionState.slots.find((s) => s.role === 'vision' && s.model && s.type !== 'api');
    // 先关窗：配置已保存；看图引擎在后台按需启动，不挡住「完成」
    closeModalVs();
    if (!vision) return;
    try {
      if (statusEl) { /* modal already closing */ }
      await api.startVisionAgent();
    } catch {
      /* 发图时还会再启动；此处不弹窗打断 */
    }
  };

  $vs('modal-card').onclick = async (e) => {
    const del = e.target.closest('[data-slot-del]');
    if (del) {
      visionState.slots.splice(Number(del.getAttribute('data-slot-del')), 1);
      await saveAssembly();
      renderVisionModal();
      return;
    }
    const cb = e.target.closest('[data-vision]');
    if (!cb || !(cb instanceof HTMLInputElement)) return;
    const id = cb.getAttribute('data-vision');
    const m = visionState.models.find((x) => x.id === id);
    if (!m) return;
    m.vision = cb.checked;
    try {
      await api.saveModels(visionState.models, visionState.currentModelId, visionState.providers);
      renderVisionModal();
    } catch (err) {
      alert(err && err.message ? err.message : t('saveFail'));
    }
  };

  $vs('modal-card').onchange = async (e) => {
    const roleEl = e.target.closest('[data-slot-role]');
    const modelEl = e.target.closest('[data-slot-model]');
    const mmEl = e.target.closest('[data-slot-mmproj]');
    const epEl = e.target.closest('[data-slot-endpoint]');
    if (roleEl) {
      const i = Number(roleEl.getAttribute('data-slot-role'));
      visionState.slots[i].role = roleEl.value;
    }
    if (modelEl) {
      const i = Number(modelEl.getAttribute('data-slot-model'));
      const v = modelEl.value;
      const slot = visionState.slots[i];
      if (v.startsWith('api:')) {
        slot.type = 'api';
        slot.apiId = v.slice(4);
        slot.moduleId = '';
        const m = visionState.models.find((x) => x.id === slot.apiId);
        slot.model = m?.model || '';
        slot.name = m?.name || '';
      } else if (v.startsWith('local:')) {
        slot.type = 'local';
        slot.apiId = '';
        slot.moduleId = '';
        slot.model = v.slice(6);
        if (slot.role === 'vision') {
          const leaf = String(slot.mmproj || '').split(/[\\/]/).pop();
          const looksWrong = !leaf || (/\.gguf$/i.test(leaf) && !/mmproj/i.test(leaf));
          if (looksWrong) slot.mmproj = (await guessMmprojFor(slot.model)) || '';
        }
      } else if (v.startsWith('zbaing:')) {
        slot.type = 'zbaingModule';
        slot.moduleId = v.slice(7);
        slot.apiId = '';
        slot.model = '';
        const zm = (visionState.zbaingModules || []).find((x) => x.id === slot.moduleId);
        slot.name = zm?.name || slot.moduleId;
      } else {
        slot.model = '';
        slot.apiId = '';
        slot.moduleId = '';
      }
    }
    if (mmEl) {
      visionState.slots[Number(mmEl.getAttribute('data-slot-mmproj'))].mmproj = mmEl.value;
    }
    if (epEl) {
      visionState.slots[Number(epEl.getAttribute('data-slot-endpoint'))].endpoint = epEl.value;
    }
    if (roleEl || modelEl || mmEl || epEl) {
      await saveAssembly();
      if (roleEl || modelEl) renderVisionModal();
    }
  };
}

window.addEventListener('DOMContentLoaded', () => {
  const btn = $vs('btn-vision-settings');
  if (btn) btn.onclick = openVisionSettings;
});
if (api.onVisionStatus) {
  api.onVisionStatus((p) => paintVisionStatus(p));
}

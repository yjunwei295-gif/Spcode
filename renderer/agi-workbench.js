import { t } from './i18n.js';

/** 调度事件的终态对应工作台文案。排队和运行根据任务所用资源分别展示。 */
const terminalLabels = {
  completed: 'agiParallelCompleted', blocked: 'agiParallelBlocked', interrupted: 'agiParallelInterrupted'
};

/**
 * 为排队或运行中的子代理创建卡片。目标来自用户正文，只作为文字填入。
 * @param {Document} document 当前聊天文档。
 * @param {object} task 后端发布的目标、资源和活动状态。
 * @returns {HTMLLIElement} 活动任务卡片。
 */
function makeCard(document, task) {
  const card = document.createElement('li');
  card.className = 'agi-workbench-card';
  card.dataset.status = task.status;
  card.dataset.resource = task.resource;
  const header = document.createElement('div');
  header.className = 'agi-workbench-card-head';
  const resource = document.createElement('span');
  resource.className = 'agi-workbench-resource';
  const desktop = task.resource === 'desktop';
  resource.textContent = t(desktop ? 'agiWorkbenchDesktopResource' : 'agiWorkbenchProjectResource');
  const status = document.createElement('span');
  status.className = 'agi-workbench-state';
  const label = task.status === 'running'
    ? (desktop ? 'agiParallelDesktop' : 'running')
    : (desktop ? 'agiParallelWaitingDesktop' : 'agiParallelQueued');
  status.textContent = t(label);
  const goal = document.createElement('strong');
  goal.className = 'agi-workbench-goal';
  goal.textContent = task.goal;
  header.append(resource, status);
  card.append(header, goal);
  return card;
}

/**
 * 显示已关闭子代理的实际回执，直接保留结果或受阻原因。
 * @param {Document} document 当前聊天文档。
 * @param {object} task 已结束任务的目标、状态和回执文本。
 * @param {string} label 终态对应的国际化键。
 * @returns {HTMLLIElement} 本轮结果列表的一条纯文本回执。
 */
function makeReceipt(document, task, label) {
  const item = document.createElement('li');
  item.className = 'agi-workbench-receipt';
  item.dataset.status = task.status;
  const header = document.createElement('div');
  header.className = 'agi-workbench-card-head';
  const goal = document.createElement('strong');
  goal.className = 'agi-workbench-goal';
  goal.textContent = task.goal;
  const state = document.createElement('span');
  state.className = 'agi-workbench-state';
  state.textContent = t(label);
  const result = document.createElement('p');
  result.className = 'agi-workbench-result';
  result.textContent = task.result;
  header.append(goal, state);
  item.append(header, result);
  return item;
}

/**
 * 渲染当前会话的独立工作台。
 * @param {HTMLElement} panel 工作台根节点。
 * @param {Array<object>|undefined} tasks 发起会话的本轮状态和回执；轮次结束时清空并隐藏。
 * @returns {void} 关闭的子代理从活动卡片移除，回执留到本轮结束，不移动窗口和输入焦点。
 */
export function renderAgiWorkbench(panel, tasks) {
  const list = panel.querySelector('[data-workbench-tasks]');
  const receiptList = panel.querySelector('[data-workbench-receipts]');
  list.replaceChildren();
  receiptList.replaceChildren();
  panel.hidden = !tasks?.length;
  if (panel.hidden) return;

  const desktop = panel.querySelector('[data-workbench-desktop]');
  const document = panel.ownerDocument;
  const active = document.createDocumentFragment();
  const receipts = document.createDocumentFragment();
  let running = 0;
  let desktopCount = 0;
  let waiting = 0;
  let owner = '';
  for (const task of tasks) {
    const terminalLabel = terminalLabels[task.status];
    if (terminalLabel) {
      receipts.append(makeReceipt(document, task, terminalLabel));
      continue;
    }
    if (task.status === 'running') running++;
    if (task.resource === 'desktop') {
      desktopCount++;
      if (task.status === 'running') owner = task.goal;
      if (task.status === 'queued') waiting++;
    }
    active.append(makeCard(document, task));
  }
  desktop.hidden = desktopCount === 0;
  desktop.querySelector('strong').textContent = owner || t('agiWorkbenchDesktopIdle');
  desktop.querySelector('[data-workbench-waiting]').textContent = t('agiWorkbenchWaitingCount').replace('{count}', waiting);

  const count = panel.querySelector('[data-workbench-count]');
  const activeCount = active.childElementCount;
  count.hidden = activeCount === 0;
  count.textContent = t('agiParallelCount').replace('{running}', running).replace('{total}', activeCount);
  list.hidden = activeCount === 0;
  panel.querySelector('[data-workbench-results]').hidden = receipts.childElementCount === 0;
  list.append(active);
  receiptList.append(receipts);
}

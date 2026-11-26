import { t } from './i18n.js';

/** 工作台仍有活动子代理时，可以展示已完成和受阻任务的回执。 */
const receiptLabels = {
  completed: 'agiParallelCompleted', blocked: 'agiParallelBlocked'
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
 * 为已完成或受阻的子代理创建回执，在工作台仍有活动任务时呈现结果或受阻原因。
 * @param {Document} document 当前聊天文档。
 * @param {object} task 已完成或受阻任务的目标、状态和回执文本。
 * @param {string} label 完成或受阻状态对应的国际化键。
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
 * 仅在当前会话有排队或运行中的子代理时显示工作台。
 * @param {HTMLElement} panel 工作台根节点。
 * @param {Array<object>|undefined} tasks 发起会话的本轮子代理状态和回执。
 * @returns {void} 跳过已停止的任务，最后一个活动任务结束时清空并收起面板，保留窗口和输入焦点。
 */
export function renderAgiWorkbench(panel, tasks) {
  const list = panel.querySelector('[data-workbench-tasks]');
  const receiptList = panel.querySelector('[data-workbench-receipts]');
  list.replaceChildren();
  receiptList.replaceChildren();
  if (!tasks?.length) {
    panel.hidden = true;
    return;
  }

  const desktop = panel.querySelector('[data-workbench-desktop]');
  const document = panel.ownerDocument;
  const active = document.createDocumentFragment();
  const receipts = document.createDocumentFragment();
  let running = 0;
  let desktopCount = 0;
  let waiting = 0;
  let owner = '';
  for (const task of tasks) {
    // 停止事件仍由原调度链路记录，工作台只移除对应展示。
    if (task.status === 'interrupted') continue;
    const receiptLabel = receiptLabels[task.status];
    if (receiptLabel) {
      receipts.append(makeReceipt(document, task, receiptLabel));
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
  const activeCount = active.childElementCount;
  panel.hidden = activeCount === 0;
  if (panel.hidden) return;

  desktop.hidden = desktopCount === 0;
  desktop.querySelector('strong').textContent = owner || t('agiWorkbenchDesktopIdle');
  desktop.querySelector('[data-workbench-waiting]').textContent = t('agiWorkbenchWaitingCount').replace('{count}', waiting);

  const count = panel.querySelector('[data-workbench-count]');
  count.textContent = t('agiParallelCount').replace('{running}', running).replace('{total}', activeCount);
  panel.querySelector('[data-workbench-results]').hidden = receipts.childElementCount === 0;
  list.append(active);
  receiptList.append(receipts);
}

// 图片数据只缓存于当前页面，消息历史仅保存文件路径，避免把大图重复写入会话。
const previews = new Map();

/** 更新一条独立绘图任务；生成端未给出的字段保留原值，不伪造百分比。 */
export function updateImageTask(message, event) {
  if (!message.imageGenerations) message.imageGenerations = [];
  let task = message.imageGenerations.find(function sameTask(item) { return item.taskId === event.taskId; });
  if (!task) {
    task = { taskId: event.taskId };
    message.imageGenerations.push(task);
  }
  Object.assign(task, event);
  return task;
}

/** 渲染当前会话的绘图画布，按任务展示真实进度、失败信息及完成图片。 */
export function renderImageCanvas(root, tab, api, zoom, workspace) {
  const tasks = [];
  for (const message of tab?.messages || []) {
    for (const task of message.imageGenerations || []) tasks.push({ task, active: message === tab.liveAssistant && tab.sending });
  }
  root.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement('p');
    empty.className = 'image-canvas-empty';
    empty.textContent = '在对话里提出绘图需求，生成过程和图片会展示在这里';
    root.append(empty);
    return;
  }
  for (let index = tasks.length - 1; index >= 0; index--) {
    const task = tasks[index].task;
    const card = document.createElement('article');
    card.className = 'image-canvas-card';
    card.dataset.imageTask = task.taskId;
    const header = document.createElement('header');
    const name = document.createElement('strong');
    name.textContent = task.model || '绘图';
    const status = document.createElement('span');
    const interrupted = task.status === 'running' && !tasks[index].active;
    if (interrupted) status.textContent = '未完成';
    else if (task.status === 'failed') status.textContent = '生成失败';
    else if (task.status === 'cancelled') status.textContent = '已停止';
    else if (task.status === 'completed') status.textContent = '100%';
    else status.textContent = Number.isFinite(task.percent) ? task.percent + '%' : '进度未知';
    header.append(name, status);
    const imageArea = document.createElement('div');
    imageArea.className = 'image-canvas-preview';
    const info = document.createElement('p');
    info.className = 'image-canvas-status';
    info.textContent = task.text || '';
    if (task.rel) {
      const image = document.createElement('img');
      image.alt = task.prompt || '生成图片';
      image.onclick = function enlargeImage() { if (image.src) zoom(image.src); };
      imageArea.append(image);
      const previewKey = workspace + '|' + task.rel;
      if (!previews.has(previewKey)) previews.set(previewKey, api.readWorkspaceFile(task.rel));
      previews.get(previewKey).then(function showImage(data) {
        if (!image.isConnected) return;
        if (data.kind !== 'image') throw new Error('生成结果不是可预览图片');
        image.src = data.content;
      }).catch(function showPreviewError(error) {
        previews.delete(previewKey);
        info.textContent = '图片读取失败：' + error.message;
      });
      const reveal = document.createElement('button');
      reveal.type = 'button';
      reveal.textContent = '打开图片位置';
      reveal.onclick = function revealFile() { api.showInFolder(task.rel); };
      card.append(reveal);
    } else {
      const placeholder = document.createElement('span');
      placeholder.textContent = task.status === 'running' && !interrupted ? '正在绘制' : status.textContent;
      imageArea.append(placeholder);
    }
    if (task.status === 'running' && !interrupted) {
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.setAttribute('aria-label', '绘图进度');
      if (Number.isFinite(task.percent)) progress.value = task.percent;
      card.append(progress);
    }
    const prompt = document.createElement('p');
    prompt.className = 'image-canvas-prompt';
    prompt.textContent = task.prompt || '';
    card.prepend(header, imageArea);
    card.append(info, prompt);
    root.append(card);
  }
}

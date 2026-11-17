/** 对话媒体卡片：保存文件引用，按需加载图片和本地视频，不把视频字节塞进会话。 */
// 仅保留当前已渲染卡片的数据；切换会话、清空消息或移除卡片时淘汰旧图片 Promise。
const previews = new Map();

/** 从生成事件与已有消息记录提取图片、视频，按路径去重；删除记录不产生预览。 */
export function messageMedia(message) {
  const items = [];
  const seen = new Set();
  const candidates = [...(message.generatedMedia || [])];
  for (const task of message.imageGenerations || []) {
    if (task.status === 'completed' && task.rel) candidates.push({ path: task.rel });
  }
  for (const change of message.changes || []) {
    if (change.type !== 'delete' && change.action !== 'delete') candidates.push(change);
  }
  for (const item of candidates) {
    const path = String(item.path || '').replace(/\\/g, '/');
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    let kind;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) kind = 'image';
    else if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) kind = 'video';
    else continue;
    if (seen.has(path)) continue;
    seen.add(path);
    items.push({ path, kind, name: path.slice(path.lastIndexOf('/') + 1) });
  }
  return items;
}

/** 仅生成受控图片/视频标签，文件路径和名称转义后进入属性，不执行生成文件中的代码。 */
export function mediaCardsHtml(message, escapeHtml) {
  const cards = [];
  for (const item of messageMedia(message)) {
    const media = item.kind === 'video'
      ? '<video controls playsinline preload="metadata"></video>'
      : '<img loading="lazy" alt="' + escapeHtml(item.name) + '">';
    cards.push('<figure class="chat-media-card" data-media-path="' + encodeURIComponent(item.path) + '" data-media-kind="' + item.kind + '">' + media + '<figcaption>' + escapeHtml(item.name) + '</figcaption><p class="chat-media-error" hidden></p></figure>');
  }
  return cards.length ? '<div class="chat-media-gallery">' + cards.join('') + '</div>' : '';
}

/** 保留已加载的视频节点，流式回复或文件事件重绘时不让用户正在播放的视频重新下载。 */
export function existingMediaPlayers(root) {
  const players = new Map();
  for (const card of root.querySelectorAll('[data-media-path]')) {
    const video = card.querySelector('video[src]');
    if (video) players.set(card.closest('[data-msg-i]').dataset.msgI + ':' + card.dataset.mediaPath, { video, playing: !video.paused });
  }
  return players;
}

/** 停止不再展示的视频并释放媒体源；仅处理未被新界面复用的节点，保留在播视频的位置。 */
export function releaseMediaPlayers(players) {
  for (const prior of players.values()) {
    prior.video.pause();
    prior.video.removeAttribute('src');
    prior.video.load();
  }
  players.clear();
}

/** 为卡片读取真实文件；缓存随当前卡片生命周期收缩，视频按需读取本地文件。 */
export function loadMediaPreviews(root, api, workspace, players) {
  const cards = root.querySelectorAll('[data-media-path]');
  const activeKeys = new Set();
  for (const card of cards) activeKeys.add(workspace + '|' + decodeURIComponent(card.dataset.mediaPath));
  for (const key of previews.keys()) {
    if (!activeKeys.has(key)) previews.delete(key);
  }
  for (const card of cards) {
    const path = decodeURIComponent(card.dataset.mediaPath);
    const kind = card.dataset.mediaKind;
    const errorBox = card.querySelector('.chat-media-error');
    function showError(error) {
      errorBox.hidden = false;
      errorBox.textContent = '预览失败：' + error.message;
    }
    const playerKey = card.closest('[data-msg-i]').dataset.msgI + ':' + card.dataset.mediaPath;
    const prior = players.get(playerKey);
    if (kind === 'video' && prior) {
      card.querySelector('video').replaceWith(prior.video);
      players.delete(playerKey);
      if (prior.playing) prior.video.play().catch(showError);
      continue;
    }
    const key = workspace + '|' + path;
    if (!previews.has(key)) previews.set(key, api.readWorkspaceFile(path));
    const request = previews.get(key);
    request.then(function showMedia(data) {
      if (!card.isConnected) return;
      if (data.kind !== kind) throw new Error('文件类型与媒体预览不一致');
      const media = card.querySelector(kind === 'video' ? 'video' : 'img');
      media.addEventListener('error', function decodeFailed() { showError(new Error('文件缺失或格式无法解码')); }, { once: true });
      media.src = data.content;
      if (kind === 'image') media.dataset.zoomSrc = data.content;
    }).catch(function readFailed(error) {
      // 已离开的旧请求失败时，只释放自身，不删除新会话为同一路径发起的新请求。
      if (previews.get(key) === request) previews.delete(key);
      if (card.isConnected) showError(error);
    });
  }
  releaseMediaPlayers(players);
}

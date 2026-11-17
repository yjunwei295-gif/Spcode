/**
 * 将 sd-cli 的分块日志转换为真实采样进度。
 * stdout、stderr 各自建立读取器，保留跨块尾部；只有完整步数记录才通知调用方。
 */
function createSdProgressReader(onProgress) {
  let tail = '';
  let lastStep = '';
  return function readProgress(chunk) {
    tail = (tail + chunk.toString('utf8')).slice(-4096);
    const pattern = /\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)(s\/it|it\/s)/g;
    let hit;
    let consumed = 0;
    while ((hit = pattern.exec(tail)) !== null) {
      consumed = pattern.lastIndex;
      const step = Number(hit[1]);
      const total = Number(hit[2]);
      if (total <= 0 || step > total) continue;
      const key = step + '/' + total;
      if (key === lastStep) continue;
      lastStep = key;
      onProgress({ phase: 'sampling', step, total, percent: Math.floor(step * 100 / total),
        text: '本地生图中：第 ' + key + ' 步（' + hit[3] + hit[4] + '）' });
    }
    // 已消费的日志不重复扫描，未完成的记录保留到下一块。
    tail = tail.substring(consumed);
  };
}
module.exports = { createSdProgressReader };

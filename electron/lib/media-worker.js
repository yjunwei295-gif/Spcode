const { parentPort } = require('worker_threads');
const { parseAttachment } = require('./media-core');

parentPort.on('message', async ({ abs }) => {
  try {
    const result = await parseAttachment(abs);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
});

// Cursor SDK 的内存对话库：会话本来就不跨进程复用，不需要落盘。
// SDK 自带的 JsonlLocalAgentStore 每追加一个事件都整份读出、解析、再整份写回 run_events.ndjson，
// 会话越长越慢（十几 MB 时每个文字片段要等约 0.35 秒），模型吐字就变成一个字一个字地蹦
const TERMINAL_RUN = new Set(['finished', 'error', 'cancelled', 'expired']);

function createMemoryStore(sdk) {
  const agents = new Map();
  const runs = new Map();
  const events = new Map();
  const blobs = new Map();
  const blobKey = (agentId, blobId) => `${agentId}\n${blobId}`;
  const hit = (list, v) => !list || !list.length || list.includes(v);

  const agentStore = {
    async get({ agentId }) {
      const a = agents.get(agentId);
      return a ? structuredClone(a) : null;
    },
    async create({ agent }) {
      if (agents.has(agent.agentId)) throw new Error(`Agent ${agent.agentId} already exists`);
      agents.set(agent.agentId, structuredClone(agent));
      return structuredClone(agent);
    },
    async update({ agent }) {
      if (!agents.has(agent.agentId)) throw new Error(`Agent ${agent.agentId} not found`);
      agents.set(agent.agentId, structuredClone(agent));
      return structuredClone(agent);
    },
    async delete({ filter }) {
      for (const a of [...agents.values()]) {
        if (hit(filter?.agentIds, a.agentId) && (filter?.cwd === undefined || a.cwd === filter.cwd)) agents.delete(a.agentId);
      }
    },
    async list(input) {
      return sdk.paginateAgentDocuments([...agents.values()].map((a) => structuredClone(a)), input?.filter);
    }
  };

  const checkpointStore = {
    async get({ agentId, blobId }) {
      const b = blobs.get(blobKey(agentId, blobId));
      return b ? new Uint8Array(b.data) : null;
    },
    async create({ agentId, blobId, data }) {
      const k = blobKey(agentId, blobId);
      if (blobs.has(k)) throw new Error(`Checkpoint blob ${blobId} already exists for agent ${agentId}`);
      blobs.set(k, { agentId, blobId, data: new Uint8Array(data) });
    },
    async update({ agentId, blobId, data }) {
      blobs.set(blobKey(agentId, blobId), { agentId, blobId, data: new Uint8Array(data) });
    },
    async delete({ filter }) {
      for (const [k, b] of [...blobs]) {
        if (hit(filter?.agentIds, b.agentId) && hit(filter?.blobIds, b.blobId)) blobs.delete(k);
      }
    },
    async list(input) {
      const f = input?.filter;
      const ids = [...blobs.values()].filter((b) => hit(f?.agentIds, b.agentId) && hit(f?.blobIds, b.blobId)).map((b) => b.blobId);
      return sdk.paginateCheckpointBlobIds(ids, f);
    }
  };

  const runMatch = (r, f) => hit(f?.agentIds, r.agentId) && hit(f?.runIds, r.runId);
  const runStore = {
    async get({ agentId, runId }) {
      const r = runs.get(runId);
      return r && r.agentId === agentId ? structuredClone(r) : null;
    },
    async create({ run }) {
      // 同一会话开新一轮时，前几轮已结束的事件流不会再被读，丢掉免得内存越积越多
      for (const r of runs.values()) {
        if (r.agentId === run.agentId && r.runId !== run.runId && TERMINAL_RUN.has(r.status)) events.delete(r.runId);
      }
      runs.set(run.runId, structuredClone(run));
      return structuredClone(run);
    },
    async update({ run }) {
      runs.set(run.runId, structuredClone(run));
      return structuredClone(run);
    },
    async delete({ filter }) {
      for (const r of [...runs.values()]) {
        if (!runMatch(r, filter)) continue;
        runs.delete(r.runId);
        events.delete(r.runId);
      }
    },
    async list(input) {
      const f = input?.filter;
      return sdk.paginateRunDocuments([...runs.values()].filter((r) => runMatch(r, f)).map((r) => structuredClone(r)), f);
    }
  };

  const eventStore = {
    async append({ runId, eventType, payload, payloadRef, idempotencyKey }) {
      let list = events.get(runId);
      if (!list) events.set(runId, (list = []));
      if (idempotencyKey) {
        const dup = list.find((e) => e.idempotencyKey === idempotencyKey);
        if (dup) return { ...dup };
      }
      const seq = list.length ? list[list.length - 1].seq + 1 : 1;
      const doc = {
        runId, seq, offset: String(seq), eventType,
        payload: payload ?? null, payloadRef: payloadRef ?? null,
        idempotencyKey: idempotencyKey ?? null, createdAt: Date.now()
      };
      list.push(doc);
      return { ...doc };
    },
    async list({ runId, afterOffset, limit }) {
      const after = Number.parseInt(afterOffset ?? '0', 10) || 0;
      const n = limit ?? 100;
      const rest = (events.get(runId) || []).filter((e) => e.seq > after);
      const items = rest.slice(0, n).map((e) => ({ ...e }));
      return rest.length > items.length && items.length ? { items, nextOffset: items[items.length - 1].offset } : { items };
    },
    async delete({ filter }) {
      if (!filter?.runIds?.length) { events.clear(); return; }
      for (const id of filter.runIds) events.delete(id);
    }
  };

  const store = sdk.composeLocalAgentStore({ agents: agentStore, checkpoints: checkpointStore, runs: runStore, runEvents: eventStore });

  /** 会话关掉后清掉它的全部记录 */
  function dropAgent(agentId) {
    if (!agentId) return;
    agents.delete(agentId);
    for (const r of [...runs.values()]) {
      if (r.agentId !== agentId) continue;
      runs.delete(r.runId);
      events.delete(r.runId);
    }
    for (const [k, b] of [...blobs]) {
      if (b.agentId === agentId) blobs.delete(k);
    }
  }

  return { store, dropAgent };
}

module.exports = { createMemoryStore };

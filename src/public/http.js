/**
 * 可选的 HTTP 适配层：把 Workbench 暴露为 JSON API，便于“重复调用、重放、恢复”。
 * 内核本身不依赖 HTTP；这里只用 node:http，无第三方框架。
 *
 * 路由：
 *   POST /snapshots                         发布路由树版本
 *   GET  /versions                          列出快照版本
 *   POST /resolve                           解析 { request, version?, policy? }
 *   GET  /explanations/:id/summary          摘要（默认公开视图）
 *   GET  /explanations/:id/compact          紧凑视图（含淘汰原因码）
 *   POST /explanations/:id/expand           按 ref 展开单个候选
 *   GET  /explanations/:id/layers/:layer    分页淘汰明细
 *   POST /explanations/:id/sample           生成回归样本
 *   POST /replay                            重放样本（见版本差异）
 *   POST /restore                           重放并登记恢复会话
 */
import http from 'node:http';
import { STATUS_BY_REASON, Reason } from '../core/errors.js';
import { Workbench } from '../core/workbench.js';

function readJson(req) {
  return new Promise((resolveJson, rejectJson) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolveJson({});
      try {
        resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        rejectJson(err);
      }
    });
    req.on('error', rejectJson);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

/**
 * @param {Workbench} workbench
 * @returns {(req:http.IncomingMessage,res:http.ServerResponse)=>void}
 */
export function createRequestListener(workbench) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://workbench.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      // ── 快照 ──
      if (method === 'POST' && path === '/snapshots') {
        const body = await readJson(req);
        const meta = await workbench.publish(body.routeTree, body.meta ?? {});
        return send(res, 201, meta);
      }
      if (method === 'GET' && path === '/versions') {
        return send(res, 200, { versions: workbench.snapshots.list() });
      }

      // ── 解析 ──
      if (method === 'POST' && path === '/resolve') {
        const body = await readJson(req);
        const explanation = await workbench.resolve(body.request, {
          version: body.version,
          policy: body.policy
        });
        return send(res, 200, {
          explanationId: explanation.id,
          correlationId: explanation.correlationId,
          httpStatus: explanation.status ?? STATUS_BY_REASON[explanation.reason] ?? 200,
          summary: workbench.view(explanation.id)
        });
      }

      // ── 解释视图 ──
      let m = path.match(/^\/explanations\/([^/]+)\/(summary|compact)$/);
      if (method === 'GET' && m) {
        const [, id, kind] = m;
        const view = kind === 'summary' ? workbench.view(id) : workbench.compact(id);
        return send(res, 200, view);
      }

      m = path.match(/^\/explanations\/([^/]+)\/expand$/);
      if (method === 'POST' && m) {
        const body = await readJson(req);
        return send(res, 200, workbench.expand(m[1], body.ref));
      }

      m = path.match(/^\/explanations\/([^/]+)\/layers\/([^/]+)$/);
      if (method === 'GET' && m) {
        const page = {
          offset: Number(url.searchParams.get('offset') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 50)
        };
        return send(res, 200, workbench.expandEliminations(m[1], m[2], page));
      }

      m = path.match(/^\/explanations\/([^/]+)\/sample$/);
      if (method === 'POST' && m) {
        return send(res, 201, workbench.sample(m[1]));
      }

      // ── 重放/恢复 ──
      if (method === 'POST' && (path === '/replay' || path === '/restore')) {
        const body = await readJson(req);
        const report =
          path === '/replay' ? await workbench.replay(body.sample) : await workbench.restore(body.sample);
        return send(res, 200, report);
      }

      return send(res, 404, { error: 'NOT_FOUND', path });
    } catch (err) {
      if (err.reason === Reason.SNAPSHOT_UNKNOWN) return send(res, 409, { error: err.reason, message: err.message });
      return send(res, 500, { error: err.name, message: err.message });
    }
  };
}

export function startServer(workbench, { port = 0 } = {}) {
  const server = http.createServer(createRequestListener(workbench));
  return new Promise((s) => {
    server.listen(port, () => s(server));
  });
}

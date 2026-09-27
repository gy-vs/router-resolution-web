/**
 * 公开结果投影与 HTTP 端到端：
 *  - summary 体积与路由表大小无关，不含任何无关路由的完整对象；
 *  - compact 只有原因码 + ref；完整定义必须经 expand 按需取回；
 *  - expandLayer 分页；
 *  - HTTP：重复调用 /resolve、/replay、/restore 的数据链一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, toCompact, toSummary } from '../src/public/index.js';
import { startServer } from '../src/public/http.js';

/** 构造 N 条带独特“秘密”标记的大路由表。 */
function bigTree(n) {
  const routes = [];
  for (let i = 0; i < n; i += 1) {
    routes.push({
      id: `r${i}`,
      path: i % 2 === 0 ? `/items/${i}/:id` : `/things/${i}/:id`,
      methods: ['GET'],
      // 独特处理器 id 与描述字段，只有显式 expand 该候选时才允许出现在结果里
      handler: `secret-handler-${i}`,
      description: `SECRET_MARKER_${i}`
    });
  }
  // 目标实际会命中的路由
  routes.push({
    id: 'winner-route',
    path: '/hit/:id',
    methods: ['GET'],
    handler: 'open-handler',
    paramRules: [{ name: 'id', type: 'int' }]
  });
  return {
    apps: [
      {
        id: 'app',
        hosts: ['big.example.com'],
        mounts: [{ id: 'm', path: '/', routes }]
      }
    ]
  };
}

test('summary 体积与路由表规模无关，且不含无关路由的完整对象/秘密标记', async () => {
  const N = 500;
  const wb = new Workbench();
  wb.publish(bigTree(N));
  wb.registerHandler('open-handler', () => ({ ok: true }));

  const ex = await wb.resolve({ method: 'GET', host: 'big.example.com', target: '/hit/7' });
  const summary = wb.view(ex.id);
  const json = JSON.stringify(summary);

  // 无关路由的秘密标记一个都不能出现在公开摘要里
  for (let i = 0; i < 50; i += 1) {
    assert.ok(!json.includes(`SECRET_MARKER_${i}`), `摘要泄漏了路由 r${i} 的描述`);
    assert.ok(!json.includes(`secret-handler-${i}`), `摘要泄漏了路由 r${i} 的处理器 id`);
  }
  assert.ok(!json.includes('SECRET_MARKER_499'));

  // 摘要直接给获胜者与最终参数
  assert.equal(summary.winner.routeId, 'winner-route');
  assert.equal(summary.finalParams.scopes.resource.id, 7);
  assert.equal(summary.reason, 'MATCHED');

  // 规模对照：10 条与 500 条路由的 summary 主体大小差应远小于路由对象增量
  const small = new Workbench();
  small.publish(bigTree(10));
  small.registerHandler('open-handler', () => ({ ok: true }));
  const exSmall = await small.resolve({ method: 'GET', host: 'big.example.com', target: '/hit/7' });
  const smallJson = JSON.stringify(toSummary(exSmall));
  // 500 条表的摘要最多比 10 条表大一点点（只允许计数/时间等），绝不是 50 倍
  assert.ok(json.length < smallJson.length * 3, `大表摘要异常膨胀: ${json.length} vs ${smallJson.length}`);
});

test('compact 仅含原因码与 ref，完整对象经 expand 按需取回', async () => {
  const wb = new Workbench();
  wb.publish(bigTree(20));
  wb.registerHandler('open-handler', () => ({ ok: true }));

  const ex = await wb.resolve({ method: 'GET', host: 'big.example.com', target: '/hit/7' });
  const compact = toCompact(ex);
  const json = JSON.stringify(compact);
  assert.ok(!json.includes('SECRET_MARKER_19'));
  assert.ok(!json.includes('secret-handler-19'));

  // 显式展开任意候选，得到完整定义
  const ref = { appId: 'app', mountId: 'm', routeId: 'r19' };
  const expanded = wb.expand(ex.id, ref);
  assert.equal(expanded.ok, true);
  assert.equal(expanded.route.handler, 'secret-handler-19');
  // 展开结果带快照版本（数据链）
  assert.equal(expanded.snapshotVersion, ex.snapshotVersion);

  // 未知候选
  const missing = wb.expand(ex.id, { appId: 'app', mountId: 'm', routeId: 'nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'CANDIDATE_UNKNOWN');
});

test('淘汰明细分页：大表 NO_MATCH 时每页有限、总计准确', async () => {
  const wb = new Workbench();
  wb.publish(bigTree(120));
  const ex = await wb.resolve({ method: 'GET', host: 'big.example.com', target: '/does/not/exist' });
  assert.equal(ex.reason, 'NO_MATCH');

  // 120 条路由全部结构不匹配（winner-route 也不匹配）
  const page1 = wb.expandEliminations(ex.id, 'resource', { offset: 0, limit: 25 });
  assert.equal(page1.total, 121);
  assert.equal(page1.items.length, 25);
  const page5 = wb.expandEliminations(ex.id, 'resource', { offset: 100, limit: 25 });
  assert.equal(page5.items.length, 21);
  // 明细只有原因码与 ref，不含完整对象
  const pageJson = JSON.stringify(page1);
  assert.ok(!pageJson.includes('SECRET_MARKER_'));
  assert.ok(pageJson.includes('LITERAL_MISMATCH') || pageJson.includes('SEGMENT_COUNT_MISMATCH'));
});

test('HTTP 端到端：发布 -> 重复 resolve -> 样本 -> 重放 -> 恢复，版本链一致', async () => {
  const wb = new Workbench();
  wb.registerHandler('open-handler', () => ({ ok: true, body: { ok: 1 } }));
  const server = await startServer(wb, { port: 0 });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, init) => {
    const res = await fetch(base + path, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init?.body ? JSON.stringify(init.body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    // 发布
    const pub = await call('/snapshots', { method: 'POST', body: { routeTree: bigTree(10) } });
    assert.equal(pub.status, 201);
    const version = pub.body.version;

    // 重复调用 resolve：两次解释各自有 id，但候选/参数一致
    const reqBody = {
      request: { method: 'GET', host: 'big.example.com', target: '/hit/7' }
    };
    const r1 = await call('/resolve', { method: 'POST', body: reqBody });
    const r2 = await call('/resolve', { method: 'POST', body: reqBody });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.body.explanationId, r2.body.explanationId);
    assert.equal(r1.body.summary.snapshotVersion, version);
    assert.equal(r2.body.summary.snapshotVersion, version);
    assert.equal(r1.body.summary.finalParams.scopes.resource.id, 7);

    // summary / compact 视图
    const sum = await call(`/explanations/${r1.body.explanationId}/summary`);
    assert.equal(sum.body.reason, 'MATCHED');
    const compact = await call(`/explanations/${r1.body.explanationId}/compact`);
    assert.equal(compact.body.view, 'compact');

    // 展开候选
    const exp = await call(`/explanations/${r1.body.explanationId}/expand`, {
      method: 'POST',
      body: { ref: { appId: 'app', mountId: 'm', routeId: 'r3' } }
    });
    assert.equal(exp.body.route.handler, 'secret-handler-3');

    // 生成样本
    const sample = await call(`/explanations/${r1.body.explanationId}/sample`, { method: 'POST' });
    assert.equal(sample.status, 201);
    assert.equal(sample.body.boundSnapshotVersion, version);

    // 重放：当前版本即绑定版本，指纹一致
    const replay = await call('/replay', { method: 'POST', body: { sample: sample.body } });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.expectationMatched, true);
    assert.equal(replay.body.currentIsBound, true);

    // 恢复：新工作台也可吃同一份样本（这里直接在同服务 restore，登记为新解释会话）
    const restore = await call('/restore', { method: 'POST', body: { sample: sample.body } });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.expectationMatched, true);
    assert.equal(restore.body.summary.reason, 'MATCHED');
    assert.equal(restore.body.summary.finalParams.scopes.resource.id, 7);

    // 版本列表仍只有一个版本
    const versions = await call('/versions');
    assert.equal(versions.body.versions.length, 1);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

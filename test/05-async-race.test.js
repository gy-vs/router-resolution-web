/**
 * 异步查询竞态：
 *  - 查询层查询与服务端计算在受控总线下乱序完成，解释仍按固定层级顺序组装，
 *    asyncEvidence.outOfOrder=true，但结果与 FIFO 一致；
 *  - 同一作业的迟到“重复响应”不得二次应用（即使内容是另一条路由的结果）；
 *  - 两个解释并发跑在同一总线上，响应严格按 correlationId 隔离，不串扰；
 *  - 解释结束后迟到的外域响应进总线 foreign 账本，不影响已完成解释。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, CorrelationBus, ControlledBackend, Reason } from '../src/public/index.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function raceTree() {
  return {
    apps: [
      {
        id: 'race',
        hosts: ['race.example.com'],
        mounts: [
          {
            id: 'root',
            path: '/',
            routes: [
              { id: 'u', path: '/users/:id', methods: ['GET'], handler: 'hu',
                paramRules: [{ name: 'id', type: 'int' }] },
              { id: 'o', path: '/orgs/:id', methods: ['GET'], handler: 'ho',
                paramRules: [{ name: 'id', type: 'slug' }] }
            ]
          }
        ]
      }
    ]
  };
}

function benchWithBackend() {
  const backend = new ControlledBackend();
  const bus = new CorrelationBus(backend);
  const wb = new Workbench({ bus });
  wb.publish(raceTree());
  wb.registerHandler('hu', () => ({ ok: true, body: { kind: 'user' } }));
  wb.registerHandler('ho', () => ({ ok: true, body: { kind: 'org' } }));
  return { wb, backend, bus };
}

/** 排空后端：每轮 tick 让 resolver 续跑并提交下一层作业。 */
async function settleAll(backend, valueFor) {
  let guard = 0;
  while (backend.pending.length > 0 && guard < 100) {
    guard += 1;
    const entry = backend.pending[0];
    await backend.settle(entry, valueFor ? valueFor(entry) : undefined);
    await tick();
  }
  if (guard >= 100) throw new Error('settleAll 超过保护轮数，可能死锁');
}

test('乱序完成：query 晚于 compute，解释层序不乱，结果正确且 outOfOrder=true', async () => {
  const { wb, backend } = benchWithBackend();
  const promise = wb.resolve({ method: 'GET', host: 'race.example.com', target: '/users/5' });
  await tick();

  // 流水线逐层提交：先排空前四层
  for (const kind of ['app-host-scan', 'mount-prefix-scan', 'resource-route-query', 'method-check']) {
    await backend.settle(backend.byKind(kind));
    await tick();
  }

  // 此刻 query 与 compute 均已提交
  const query = backend.byKind('query-layer-query');
  const computes = backend.pending.filter((p) => p.kind === 'server-compute');
  assert.ok(query);
  assert.equal(computes.length, 1);

  // 先 settle compute（乱序：它本应在 query 之后被消费）
  await backend.settle(computes[0]);
  await tick();
  // 再 settle query
  await backend.settle(query);
  await tick();
  // 其余作业按默认顺序
  await settleAll(backend);

  const ex = await promise;
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.winner.routeId, 'u');
  assert.equal(ex.finalParams.scopes.resource.id, 5);
  assert.equal(ex.asyncEvidence.outOfOrder, true);

  // 层序固定：rankTable 与 serverCompute 各自就位，handler 仍然执行
  assert.equal(ex.layers.handler.jobs.length, 1);
  assert.equal(ex.serverCompute.length, 1);
  // 完成序号里 compute 在 query 之前
  const seqOf = (jobId) =>
    Object.values(ex.layers)
      .flatMap((l) => l.jobs)
      .find((j) => j.jobId === jobId)?.seq;
  const qId = ex.layers.query.jobs[0].jobId;
  const cId = ex.layers.compute.jobs[0].jobId;
  assert.ok(seqOf(cId) < seqOf(qId), 'compute 的完成序号应早于 query');
});

test('FIFO 基线下同样的请求 outOfOrder=false', async () => {
  const wb = new Workbench();
  wb.publish(raceTree());
  wb.registerHandler('hu', () => ({ ok: true }));
  wb.registerHandler('ho', () => ({ ok: true }));
  const ex = await wb.resolve({ method: 'GET', host: 'race.example.com', target: '/users/5' });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.asyncEvidence.outOfOrder, false);
  assert.equal(ex.asyncEvidence.staleIgnored, 0);
});

test('迟到重复响应携带另一候选的结果，被记为 stale 且绝不改变获胜者/参数', async () => {
  const { wb, backend } = benchWithBackend();
  const promise = wb.resolve({ method: 'GET', host: 'race.example.com', target: '/users/5' });
  await tick();

  // 正常推进到 compute：/users/:id 只有一个方法存活候选 -> 一个 compute
  await backend.settle(backend.byKind('app-host-scan'));
  await tick();
  await backend.settle(backend.byKind('mount-prefix-scan'));
  await tick();
  await backend.settle(backend.byKind('resource-route-query'));
  await tick();
  await backend.settle(backend.byKind('method-check'));
  await tick();

  const computeEntry = backend.byKind('server-compute');
  await backend.settle(computeEntry, { value: { routeId: 'u', computed: { stage: 'first' } } });

  // 查询层此时才 settle，之后 resolver 会读取 compute（首响应）
  await backend.settle(backend.byKind('query-layer-query'));

  // 注入迟到的第二个 compute 响应，谎称是另一条路由的结果
  backend.resend(computeEntry, {
    ok: true,
    value: { routeId: 'o', computed: { stage: 'late-tampered' } }
  });
  await tick();

  await settleAll(backend);
  const ex = await promise;

  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.winner.routeId, 'u');
  assert.equal(ex.asyncEvidence.staleIgnored, 1);
  // serverCompute 只有一条记录，值为首响应，篡改结果未被应用
  assert.equal(ex.serverCompute.length, 1);
  assert.deepEqual(ex.serverCompute[0].computed, { stage: 'first' });
  assert.equal(ex.finalParams.computed.stage, 'first');
});

test('两个解释并发：correlationId 隔离，跨解释响应不串扰', async () => {
  const { wb, backend } = benchWithBackend();
  const p1 = wb.resolve({ method: 'GET', host: 'race.example.com', target: '/users/5' });
  const p2 = wb.resolve({ method: 'GET', host: 'race.example.com', target: '/orgs/acme' });
  await tick();

  // 两个解释各自提交了全套作业；交错 settle：p2 的 app 先完成，再 p1 的 app……
  const all = () => backend.pending;
  // 每层两个作业，按 kind 分组，逆序（p2 先）与正序交替 settle
  const kinds = [
    'app-host-scan',
    'mount-prefix-scan',
    'resource-route-query',
    'method-check'
  ];
  for (const kind of kinds) {
    const entries = all().filter((e) => e.kind === kind);
    assert.equal(entries.length, 2, `${kind} 应有两个解释的作业`);
    await backend.settle(entries[1]); // p2 先
    await tick();
    await backend.settle(entries[0]); // p1 后
    await tick();
  }

  // query/compute 阶段：四个作业都已 pending。先 settle p1 的 compute（乱序）
  const computes = all().filter((e) => e.kind === 'server-compute');
  const queries = all().filter((e) => e.kind === 'query-layer-query');
  assert.equal(computes.length, 2);
  assert.equal(queries.length, 2);
  // entries[0] 是 p1（先发起的 resolve，先提交 app，correlation 顺序一致）
  await backend.settle(computes[0]);
  await tick();
  // 再交错 settle 两个 query
  await backend.settle(queries[0]);
  await tick();
  await backend.settle(queries[1]);
  await tick();
  // p2 的 compute 最后 settle
  await backend.settle(computes[1]);
  await tick();
  // 剩余全部排空（ranking/decode/handler）
  await settleAll(backend);

  const [ex1, ex2] = await Promise.all([p1, p2]);
  assert.notEqual(ex1.correlationId, ex2.correlationId);
  assert.equal(ex1.winner.routeId, 'u');
  assert.equal(ex2.winner.routeId, 'o');
  assert.equal(ex1.finalParams.scopes.resource.id, 5);
  assert.equal(ex2.finalParams.scopes.resource.id, 'acme');
  // 双方都没有消费到对方的响应
  assert.equal(ex1.asyncEvidence.foreignIgnored, 0);
  assert.equal(ex2.asyncEvidence.foreignIgnored, 0);
});

test('解释结束后：外域响应进总线 foreign 账本，同 job 重复响应进信箱 stale 账本', async () => {
  const { wb, backend, bus } = benchWithBackend();
  const promise = wb.resolve({ method: 'GET', host: 'race.example.com', target: '/users/5' });
  await tick();
  await settleAll(backend);
  const done = await promise;
  assert.equal(done.reason, Reason.MATCHED);
  const corr = done.correlationId;
  const computeJobId = done.layers.compute.jobs[0].jobId;

  // 1) 完全外域（未知信箱）：总线记账
  bus.inject({
    jobId: 'totally-foreign:job',
    correlationId: 'corr-does-not-exist',
    kind: 'server-compute',
    ok: true,
    value: { routeId: 'intruder' },
    seq: 999
  });
  assert.equal(bus.foreign.length, 1);

  // 2) 已完成信箱收到同一作业的迟到重复响应：信箱 stale 记账，结果不变
  bus.inject({
    jobId: computeJobId,
    correlationId: corr,
    kind: 'server-compute',
    ok: true,
    value: { routeId: 'o', computed: { stage: 'after-finish' } },
    seq: 1000
  });
  assert.equal(bus.mailboxes.get(corr).stats.stale, 1);
  assert.equal(done.winner.routeId, 'u');
  assert.equal(done.serverCompute[0].computed.stage, undefined);
});

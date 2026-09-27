/**
 * 端到端演示：一次请求如何沿“同一条数据链”被解释。
 *
 * 运行：node examples/tour.js
 *
 * 展示：
 *  1. 发布真实路由快照（多应用/多挂载点/多方法/多解码规则）
 *  2. 一个看起来该匹配却 405 的请求：逐层候选、淘汰原因、Allow
 *  3. 一个编码斜杠改变候选集合的请求
 *  4. 摘要视图（公开结果）-> 按需 expand 单个候选（不发送无关完整对象）
 *  5. 复制回归样本 -> 发布新版本 -> 重放看到版本差异 -> 恢复
 */
import {
  Workbench,
  ControlledBackend,
  CorrelationBus,
  Reason
} from '../src/public/index.js';

const routeTree = {
  apps: [
    {
      id: 'public',
      hosts: ['api.example.com', ':tenant.api.example.com'],
      paramRules: [{ name: 'tenant', type: 'slug' }],
      mounts: [
        {
          id: 'v1',
          path: '/v1',
          routes: [
            {
              id: 'v1-user',
              path: '/users/:id',
              methods: ['GET'],
              handler: 'getUser',
              paramRules: [{ name: 'id', type: 'int', min: 1 }]
            },
            {
              id: 'v1-user-create',
              path: '/users',
              methods: ['POST'],
              handler: 'createUser'
            }
          ]
        }
      ]
    }
  ]
};

const wb = new Workbench();
const v1 = wb.publish(routeTree);
wb.registerHandler('getUser', ({ params }) => ({
  ok: true,
  body: { tenant: params.app.tenant, id: params.resource.id }
}));
wb.registerHandler('createUser', () => ({ ok: true, status: 201 }));

const line = (s = '') => console.log(s);
const h1 = (s) => console.log(`\n=== ${s} ===`);

// ── 1. 成功路径：主机参数在 app 作用域，路径参数在 resource 作用域 ──
h1('1) MATCHED：分层参数视图');
const ok = await wb.resolve({
  method: 'GET',
  host: 'acme.api.example.com',
  target: '/v1/users/42?verbose=1'
});
line(`reason=${ok.reason} version=${ok.snapshotVersion} winner=${ok.winner.routeId}`);
line('finalParams.scopes =');
line(JSON.stringify(ok.finalParams.scopes, null, 2));
line('byName（同名参数分列，不覆盖）=');
line(JSON.stringify(ok.finalParams.byName, null, 2));

// ── 2. 看起来匹配但 405：方法失败分类 + 候选淘汰证据 ──
h1('2) METHOD_NOT_ALLOWED：结构匹配但方法淘汰');
const m405 = await wb.resolve({
  method: 'DELETE',
  host: 'acme.api.example.com',
  target: '/v1/users/42'
});
line(`reason=${m405.reason} status=${m405.status} Allow=${m405.methodAllow.join(',')}`);
line(`终止层=${m405.evidence.layer}`);
line('被方法约束淘汰的候选：');
for (const e of m405._projection.eliminations.method) {
  line(`  - ${e.ref.appId}/${e.ref.mountId}/${e.ref.routeId} 允许=${e.methods.join('|')}`);
}
line('解码层作业数（流水线在 method 终止，不应执行）= ' + m405.layers.decode.jobs.length);

// ── 3. 编码斜杠改变候选集合 ──
h1('3) 编码边界：%2F 的策略差异');
for (const policy of ['keep', 'split', 'reject']) {
  const ex = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/v1/users/1%2F2' },
    { policy: { encodedSlash: policy } }
  );
  let detail;
  if (ex.reason === Reason.MATCHED) detail = `id=${JSON.stringify(ex.finalParams.scopes.resource.id)}`;
  else if (ex.reason === Reason.DECODE_FAILED) {
    detail = `decodeFailures=${ex.evidence.failures.map((f) => `${f.name}:${f.stage}`).join(',')}`;
  } else if (ex.reason === Reason.TARGET_INVALID) detail = `code=${ex.evidence.code}`;
  else detail = `layer=${ex.evidence.layer}`;
  line(`encodedSlash=${policy.padEnd(6)} -> reason=${ex.reason} ${detail}`);
}

// ── 4. 公开结果：摘要优先，候选按需展开 ──
h1('4) 公开视图：summary 不携带无关完整对象');
const summary = wb.view(ok.id);
line(`summary 字段：${Object.keys(summary).join(', ')}`);
line(`摘要大小=${JSON.stringify(summary).length} 字节`);
const expanded = wb.expand(ok.id, ok.winner);
line('expand(winner) 才返回完整路由定义：');
line(JSON.stringify(expanded.route, null, 2));

// ── 5. 回归样本 + 版本差异 + 恢复 ──
h1('5) 回归样本 / 重放 / 版本差异');
const sample = wb.sample(ok.id);
line(`样本绑定版本=${sample.boundSnapshotVersion} 期望指纹=${sample.expect.fingerprint.slice(0, 16)}…`);

// 发布 v2：给 /users/:id 增加 DELETE
const treeV2 = structuredClone(routeTree);
treeV2.apps[0].mounts[0].routes[0].methods = ['GET', 'DELETE'];
const v2 = wb.publish(treeV2);
line(`发布新版本=${v2.version}`);

const report = await wb.replay(sample);
line(`重放：boundAvailable=${report.boundAvailable} 当前是绑定版=${report.currentIsBound} 期望一致=${report.expectationMatched}`);
line('版本差异：');
line(JSON.stringify(report.versionDiff.changedRoutes, null, 2));

// 同一个 405 请求在新版本上的变化（演示“再次运行看到版本差异”）
const after = await wb.resolve({
  method: 'DELETE',
  host: 'acme.api.example.com',
  target: '/v1/users/42'
});
line(`同请求在 v2：reason=${after.reason}（v1 是 ${m405.reason}）`);

// ── 6. 异步查询竞态证据（受控乱序） ──
h1('6) 异步竞态：query 与 compute 乱序完成');
const backend = new ControlledBackend();
const wbRace = new Workbench({ bus: new CorrelationBus(backend) });
wbRace.publish(routeTree, { version: v1.version });
wbRace.registerHandler('getUser', ({ params }) => ({ ok: true, body: params.resource }));
wbRace.registerHandler('createUser', () => ({ ok: true, status: 201 }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const raceP = wbRace.resolve({ method: 'GET', host: 'api.example.com', target: '/v1/users/9' });
await tick();
for (const kind of ['app-host-scan', 'mount-prefix-scan', 'resource-route-query', 'method-check']) {
  await backend.settle(backend.byKind(kind));
  await tick();
}
// 故意让 compute 先完成
await backend.settle(backend.pending.find((p) => p.kind === 'server-compute'));
await tick();
await backend.settle(backend.byKind('query-layer-query'));
await tick();
let guard = 0;
while (backend.pending.length && guard < 20) {
  await backend.settle(backend.pending[0]);
  await tick();
  guard += 1;
}
const raced = await raceP;
line(`乱序完成：outOfOrder=${raced.asyncEvidence.outOfOrder} 结果仍=${raced.reason} id=${raced.finalParams.scopes.resource.id}`);

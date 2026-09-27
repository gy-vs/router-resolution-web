/**
 * 失败分类：
 *  - 主机/挂载/资源各层 NO_MATCH（404），证据指向对应层；
 *  - 结构匹配但方法不允许 METHOD_NOT_ALLOWED（405），带 Allow 与候选 ref，
 *    且不能误报成 404；
 *  - DECODE_FAILED 与方法/匹配问题严格区分；
 *  - 处理器返回 ok:false 是 HANDLER_REJECTED（内部拒绝），与崩溃/未注册区分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, Reason } from '../src/public/index.js';
import { buildMultiTenantTree, registerFixtureHandlers } from './support/fixture.js';

function fresh(rejectOpts = {}) {
  const wb = new Workbench();
  wb.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb, rejectOpts);
  return wb;
}

test('没有主机条件匹配 -> NO_MATCH 停在 app 层', async () => {
  const wb = fresh();
  const ex = await wb.resolve({ method: 'GET', host: 'evil.example.org', target: '/v2/users/x' });
  assert.equal(ex.reason, Reason.NO_MATCH);
  assert.equal(ex.status, 404);
  assert.equal(ex.evidence.layer, 'app');
});

test('主机匹配但无挂载点 -> NO_MATCH 停在 mount 层，淘汰原因保留', async () => {
  const wb = fresh();
  const ex = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/v999/users/x' });
  assert.equal(ex.reason, Reason.NO_MATCH);
  assert.equal(ex.evidence.layer, 'mount');
  const eliminatedMount = ex._projection.eliminations.mount;
  assert.ok(eliminatedMount.some((e) => e.reason === 'LITERAL_MISMATCH'));
});

test('挂载命中但无资源匹配 -> NO_MATCH 停在 resource 层', async () => {
  const wb = fresh();
  const ex = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/v2/nope/1' });
  assert.equal(ex.reason, Reason.NO_MATCH);
  assert.equal(ex.evidence.layer, 'resource');
  const reasons = ex._projection.eliminations.resource.map((e) => e.reason);
  assert.ok(reasons.includes('LITERAL_MISMATCH'));
});

test('结构匹配但方法不允许 -> METHOD_NOT_ALLOWED + Allow，且不进入解码', async () => {
  const wb = fresh();
  // /v1 .../users/:id 只有 GET 与 POST；PUT 不允许
  const ex = await wb.resolve({
    method: 'PUT',
    host: 'api.example.com',
    target: '/v1/orgs/11111111-1111-1111-1111-111111111111/users/7'
  });
  assert.equal(ex.reason, Reason.METHOD_NOT_ALLOWED);
  assert.equal(ex.status, 405);
  assert.deepEqual(ex.methodAllow.sort(), ['GET', 'POST']);
  // 证据带候选 ref，且参数解码层没有作业结果（流水线在 method 层终止）
  assert.ok(ex.evidence.candidates.length >= 1);
  assert.equal(ex.layers.decode.jobs.length, 0);
  assert.equal(ex.finalParams, null);
});

test('结构不匹配绝不能报 405：未知资源 + 奇怪方法仍是 404', async () => {
  const wb = fresh();
  const ex = await wb.resolve({ method: 'PATCH', host: 'api.example.com', target: '/v2/wxyz' });
  assert.equal(ex.reason, Reason.NO_MATCH);
});

test('admin DELETE 在公网主机上是 404（主机边界），在内网主机上才匹配', async () => {
  const wb = fresh();
  const pub = await wb.resolve({
    method: 'DELETE',
    host: 'api.example.com',
    target: '/admin/users/2'
  });
  assert.equal(pub.reason, Reason.NO_MATCH);

  const internal = await wb.resolve({
    method: 'DELETE',
    host: 'admin.internal.example.com',
    target: '/admin/users/2'
  });
  assert.equal(internal.reason, Reason.MATCHED);
});

test('处理器内部拒绝 ok:false -> HANDLER_REJECTED，携带处理器自定义状态码与代码', async () => {
  const wb = fresh({ rejectId: 42 });
  const ex = await wb.resolve({
    method: 'GET',
    host: 'admin.internal.example.com',
    target: '/admin/users/42'
  });
  assert.equal(ex.reason, Reason.HANDLER_REJECTED);
  assert.equal(ex.status, 403);
  assert.equal(ex.evidence.stage, 'internal-rejection');
  assert.equal(ex.evidence.code, 'FORBIDDEN_BY_HANDLER');
  // 解码已成功，finalParams 保留（失败输入可定位）
  assert.equal(ex.finalParams.scopes.resource.id, 42);
});

test('处理器未注册属于内部配置错误，不是匹配/解码失败', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [
      {
        id: 'a',
        hosts: ['a.example.com'],
        mounts: [
          {
            id: 'm',
            path: '/',
            routes: [
              { id: 'r', path: '/x', methods: ['GET'], handler: 'missing-handler' }
            ]
          }
        ]
      }
    ]
  });
  const ex = await wb.resolve({ method: 'GET', host: 'a.example.com', target: '/x' });
  assert.equal(ex.reason, Reason.HANDLER_REJECTED);
  assert.equal(ex.evidence.stage, 'registration');
  assert.equal(ex.evidence.handlerId, 'missing-handler');
});

test('405 候选集合随主机大小写归一化而改变（不同主机连候选都不同）', async () => {
  const wb = fresh();
  const upper = await wb.resolve({
    method: 'DELETE',
    host: 'API.EXAMPLE.COM',
    target: '/v2/users/alice'
  });
  // api.example.com 的 v2-user 仅 GET/HEAD
  assert.equal(upper.reason, Reason.METHOD_NOT_ALLOWED);
  assert.deepEqual(upper.methodAllow.sort(), ['GET', 'HEAD']);

  // admin 主机上 v2 路径根本不匹配 -> 404
  const admin = await wb.resolve({
    method: 'DELETE',
    host: 'admin.internal.example.com',
    target: '/v2/users/alice'
  });
  assert.equal(admin.reason, Reason.NO_MATCH);
});

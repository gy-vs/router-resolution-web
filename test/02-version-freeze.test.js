/**
 * 证明版本冻结：
 *  - 解释绑定创建时的 snapshotVersion；发布新版本不改变老解释的 expand 结果；
 *  - 老版本重放得到相同期望指纹（expectationMatched）；
 *  - 新版本重放同请求时，replay 报告 currentIsBound=false 且 versionDiff 指出差异；
 *  - 明确绑定旧版本解析仍走旧快照；
 *  - 旧版本被淘汰后 expand 返回 SNAPSHOT_UNKNOWN，但解释自身仍持有 compact 证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, Reason, toCompact } from '../src/public/index.js';
import { buildMultiTenantTree, registerFixtureHandlers } from './support/fixture.js';

function v2Tree() {
  const tree = buildMultiTenantTree();
  // v2 发布：把 v2-user 的 :id 从 slug 改成 int，并新增一条路由
  const v2mount = tree.apps[0].mounts.find((m) => m.id === 'v2');
  v2mount.routes[0] = {
    id: 'v2-user',
    path: '/users/:id',
    methods: ['GET', 'HEAD'],
    handler: 'user.v2',
    paramRules: [{ name: 'id', type: 'int' }]
  };
  v2mount.routes.push({
    id: 'v2-user-archive',
    path: '/users/:id/archive',
    methods: ['GET'],
    handler: 'user.v2.archive'
  });
  return tree;
}

test('发布新版本不改变已保存解释绑定的版本与候选展开', async () => {
  const wb = new Workbench();
  const v1 = wb.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb);

  const ex1 = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/v2/users/alice-42' });
  assert.equal(ex1.reason, Reason.MATCHED);
  assert.equal(ex1.snapshotVersion, v1.version);

  const v2 = wb.publish(v2Tree());
  assert.notEqual(v1.version, v2.version);
  // 指纹必然不同（路由规则/新增路由）
  assert.notEqual(v1.fingerprint, v2.fingerprint);

  // 老解释仍绑定 v1
  assert.equal(wb.view(ex1.id).snapshotVersion, v1.version);

  // 显式展开老解释的候选 -> 来自 v1 快照（slug 规则）
  const expanded = wb.expand(ex1.id, ex1.winner);
  assert.equal(expanded.ok, true);
  assert.equal(expanded.snapshotVersion, v1.version);
  assert.deepEqual(expanded.route.paramRules, [{ name: 'id', type: 'slug' }]);

  // 默认解析现在走 v2：同样的 slug 值解码失败（规则变成 int）
  const ex2 = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/v2/users/alice-42' });
  assert.equal(ex2.snapshotVersion, v2.version);
  assert.equal(ex2.reason, Reason.DECODE_FAILED);

  // 但显式绑定 v1 仍然成功
  const ex1Rebound = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/v2/users/alice-42' },
    { version: v1.version }
  );
  assert.equal(ex1Rebound.snapshotVersion, v1.version);
  assert.equal(ex1Rebound.reason, Reason.MATCHED);
});

test('回归样本重放：同版本指纹一致；新版本报告版本差异', async () => {
  const wb = new Workbench();
  const v1 = wb.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb);

  const ex1 = await wb.resolve({
    method: 'GET',
    host: 'acme.api.example.com',
    target: '/v1/orgs/11111111-1111-1111-1111-111111111111/users/7'
  });
  const sample = wb.sample(ex1.id);
  assert.equal(sample.boundSnapshotVersion, v1.version);
  assert.ok(sample.expect.fingerprint.length === 64);

  // 在 v1 上重放：期望一致
  const replay1 = await wb.replay(sample);
  assert.equal(replay1.expectationMatched, true);
  assert.equal(replay1.currentIsBound, true);
  assert.equal(replay1.versionDiff, null);

  // 发布 v2 后重放：样本绑定仍可用（保留期内），但 current 与 bound 不同
  const v2 = wb.publish(v2Tree());
  const replay2 = await wb.replay(sample);
  assert.equal(replay2.boundAvailable, true);
  assert.equal(replay2.currentIsBound, false);
  assert.equal(replay2.expectationMatched, true, '绑定版本重放必须得到同一指纹');
  assert.ok(replay2.versionDiff);
  assert.equal(replay2.versionDiff.changed, true);
  assert.equal(replay2.versionDiff.from.version, v1.version);
  assert.equal(replay2.versionDiff.to.version, v2.version);
  // 新增路由出现在 added
  assert.ok(replay2.versionDiff.added.some((a) => a.routeId === 'v2-user-archive'));
  // v2-user 规则变化
  const changed = replay2.versionDiff.changedRoutes.find(
    (c) => c.ref.routeId === 'v2-user'
  );
  assert.ok(changed);
  assert.equal(changed.fields.paramRules, true);
});

test('版本差异：删除与方法约束变化都能被定位', async () => {
  const wb = new Workbench();
  const v1 = wb.publish(buildMultiTenantTree());
  const tree2 = buildMultiTenantTree();
  // 删除 file-get、改 admin-user 方法
  const files = tree2.apps[0].mounts.find((m) => m.id === 'files');
  files.routes = [];
  const admin = tree2.apps[1].mounts[0].routes[0];
  admin.methods = ['GET']; // 去掉 DELETE
  const v2 = wb.publish(tree2);

  const diff = wb.diffVersions(v1.version, v2.version);
  assert.equal(diff.changed, true);
  assert.ok(diff.removed.some((r) => r.routeId === 'file-get'));
  const adminChange = diff.changedRoutes.find((c) => c.ref.routeId === 'admin-user');
  assert.deepEqual(adminChange.fields.methods.from.sort(), ['DELETE', 'GET']);
  assert.deepEqual(adminChange.fields.methods.to, ['GET']);
});

test('旧版本淘汰后：解释仍在，compact 可用，expand 报 SNAPSHOT_UNKNOWN', async () => {
  const wb = new Workbench({ retention: 1 });
  const v1 = wb.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb);
  const ex = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/v2/users/alice-42' });
  const sample = wb.sample(ex.id);

  wb.publish(v2Tree()); // retention=1 淘汰 v1
  assert.equal(wb.snapshots.get(v1.version), null);

  // 解释会话本身保留（工作台内存），compact 证据仍可读
  const compact = toCompact(ex);
  assert.equal(compact.snapshotVersion, v1.version);
  assert.equal(compact.winner.routeId, 'v2-user');

  // 展开需要快照，明确告知不可用
  const expanded = wb.expand(ex.id, ex.winner);
  assert.equal(expanded.ok, false);
  assert.equal(expanded.reason, 'SNAPSHOT_UNKNOWN');

  // 重放报告版本缺失，但样本可移植（恢复后重新发布 v1 树即可继续）
  const report = await wb.replay(sample);
  assert.equal(report.boundAvailable, false);
  assert.equal(report.versionError.reason, 'SNAPSHOT_UNKNOWN');
});

test('恢复：新 Workbench 用样本 + 原始路由树重建后 restore，状态回到同一数据链', async () => {
  const wb1 = new Workbench();
  wb1.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb1);
  const ex = await wb1.resolve({
    method: 'DELETE',
    host: 'admin.internal.example.com',
    target: '/admin/users/9'
  });
  const sample = JSON.parse(JSON.stringify(wb1.sample(ex.id)));

  // 全新工作台（同进程模拟“另一会话”）：先恢复路由快照，再 restore
  const wb2 = new Workbench();
  wb2.publish(buildMultiTenantTree(), { version: sample.boundSnapshotVersion });
  registerFixtureHandlers(wb2);
  const report = await wb2.restore(sample);
  assert.equal(report.expectationMatched, true);
  assert.equal(report.summary.reason, Reason.MATCHED);
  // 恢复出的解释已登记，可继续查看
  assert.ok(wb2.getExplanation(report.explanation.id));
});

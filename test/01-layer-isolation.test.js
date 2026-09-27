/**
 * 证明层级参数隔离：
 *  - 同名 :id 在 v1（int）/v2（slug）/admin（int+min）下含义不同；
 *  - 同一次解释的 finalParams 按 scope 分列，绝不是一个全局字典；
 *  - 挂载参数与资源参数分开，主机 :tenant 也在独立 app 作用域。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, Reason, toSummary } from '../src/public/index.js';
import { buildMultiTenantTree, registerFixtureHandlers } from './support/fixture.js';

function fresh() {
  const wb = new Workbench();
  wb.publish(buildMultiTenantTree());
  registerFixtureHandlers(wb);
  return wb;
}

test('v1 挂载点：:id 按 int 解码，:orgId 按 uuid，主机 tenant 在 app 作用域', async () => {
  const wb = fresh();
  const ex = await wb.resolve({
    method: 'GET',
    host: 'acme.api.example.com',
    target: '/v1/orgs/11111111-1111-1111-1111-111111111111/users/7'
  });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.finalParams.scopes.resource.id, 7);
  assert.equal(typeof ex.finalParams.scopes.resource.id, 'number');
  assert.equal(ex.finalParams.scopes.resource.orgId, '11111111-1111-1111-1111-111111111111');
  assert.equal(ex.finalParams.scopes.app.tenant, 'acme');
  // mount 作用域在此例为空（/v1 无参数）
  assert.deepEqual(ex.finalParams.scopes.mount, {});
});

test('v2 挂载点：同名字符串 :id 是 slug，不会被 v1 的 int 规则污染', async () => {
  const wb = fresh();
  const ex = await wb.resolve({
    method: 'GET',
    host: 'api.example.com',
    target: '/v2/users/alice-42'
  });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.finalParams.scopes.resource.id, 'alice-42');

  // 把同样的 id 值送到 v1，应该按 int 规则解码失败而不是成功
  const bad = await wb.resolve({
    method: 'GET',
    host: 'api.example.com',
    // 注意 v1 需要 orgId 段；直接给非数字 id
    target: '/v1/orgs/not-a-uuid/users/alice-42'
  });
  assert.equal(bad.reason, Reason.DECODE_FAILED);
  const names = bad.evidence.failures.map((f) => `${f.scope}.${f.name}`);
  assert.ok(names.includes('resource.id'));
  assert.ok(names.includes('resource.orgId'));
});

test('同名参数按名分列：byName 视图保留 scope，不覆盖', async () => {
  const wb = fresh();
  // 构造一条 mount 与 resource 都叫 id 的链：/files/*path 无 :id，
  // 因此直接用 admin 场景并人为构造：挂载 admin 无参数。
  // 这里验证 query.id 与 resource.id 同名时的分列。
  wb.publish({
    apps: [
      {
        id: 'iso',
        hosts: ['iso.example.com'],
        mounts: [
          {
            id: 'm',
            path: '/s/:id',
            paramRules: [{ name: 'id', type: 'slug' }],
            routes: [
              {
                id: 'r',
                path: '/r/:id',
                methods: ['GET'],
                handler: 'h',
                paramRules: [{ name: 'id', type: 'int' }],
                queryRules: [{ name: 'id', type: 'string' }]
              }
            ]
          }
        ]
      }
    ]
  });
  wb.registerHandler('h', () => ({ ok: true }));

  const ex = await wb.resolve({
    method: 'GET',
    host: 'iso.example.com',
    target: '/s/tenant-9/r/9?id=raw-nine'
  });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.finalParams.scopes.mount.id, 'tenant-9');
  assert.equal(ex.finalParams.scopes.resource.id, 9);
  assert.equal(ex.finalParams.scopes.query.id, 'raw-nine');

  const cells = ex.finalParams.byName.id;
  assert.equal(cells.length, 3, '同名 id 必须保留三个作用域条目');
  assert.deepEqual(cells.map((c) => c.scope).sort(), ['mount', 'query', 'resource']);
  // 全局字典式覆盖会让三个值变成同一个
  const values = new Set(cells.map((c) => JSON.stringify(c.value)));
  assert.equal(values.size, 3);

  // 来源引用指向不同的段位置/查询下标
  const summary = toSummary(ex);
  assert.ok(summary.finalParams);
});

test('挂载参数解码失败只记录在 mount 作用域，不污染 resource 作用域', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [
      {
        id: 'a',
        hosts: ['a.example.com'],
        mounts: [
          {
            id: 'm',
            path: '/o/:org',
            paramRules: [{ name: 'org', type: 'int' }],
            routes: [
              {
                id: 'r',
                path: '/items/:item',
                methods: ['GET'],
                handler: 'h',
                paramRules: [{ name: 'item', type: 'int' }]
              }
            ]
          }
        ]
      }
    ]
  });
  wb.registerHandler('h', () => ({ ok: true }));

  const ex = await wb.resolve({
    method: 'GET',
    host: 'a.example.com',
    target: '/o/acme/items/3'
  });
  assert.equal(ex.reason, Reason.DECODE_FAILED);
  const f = ex.evidence.failures;
  assert.equal(f.length, 1);
  assert.equal(f[0].scope, 'mount');
  assert.equal(f[0].name, 'org');
  assert.equal(f[0].raw, 'acme');
  // 引用指向挂载段（/o/acme：a 位于字节位置 3..7）
  assert.equal(f[0].ref.kind, 'segment');
  assert.equal(f[0].ref.start, 3);
  assert.equal(f[0].ref.end, 7);
});

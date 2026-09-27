/**
 * 补充边界：根挂载、splat 挂载、子域+字面量主机选取、查询规则分层与重复键。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, Reason } from '../src/public/index.js';

test('根路径 / 挂载 + 根资源 / 与 /:x 的精确行为', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [{
      id: 'a', hosts: ['a.example.com'],
      mounts: [{
        id: 'root', path: '/',
        routes: [
          { id: 'home', path: '/', methods: ['GET'], handler: 'home' },
          { id: 'x', path: '/:x', methods: ['GET'], handler: 'x',
            paramRules: [{ name: 'x', type: 'string' }] }
        ]
      }]
    }]
  });
  wb.registerHandler('home', () => ({ ok: true, body: 'home' }));
  wb.registerHandler('x', () => ({ ok: true, body: 'x' }));

  const root = await wb.resolve({ method: 'GET', host: 'a.example.com', target: '/' });
  assert.equal(root.reason, Reason.MATCHED);
  assert.equal(root.winner.routeId, 'home');

  const one = await wb.resolve({ method: 'GET', host: 'a.example.com', target: '/hello' });
  assert.equal(one.winner.routeId, 'x');
  assert.equal(one.finalParams.scopes.resource.x, 'hello');
});

test('splat 挂载点：*path 消费挂载前缀后的全部剩余段', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [{
      id: 'fs', hosts: ['fs.example.com'],
      mounts: [{
        id: 'tenant-files', path: '/t/:tenant/files/*path',
        paramRules: [{ name: 'tenant', type: 'slug' }],
        routes: [
          // 资源层 splat 匹配挂载点之后的全部剩余段
          { id: 'dl', path: '/*rest', methods: ['GET'], handler: 'dl' }
        ]
      }]
    }]
  });
  wb.registerHandler('dl', ({ params }) => ({ ok: true, body: params.mount }));

  const ex = await wb.resolve({
    method: 'GET',
    host: 'fs.example.com',
    target: '/t/acme/files/a/b/c/download'
  });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.winner.routeId, 'dl');
  assert.equal(ex.finalParams.scopes.mount.tenant, 'acme');
  // splat 语义：捕获挂载固定段之后的全部剩余段
  assert.deepEqual(ex.finalParams.scopes.mount.path, ['a', 'b', 'c', 'download']);

  // 固定前缀不匹配时挂载即淘汰
  const miss = await wb.resolve({
    method: 'GET', host: 'fs.example.com', target: '/t/acme/other/x'
  });
  assert.equal(miss.reason, Reason.NO_MATCH);
});

test('主机条件：字面量主机与 :tenant 子域都可命中时，选更具体的字面量', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [{
      id: 'a',
      hosts: ['api.example.com', ':tenant.api.example.com'],
      paramRules: [{ name: 'tenant', type: 'slug' }],
      mounts: [{
        id: 'm', path: '/',
        routes: [{ id: 'r', path: '/ping', methods: ['GET'], handler: 'p' }]
      }]
    }]
  });
  wb.registerHandler('p', () => ({ ok: true }));

  // 精确主机命中：不应误捕出一个值为 'api' 的 tenant 参数
  const literal = await wb.resolve({ method: 'GET', host: 'api.example.com', target: '/ping' });
  assert.equal(literal.reason, Reason.MATCHED);
  assert.deepEqual(literal.finalParams.scopes.app, {});

  const tenant = await wb.resolve({ method: 'GET', host: 'globex.api.example.com', target: '/ping' });
  assert.equal(tenant.finalParams.scopes.app.tenant, 'globex');
});

test('查询参数：重复键收集为数组；规则按 resource→mount→app 回退；解码失败在 query 作用域', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [{
      id: 'a', hosts: ['a.example.com'],
      queryRules: [{ name: 'trace', type: 'string' }],
      mounts: [{
        id: 'm', path: '/',
        queryRules: [{ name: 'limit', type: 'int' }],
        routes: [{
          id: 'r', path: '/items', methods: ['GET'], handler: 'it',
          queryRules: [{ name: 'tag', type: 'string' }]
        }]
      }]
    }]
  });
  wb.registerHandler('it', () => ({ ok: true }));

  const good = await wb.resolve({
    method: 'GET', host: 'a.example.com',
    target: '/items?limit=10&tag=a&tag=b&trace=t-1'
  });
  assert.equal(good.reason, Reason.MATCHED);
  assert.equal(good.finalParams.scopes.query.limit, 10);
  assert.deepEqual(good.finalParams.scopes.query.tag, ['a', 'b']);
  assert.equal(good.finalParams.scopes.query.trace, 't-1');

  const bad = await wb.resolve({
    method: 'GET', host: 'a.example.com',
    target: '/items?limit=not-int'
  });
  assert.equal(bad.reason, Reason.DECODE_FAILED);
  const f = bad.evidence.failures[0];
  assert.equal(f.scope, 'query');
  assert.equal(f.name, 'limit');
  assert.equal(f.ref.kind, 'query-entry');
});

test('绝对 URI 目标：主机取自 URI，与显式 host 一致时正常匹配', async () => {
  const wb = new Workbench();
  wb.publish({
    apps: [{
      id: 'a', hosts: ['a.example.com'],
      mounts: [{
        id: 'm', path: '/',
        routes: [{ id: 'r', path: '/k/:v', methods: ['GET'], handler: 'h',
          paramRules: [{ name: 'v', type: 'string' }] }]
      }]
    }]
  });
  wb.registerHandler('h', () => ({ ok: true }));
  const ex = await wb.resolve({
    method: 'GET',
    target: 'http://a.example.com/k/hello%20world?z=1'
  });
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.finalParams.scopes.resource.v, 'hello world');
  assert.equal(ex.decodedParamsView.host, 'a.example.com');
});

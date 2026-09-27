/**
 * 编码边界：这些输入必须改变候选集合或被显式拒绝，且证据可定位到字节位置。
 *  - %2F keep：留在单段内，resource :id 拿到 "a%2Fb"，解码后为 "a/b"（raw 类型不解码则保留）；
 *  - %2F split：拆成两段，候选集合随之改变（:id 只吃第一段，需要 splat/多段模式才能命中）；
 *  - %2F reject：TARGET_INVALID，不产生任何层候选；
 *  - 重复分隔符 collapse/reject；
 *  - 尾部斜杠 ignore/exact 下候选集合差异；
 *  - 主机大小写、端口、尾点归一化改变候选集合。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workbench, Reason } from '../src/public/index.js';

function bench() {
  const wb = new Workbench();
  wb.publish({
    apps: [
      {
        id: 'a',
        hosts: ['api.example.com'],
        mounts: [
          {
            id: 'm',
            path: '/m',
            routes: [
              {
                id: 'r-one',
                path: '/items/:id',
                methods: ['GET'],
                handler: 'h',
                paramRules: [{ name: 'id', type: 'string' }]
              },
              {
                id: 'r-two',
                path: '/items/:a/:b',
                methods: ['GET'],
                handler: 'h2',
                paramRules: [
                  { name: 'a', type: 'string' },
                  { name: 'b', type: 'string' }
                ]
              },
              {
                id: 'r-col',
                path: '/items/',
                methods: ['GET'],
                handler: 'hcol'
              }
            ]
          }
        ]
      }
    ]
  });
  wb.registerHandler('h', () => ({ ok: true }));
  wb.registerHandler('h2', () => ({ ok: true }));
  wb.registerHandler('hcol', () => ({ ok: true }));
  return wb;
}

test('编码斜杠 keep：%2F 留在 :id 段内，percent 解码后 id 含真实斜杠', async () => {
  const wb = bench();
  const ex = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items/a%2Fb' },
    { policy: { encodedSlash: 'keep' } }
  );
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.winner.routeId, 'r-one');
  assert.equal(ex.finalParams.scopes.resource.id, 'a/b');
  // 归一化事件记录“保留编码斜杠”，引用可定位
  assert.ok(ex.normalizationEvents.some((e) => e.type === 'encoded-slash-kept'));
});

test('编码斜杠 split：拆成两段后命中两段路由，候选集合改变', async () => {
  const wb = bench();
  const ex = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items/a%2Fb' },
    { policy: { encodedSlash: 'split' } }
  );
  assert.equal(ex.reason, Reason.MATCHED);
  assert.equal(ex.winner.routeId, 'r-two');
  assert.equal(ex.finalParams.scopes.resource.a, 'a');
  assert.equal(ex.finalParams.scopes.resource.b, 'b');
  // r-one 因段数不符被淘汰
  const eliminated = ex._projection.eliminations.resource;
  assert.ok(eliminated.some((e) => e.ref.routeId === 'r-one' && e.reason === 'SEGMENT_COUNT_MISMATCH'));
});

test('编码斜杠 reject：TARGET_INVALID，证据指向含 %2F 的段，且没有任何层候选', async () => {
  const wb = bench();
  const ex = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items/a%2Fb' },
    { policy: { encodedSlash: 'reject' } }
  );
  assert.equal(ex.reason, Reason.TARGET_INVALID);
  assert.equal(ex.evidence.code, 'ENCODED_SLASH_REJECTED');
  assert.equal(ex.evidence.segment.raw, 'a%2Fb');
  assert.equal(ex.evidence.segment.start, 9);
  assert.equal(ex.layers.app.submitted.length, 0);
});

test('重复分隔符：collapse 命中；reject 时 TARGET_INVALID 并定位', async () => {
  const wb = bench();
  const collapsed = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m//items/3' },
    { policy: { duplicateSeparators: 'collapse' } }
  );
  assert.equal(collapsed.reason, Reason.MATCHED);
  assert.equal(collapsed.finalParams.scopes.resource.id, '3');
  assert.ok(collapsed.normalizationEvents.some((e) => e.type === 'separator-collapsed'));

  const rejected = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m//items/3' },
    { policy: { duplicateSeparators: 'reject' } }
  );
  assert.equal(rejected.reason, Reason.TARGET_INVALID);
  assert.equal(rejected.evidence.code, 'DUPLICATE_SEPARATOR_REJECTED');
  assert.equal(typeof rejected.evidence.segment.start, 'number');
});

test('尾部斜杠：ignore 下 /items/ 等价 /items；exact 下只有带尾斜杠的集合路由命中', async () => {
  const wb = bench();
  // ignore：尾斜杠剥离 -> 剩余 "items"，与 /items/ 模式的内容段等价命中集合路由
  const ignored = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items/' },
    { policy: { trailingSlash: 'ignore' } }
  );
  assert.equal(ignored.reason, Reason.MATCHED);
  assert.equal(ignored.winner.routeId, 'r-col');
  assert.ok(ignored.normalizationEvents.some((e) => e.type === 'trailing-slash-ignored'));
  // :id 路由因段数不符被淘汰（不会把空串当 id）
  assert.ok(
    ignored._projection.eliminations.resource.some(
      (e) => e.ref.routeId === 'r-one' && e.reason === 'SEGMENT_COUNT_MISMATCH'
    )
  );

  // exact：/items/ 精确命中 r-col
  const exact = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items/' },
    { policy: { trailingSlash: 'exact' } }
  );
  assert.equal(exact.reason, Reason.MATCHED);
  assert.equal(exact.winner.routeId, 'r-col');

  // exact 下无尾斜杠 /items 不命中 /items/ 模式
  const noTail = await wb.resolve(
    { method: 'GET', host: 'api.example.com', target: '/m/items' },
    { policy: { trailingSlash: 'exact' } }
  );
  assert.equal(noTail.reason, Reason.NO_MATCH);
});

test('主机大小写：大写主机归一化后命中；exact 主机策略下不命中，候选集合不同', async () => {
  const wb = bench();
  const lower = await wb.resolve({ method: 'GET', host: 'API.Example.COM', target: '/m/items/1' });
  assert.equal(lower.reason, Reason.MATCHED);
  assert.equal(lower.decodedParamsView.host, 'api.example.com');
  assert.ok(lower.normalizationEvents.some((e) => e.type === 'host-lowercased'));

  const strict = await wb.resolve(
    { method: 'GET', host: 'API.Example.COM', target: '/m/items/1' },
    { policy: { hostCase: 'exact' } }
  );
  assert.equal(strict.reason, Reason.NO_MATCH);
  assert.equal(strict.evidence.layer, 'app');
});

test('主机端口与尾点被归一化，使原本不匹配的主机命中', async () => {
  const wb = bench();
  const withPort = await wb.resolve({
    method: 'GET',
    host: 'api.example.com:8443',
    target: '/m/items/1'
  });
  assert.equal(withPort.reason, Reason.MATCHED);
  assert.ok(withPort.normalizationEvents.some((e) => e.type === 'host-port-stripped'));

  const withDot = await wb.resolve({
    method: 'GET',
    host: 'api.example.com.',
    target: '/m/items/1'
  });
  assert.equal(withDot.reason, Reason.MATCHED);
  assert.ok(withDot.normalizationEvents.some((e) => e.type === 'host-trailing-dot-trimmed'));
});

test('畸形百分号编码在 string 解码阶段失败，证据保留原始段', async () => {
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
              {
                id: 'r',
                path: '/x/:id',
                methods: ['GET'],
                handler: 'h',
                paramRules: [{ name: 'id', type: 'string' }]
              }
            ]
          }
        ]
      }
    ]
  });
  wb.registerHandler('h', () => ({ ok: true }));
  const ex = await wb.resolve({ method: 'GET', host: 'a.example.com', target: '/x/%E0%A4%A' });
  assert.equal(ex.reason, Reason.DECODE_FAILED);
  const f = ex.evidence.failures[0];
  assert.equal(f.scope, 'resource');
  assert.equal(f.stage, 'percent');
  assert.equal(f.raw, '%E0%A4%A');
  assert.equal(f.ref.kind, 'segment');
});

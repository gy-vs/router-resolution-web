# router-resolution-web

多层路由匹配解释内核（multi-layer routing resolution workbench）。

它不是一个单层 URL 字符串匹配器，而是一条**可解释的数据链**：

```
路由快照(version + fingerprint)
  └─ target 归一化（编码斜杠/重复分隔符/尾斜杠/主机边界）
     └─ W1 app 主机条件
        └─ W2 mount 挂载前缀（挂载参数进入分支作用域）
           └─ W3 resource 资源模式（候选排序）
              └─ W4 method 方法约束（405）
                 └─ W5 query 查询层查询 / compute 服务端计算（可乱序）
                    └─ W6 ranking 跨分支排序
                       └─ W7 decode 分层参数解码（app/mount/resource/query 隔离）
                          └─ W8 handler 处理器执行（内部拒绝）
```

每一层都是一次**关联感知的异步查询作业**；解释对象保存提交顺序、完成顺序、
乱序/外域/迟到重复响应的证据。调用方可以输入请求目标，逐层查看候选、淘汰原因
与最终参数，并把任意一次解释复制为**回归样本**，在后续版本上重放并看到版本差异。

## 终态分类（互不混淆）

| reason | 含义 | 默认状态 | 证据位置 |
| --- | --- | --- | --- |
| `MATCHED` | 匹配且处理器成功 | 200 | handler 层 |
| `NO_MATCH` | 结构上没有匹配（主机/挂载/资源任一层淘汰） | 404 | 终止层 |
| `METHOD_NOT_ALLOWED` | 结构匹配，但方法约束全部淘汰 | 405，带 `Allow` | method 层 |
| `DECODE_FAILED` | 匹配成功，但参数解码规则失败 | 400 | decode 层，逐参数带来源 ref |
| `HANDLER_REJECTED` | 处理器内部拒绝（`ok:false`）/未注册/崩溃 | 处理器给定 | handler 层 |
| `TARGET_INVALID` | 目标被边界策略拒绝（如 `%2F` reject） | 400 | target 层，带字节位置 |
| `SNAPSHOT_UNKNOWN` | 引用的快照版本不存在/已淘汰 | 409 | 工作台 |

## 快速使用

```js
import { Workbench } from 'router-resolution-web';

const wb = new Workbench();
const v1 = wb.publish({
  apps: [{
    id: 'public',
    hosts: ['api.example.com', ':tenant.api.example.com'],
    paramRules: [{ name: 'tenant', type: 'slug' }],
    mounts: [{
      id: 'v1', path: '/v1',
      routes: [{
        id: 'user', path: '/users/:id', methods: ['GET'],
        handler: 'getUser',
        paramRules: [{ name: 'id', type: 'int', min: 1 }]
      }]
    }]
  }]
});
wb.registerHandler('getUser', ({ params }) => ({ ok: true, body: params }));

const ex = await wb.resolve({
  method: 'GET', host: 'acme.api.example.com', target: '/v1/users/42?verbose=1'
});

ex.reason;                       // MATCHED
ex.finalParams.scopes;           // { app:{tenant:'acme'}, mount:{}, resource:{id:42}, query:{} }
ex.finalParams.byName;           // 同名参数按作用域分列，绝不全局覆盖
ex.snapshotVersion;              // 绑定版本，发布新版不影响此解释
```

### 公开视图：摘要优先，候选按需展开

```js
wb.view(ex.id);                  // summary：体积与路由表大小无关
wb.compact(ex.id);               // + 每层淘汰原因码与候选 ref（不含完整路由对象）
wb.expand(ex.id, ex.winner);     // 按需取回单个候选的完整定义
wb.expandEliminations(ex.id, 'resource', { offset: 0, limit: 50 });
```

### 回归样本 / 重放 / 版本差异

```js
const sample = wb.sample(ex.id);                 // 冻结：原始输入 + 绑定版本 + 期望指纹
wb.publish(nextTree);                            // 路由快照可以变化
const report = await wb.replay(sample);          // 仍在绑定版本上重放
report.expectationMatched;                       // 同版本 -> 指纹一致
report.versionDiff;                              // 候选集合/方法/规则差异
await wb.restore(sample);                        // 重放并登记为新解释会话
```

### 边界策略（显式可配）

```js
wb.resolve(request, { policy: {
  encodedSlash: 'keep' | 'split' | 'reject',     // %2F：留段内 / 拆段 / 拒绝
  duplicateSeparators: 'collapse' | 'keep' | 'reject', // // 折叠 / 保留 / 拒绝
  trailingSlash: 'ignore' | 'exact',
  hostCase: 'insensitive' | 'exact',
  hostPort: 'strip' | 'keep'
}});
```

### 异步查询竞态

默认使用 FIFO 微任务后端；测试可注入 `ControlledBackend` 精确决定每层完成顺序：

```js
import { CorrelationBus, ControlledBackend } from 'router-resolution-web';
const backend = new ControlledBackend();
const wb = new Workbench({ bus: new CorrelationBus(backend) });
// …提交 resolve 后，用 backend.settle(backend.byKind('query-layer-query'))
// 按任意顺序完成作业；迟到重复响应经 backend.resend(entry, …) 注入。
ex.asyncEvidence; // { submittedOrder, settleSeqOrder, outOfOrder, foreignIgnored, staleIgnored }
```

- 响应按 `correlationId` 严格隔离，跨解释响应不串扰；
- 同一 `jobId` 的重复/迟到响应计入 `staleIgnored`，绝不二次应用；
- 层证据按固定层级顺序组装，与返回顺序无关。

### HTTP 适配层（零第三方依赖）

```js
import { Workbench } from 'router-resolution-web';
import { startServer } from 'router-resolution-web/http';

const wb = new Workbench();
const server = await startServer(wb, { port: 3000 });
```

- `POST /snapshots` 发布路由树
- `GET  /versions` 版本列表
- `POST /resolve` 解析请求
- `GET  /explanations/:id/summary|compact`
- `POST /explanations/:id/expand`、`GET /explanations/:id/layers/:layer`
- `POST /explanations/:id/sample`
- `POST /replay`、`POST /restore`

端到端演示：`node examples/tour.js`

## 模块布局

```
src/core/
  errors.js       终态分类与错误
  identifiers.js  稳定 id / 规范化 JSON / sha256 指纹
  target.js       请求目标解析与归一化边界
  patterns.js     路径/主机模式编译与匹配（:param、*splat、:host、*. **）
  decode.js       参数解码规则引擎（presence→percent→type→constraints）
  snapshot.js     路由快照编译、冻结、版本存储
  bus.js          关联异步查询总线（FIFO/受控后端、外域/迟到证据）
  resolver.js     十层匹配流水线
  explanation.js  摘要/紧凑视图、候选与淘汰分页展开
  regression.js   回归样本、期望指纹、重放与版本差异
  workbench.js    门面
src/public/       公开模块入口与 HTTP 适配
test/             node:test（36 个测试）
examples/tour.js  端到端数据链演示
```

## 测试

```bash
npm test
```

覆盖（均为真实快照与真实流水线，非静态样例）：

1. **层级参数隔离** — 同名 `:id` 在不同挂载点不同类型；`scopes` 与 `byName` 分列；
2. **版本冻结** — 新发布不改老解释；样本重放指纹一致；版本差异定位新增/删除/方法/规则；淘汰与恢复；
3. **方法失败分类** — 404/405/解码失败/处理器内部拒绝严格区分，含 `Allow` 与终止层；
4. **编码边界** — `%2F` keep/split/reject、重复分隔符、尾斜杠、主机大小写/端口/尾点、畸形百分号；
5. **异步查询竞态** — 乱序完成、迟到重复响应、并发关联隔离、结束后外域响应；
6. **视图投影与 HTTP** — 摘要体积不随路由表膨胀、不泄漏无关完整对象、分页展开、端到端重放恢复。

# router-resolution-web

多层路由匹配解释工作台内核：分析一个请求**为什么**落到了某个处理器，或者为什么在看起来匹配的情况下返回了错误。

## 架构

```
src/
  core/
    pattern.js      原始路径分段、模式编译、前缀/整段匹配（不匹配前不解码）
    host.js         主机规范化（大小写/端口/尾点）与主机条件
    params.js       分层参数作用域、解码规则、处理器守卫
    snapshot.js     路由快照校验、编译、不可变版本注册表
    matcher.js      分层匹配引擎，产出完整解释轨迹
    explanation.js  解释存储 + 摘要/层级树/候选详情三级视图
    regression.js   回归样本与版本差异重放
  server/
    service.js      服务端：保存快照、执行匹配、版本冻结、导出/恢复
  client/
    workbench.js    调用方工作台：乱序响应防护、逐层展开、样本固化
  index.js          公开模块入口
```

零依赖，Node ≥ 18。运行测试：`npm test`

## 分层匹配管线

每个请求依次穿过以下层级，每一层都留下候选、淘汰原因和证据：

1. **请求规范化** — 方法大写、主机小写化（记录 `host-case`/`method-case` 事件）、查询串剥离（保留在视图中但不参与匹配）
2. **挂载点** — 主机条件 → 每挂载点的重复分隔符策略（`collapseSlashes`）→ 前缀匹配（记录 `collapse-slashes` 归一化）
3. **资源路由** — 路由级主机条件 → 路径模式（`strictTrailingSlash` 决定尾部斜杠是否拒绝，记录 `trailing-slash` 归一化）
4. **方法约束** — 失败时收集 `allow` 方法并集
5. **参数解码** — 挂载参数用挂载的解码规则、路由参数用路由的解码规则；`%2F` 默认判 `ENCODED_SLASH`，畸形百分号序列判 `MALFORMED_ENCODING`
6. **处理器守卫** — `guard.require` / `guard.rejectIf` 以 `mount:x` / `route:x` 限定名读取分层参数，模拟处理器内部拒绝

## 结果分类

| 分类 | 含义 |
|---|---|
| `MATCHED` | 有候选通过全部层级，附带获胜者与分层参数视图 |
| `METHOD_NOT_ALLOWED` | 路径匹配但方法不允许，附 `allow` 列表 |
| `PARAM_DECODE_FAILED` | 方法通过但参数解码失败（编码斜杠/畸形编码） |
| `HANDLER_REJECTED` | 解码通过但处理器守卫拒绝 |
| `NO_MATCH` | 没有任何候选通过主机/路径层 |

分类取所有候选中**失败层级最深**者（handler > decode > method > path/host）。

## 关键语义

- **编码边界**：匹配在**原始（未解码）路径**上进行，`%2F` 不会在匹配阶段拆分段；解码是独立阶段，失败有精确原因码。
- **分层参数隔离**：参数永不并入全局字典。挂载层与路由层各有作用域帧，同名参数（如两处的 `:tenant`）互不覆盖；限定名 `mount:tenant` / `route:tenant` 分别取值。
- **版本冻结**：快照版本不可变（重复加载报错）。每次解释绑定产生它的版本；之后加载新版本，旧解释的层级树与候选详情仍解析自其钉住的版本。
- **回归样本**：`createSample` 把一次解释（输入 + 钉住版本 + 期望结果 + 候选指纹）冻结为样本；`replaySample` 默认在钉住版本上重放（必须完全一致），指定新版本则产出逐项差异（分类、获胜者、参数、候选级增删改）。
- **摘要先行**：`explain` 只返回计数、首要淘汰原因和前 K 个候选预览；`getLayerTree` 返回全部候选的轻量引用（不含路由定义）；`getCandidateDetail` 按需返回单个候选的完整定义与逐阶段评估。
- **乱序防护**：服务端方法全部异步。工作台为每次 `explain` 分配单调序号，迟到的响应被丢弃并记入 `view.discarded`；层级树/候选详情响应绑定解释 ID，视图已前进则丢弃。
- **状态恢复**：`service.exportState()` / `RouteResolutionService.restore(state)` 完整往返快照、解释、样本与 ID 计数器，恢复后数据链延续不断。

## 快速开始

```js
import {
  RouteResolutionService,
  ExplanationWorkbench,
  createDirectTransport,
  lookupParam,
} from "router-resolution-web";

const service = new RouteResolutionService();
service.loadSnapshot({
  version: "v1",
  apps: {
    shop: {
      routes: [
        { id: "r-user", path: "/users/:id(\\d+)", methods: ["GET"], handler: { name: "user.show" } },
      ],
    },
  },
  mounts: [{ id: "m-shop", prefix: "/shop/:tenant", app: "shop", host: "*.example.com" }],
});

const wb = new ExplanationWorkbench({ transport: createDirectTransport(service) });

await wb.explain({ method: "GET", host: "api.example.com", target: "/shop/acme/users/42" });
wb.view.current.classification;            // "MATCHED"
lookupParam(wb.view.current.params, "mount:tenant"); // "acme"
lookupParam(wb.view.current.params, "route:id");     // "42"

await wb.expandLayers();                   // 层级树：4 类候选与淘汰原因
const sample = await wb.pinAsSample("regression-1");
service.loadSnapshot({ /* ...v2... */ version: "v2", apps: { shop: { routes: [] } }, mounts: [] });
const drift = await wb.replaySample(sample.id, "v2"); // 版本差异逐项列出
```

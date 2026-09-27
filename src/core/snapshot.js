/**
 * 路由快照：把调用方提供的层级树（应用 -> 挂载点 -> 资源路由）编译成
 * 不可变版本。每次 publish 生成新 version 与内容指纹；解释对象只持有
 * version，运行期快照表变化不影响正在查看的解释。
 *
 * 快照保留两份数据：
 *  - def：调用方原始定义（冻结），重放/恢复时以此恢复完整对象
 *  - compiled：编译产物（主机/路径模式），匹配查询只查它
 */
import { compileHostPattern, compilePathPattern } from './patterns.js';
import { fingerprint, genId } from './identifiers.js';

let versionSeq = 0;

/**
 * 编译层级树为快照。
 * @param {object} def
 * @param {{version?:string,createdAt?:number}} [meta]
 */
export function buildSnapshot(def, meta = {}) {
  if (!def || !Array.isArray(def.apps)) {
    throw new Error('路由定义必须包含 apps 数组');
  }

  let order = 0;
  const apps = def.apps.map((appDef) => {
    if (!appDef.id) throw new Error('应用缺少 id');
    const hosts = (appDef.hosts ?? ['*']).map((h, i) => {
      if (h === '*') {
        return {
          raw: '*',
          pattern: null,
          priority: i,
          matchesAny: true
        };
      }
      return { raw: h, pattern: compileHostPattern(h), priority: i, matchesAny: false };
    });

    const mounts = (appDef.mounts ?? []).map((mountDef) => {
      const mountPattern = compilePathPattern(mountDef.path, { kind: mountDef.kind ?? 'mount' });
      const routes = (mountDef.routes ?? []).map((routeDef) => {
        const pattern = compilePathPattern(routeDef.path, { kind: 'resource' });
        const methods = routeDef.methods
          ? routeDef.methods.map((m) => m.toUpperCase())
          : ['GET', 'HEAD'];
        return {
          id: routeDef.id ?? genId('route'),
          order,
          def: routeDef,
          pattern,
          methods,
          methodSet: new Set(methods),
          priority: routeDef.priority ?? 0,
          handler: routeDef.handler ?? null,
          paramRules: routeDef.paramRules ?? [],
          queryRules: routeDef.queryRules ?? [],
          segmentRefs: null, // 匹配时按目标动态生成
          routeOrder: order++
        };
      });
      return {
        id: mountDef.id ?? genId('mount'),
        def: mountDef,
        pattern: mountPattern,
        priority: mountDef.priority ?? 0,
        paramRules: mountDef.paramRules ?? [],
        queryRules: mountDef.queryRules ?? [],
        routes
      };
    });

    return {
      id: appDef.id,
      def: appDef,
      hosts,
      priority: appDef.priority ?? 0,
      paramRules: appDef.paramRules ?? [],
      queryRules: appDef.queryRules ?? [],
      mounts
    };
  });

  const contentFingerprint = fingerprint(def);
  versionSeq += 1;
  const version = meta.version ?? `v${versionSeq}-${contentFingerprint.slice(0, 10)}`;
  const snapshot = {
    version,
    fingerprint: contentFingerprint,
    createdAt: meta.createdAt ?? Date.now(),
    def,
    apps
  };
  deepFreeze(def);
  return snapshot;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
}

/** 路由快照版本存储（发布/获取/列出/淘汰）。 */
export class SnapshotStore {
  constructor({ retention = 16 } = {}) {
    this.retention = retention;
    /** @type {Map<string,object>} */
    this.versions = new Map();
    /** @type {string[]} */
    this.history = [];
  }

  /**
   * 发布一份新快照。相同内容产生相同指纹，但 version 仍递增；
   * 返回的 snapshot 与历史中旧版本互不影响。
   */
  publish(def, meta = {}) {
    const snapshot = buildSnapshot(def, meta);
    this.versions.set(snapshot.version, snapshot);
    this.history.push(snapshot.version);
    while (this.history.length > this.retention) {
      const dropped = this.history.shift();
      this.versions.delete(dropped);
    }
    return snapshot;
  }

  /** @returns {object|null} */
  get(version) {
    return this.versions.get(version) ?? null;
  }

  current() {
    const v = this.history[this.history.length - 1];
    return v ? this.versions.get(v) : null;
  }

  list() {
    return this.history.map((version) => {
      const s = this.versions.get(version);
      return { version, fingerprint: s.fingerprint, createdAt: s.createdAt };
    });
  }

  evict(version) {
    this.versions.delete(version);
    this.history = this.history.filter((v) => v !== version);
  }
}

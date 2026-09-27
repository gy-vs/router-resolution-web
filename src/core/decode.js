/**
 * 参数解码规则引擎。
 *
 * 规则按 scope 分别声明（app/mount/resource/query），匹配阶段只产出
 * “仍编码的原始值 + 来源引用”，解码在独立的 decode 层查询里执行：
 *
 *   presence（必填/默认值） -> percent（decodeURIComponent）
 *   -> type（内置解码器）   -> constraints（min/max/pattern/enum）
 *
 * 所有失败都收集（不止第一个），每条失败带 scope、name、stage、原始值
 * 与来源引用，作为定位“哪个输入导致解码失败”的证据。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function percentDecode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    throw new Error(`非法百分号编码：${raw}（${err.message}）`);
  }
}

/** @type {Record<string,(raw:string)=>unknown>} */
export const decoders = {
  raw: (v) => v,
  string: (v) => percentDecode(v),
  int: (v) => {
    const d = percentDecode(v);
    if (!/^-?\d+$/.test(d)) throw new Error(`不是整数：${d}`);
    const n = Number(d);
    if (!Number.isSafeInteger(n)) throw new Error(`整数超出安全范围：${d}`);
    return n;
  },
  number: (v) => {
    const d = percentDecode(v);
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(d)) throw new Error(`不是数字：${d}`);
    return Number(d);
  },
  boolean: (v) => {
    const d = percentDecode(v);
    if (d === 'true' || d === '1') return true;
    if (d === 'false' || d === '0') return false;
    throw new Error(`不是布尔字面量：${d}`);
  },
  uuid: (v) => {
    const d = percentDecode(v);
    if (!UUID_RE.test(d)) throw new Error(`不是 UUID：${d}`);
    return d;
  },
  slug: (v) => {
    const d = percentDecode(v);
    if (!SLUG_RE.test(d)) throw new Error(`不是 slug：${d}`);
    return d;
  }
};

function applyConstraints(value, rule) {
  if (rule.enum && !rule.enum.includes(value)) {
    throw new Error(`值 ${JSON.stringify(value)} 不在枚举 [${rule.enum.join(', ')}] 中`);
  }
  if (typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) throw new Error(`值 ${value} 小于最小值 ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) throw new Error(`值 ${value} 大于最大值 ${rule.max}`);
  }
  if (typeof value === 'string' && rule.pattern) {
    const re = rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern);
    if (!re.test(value)) throw new Error(`值 ${JSON.stringify(value)} 不匹配 ${re}`);
  }
}

function decodeOne(raw, rule) {
  const type = rule.type ?? 'string';
  const decoder = decoders[type];
  if (!decoder) throw new Error(`未知解码器类型：${type}`);
  const stages = type === 'raw' ? [] : ['percent'];
  // type 与 percent 在解码器内部一并完成，失败阶段映射在调用处区分不了 URIError，
  // 这里按错误消息前缀粗分；保留 stages 供解释视图展示管线。
  const value = decoder(raw);
  applyConstraints(value, rule);
  return { value, stages };
}

/**
 * 对单层原始参数执行规则集。
 *
 * @param {Record<string,unknown>} rawParams 标量或数组（splat/重复 query）
 * @param {object[]} rules
 * @param {Record<string,object>} refs 名称 -> 来源引用（段位置/entry 下标/标签）
 * @param {string} scope 层名
 * @returns {{params:Record<string,unknown>, failures:object[], missing:string[]}}
 */
export function decodeLayer(rawParams, rules, refs, scope) {
  const params = {};
  const failures = [];
  const missing = [];

  for (const rule of rules) {
    const has = Object.prototype.hasOwnProperty.call(rawParams, rule.name);
    let raw = rawParams[rule.name];

    if (!has || raw === undefined || raw === null) {
      if (rule.default !== undefined) {
        params[rule.name] = rule.default;
        continue;
      }
      if (rule.required) {
        missing.push(rule.name);
        failures.push({
          scope,
          name: rule.name,
          stage: 'presence',
          message: `缺少必填参数 ${rule.name}`,
          rule: rule.id ?? `${scope}.${rule.name}`,
          ref: refs[rule.name] ?? null
        });
        continue;
      }
      continue;
    }

    try {
      if (Array.isArray(raw)) {
        const values = raw.map((item) => decodeOne(item, rule).value);
        params[rule.name] = values;
      } else {
        const { value } = decodeOne(raw, rule);
        params[rule.name] = value;
      }
    } catch (err) {
      const isEncoding = /百分号编码|非法/.test(err.message);
      failures.push({
        scope,
        name: rule.name,
        stage: isEncoding ? 'percent' : 'type',
        message: err.message,
        rule: rule.id ?? `${scope}.${rule.name}`,
        raw,
        ref: refs[rule.name] ?? null
      });
    }
  }

  // 未声明规则的捕获参数（典型为 splat）按原始值透传：匹配阶段捕获到的值不会丢，
  // 但也不会被意外 percent 解码——需要解码时调用方显式声明规则。
  const declared = new Set(rules.map((r) => r.name));
  for (const [name, value] of Object.entries(rawParams)) {
    if (!declared.has(name) && value !== undefined && value !== null) {
      params[name] = value;
    }
  }
  return { params, failures, missing };
}

/** 百分号解码（供视图直接展示解码后的参数，而非规则集计算结果） */
export function safePercentDecode(raw) {
  if (raw == null) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

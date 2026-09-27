/**
 * 路径与主机模式编译/匹配。
 *
 * 路径模式语法（定义在路由表里，编译进快照后不可变）：
 *   /users              字面量分段
 *   /users/:id          单段参数
 *   /files/*path        尾段 splat，捕获剩余所有分段（只允许最后一段）
 *   /users/ 与 /users   tailEmpty 不同，trailingSlash=exact 时是两个候选
 *
 * 主机模式语法（按 '.' 切标签）：
 *   api.example.com     字面量
 *   :tenant.example.com 单标签参数
 *   *.example.com       首标签 * 匹配任意一个标签
 *   **.example.com      首标签 ** 匹配一个或多个前缀标签
 *
 * 排序得分采用三进制基数（早段权重高）：字面量=2，参数=1，通配=0；
 * 同分时使用调用方给出的 priority，再同分按注册顺序。
 */

const SEG_LIT = 2;
const SEG_PARAM = 1;
const SEG_SPLAT = 0;

/**
 * 编译路径模式。
 * @param {string} source
 * @param {{kind?:'resource'|'mount'}} [opts]
 */
export function compilePathPattern(source, opts = {}) {
  const kind = opts.kind ?? 'resource';
  if (typeof source !== 'string' || !source.startsWith('/')) {
    throw new Error(`路径模式必须以 "/" 开头：${String(source)}`);
  }
  const tailEmpty = source.length > 1 && source.endsWith('/');
  const body = tailEmpty ? source.slice(0, -1) : source;
  const parts = body === '/' || body === '' ? [] : body.split('/').slice(1);
  const segments = [];
  const paramNames = [];
  parts.forEach((part, idx) => {
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!name) throw new Error(`模式 ${source} 第 ${idx} 段参数名为空`);
      segments.push({ type: 'param', name });
      paramNames.push(name);
    } else if (part.startsWith('*')) {
      if (idx !== parts.length - 1) {
        throw new Error(`模式 ${source} 的 splat 只能出现在最后一段`);
      }
      const name = part.slice(1) || 'splat';
      segments.push({ type: 'splat', name });
      paramNames.push(name);
    } else {
      segments.push({ type: 'lit', value: part });
    }
  });

  const dupes = paramNames.filter((n, i) => paramNames.indexOf(n) !== i);
  if (dupes.length) throw new Error(`模式 ${source} 参数名重复：${dupes.join(', ')}`);

  let specificity = 0;
  for (const seg of segments) {
    const score = seg.type === 'lit' ? SEG_LIT : seg.type === 'param' ? SEG_PARAM : SEG_SPLAT;
    specificity = specificity * 3 + score;
  }

  return { kind, source, segments, tailEmpty, specificity, paramNames };
}

/**
 * 资源模式精确匹配（按分段对齐）。
 * @param {ReturnType<compilePathPattern>} pattern
 * @param {object[]} targetSegments parseTarget 产出的归一化分段
 * @param {'ignore'|'exact'} trailingPolicy
 */
export function matchResourcePattern(pattern, targetSegments, trailingPolicy) {
  const segs = pattern.segments;
  const lastPattern = segs[segs.length - 1];
  const splat = lastPattern && lastPattern.type === 'splat' ? lastPattern : null;
  const fixedCount = splat ? segs.length - 1 : segs.length;

  // 尾部空段只在 exact 策略下存在；ignore 策略解析时已剥离目标尾空段，
  // 模式侧同样忽略“带尾斜杠定义”的差异（/items/ 与 /items 在 ignore 下等价）
  const ttail = targetSegments.length > 0 && targetSegments[targetSegments.length - 1].empty;
  if (trailingPolicy === 'exact') {
    if (Boolean(pattern.tailEmpty) !== Boolean(ttail)) {
      return { matched: false, reason: 'TRAILING_SLASH_MISMATCH' };
    }
  }

  const effective = ttail ? targetSegments.slice(0, -1) : targetSegments;
  if (!splat && effective.length !== fixedCount) {
    return { matched: false, reason: 'SEGMENT_COUNT_MISMATCH' };
  }
  if (splat && effective.length < fixedCount) {
    return { matched: false, reason: 'SEGMENT_COUNT_MISMATCH' };
  }

  const params = {};
  const paramIndices = {};
  for (let i = 0; i < fixedCount; i += 1) {
    const p = segs[i];
    const t = effective[i];
    if (!t || t.empty) return { matched: false, reason: 'EMPTY_SEGMENT', at: i };
    if (p.type === 'lit') {
      if (p.value !== t.raw) return { matched: false, reason: 'LITERAL_MISMATCH', at: i };
    } else if (p.type === 'param') {
      params[p.name] = t.raw;
      paramIndices[p.name] = i;
    }
  }
  if (splat) {
    params[splat.name] = effective.slice(fixedCount).map((s) => s.raw);
    paramIndices[splat.name] = { splatFrom: fixedCount, splatTo: effective.length };
  }
  return { matched: true, params, paramIndices, segmentCount: effective.length };
}

/**
 * 挂载模式前缀匹配，返回挂载参数与“挂载点之后”的剩余分段。
 * @param {ReturnType<compilePathPattern>} mount
 * @param {object[]} targetSegments
 * @param {'ignore'|'exact'} trailingPolicy
 */
export function matchMountPrefix(mount, targetSegments, trailingPolicy) {
  const segs = mount.segments;
  const lastPattern = segs[segs.length - 1];
  const splat = lastPattern && lastPattern.type === 'splat' ? lastPattern : null;
  const fixedCount = splat ? segs.length - 1 : segs.length;

  const ttail = targetSegments.length > 0 && targetSegments[targetSegments.length - 1].empty;
  const effective = ttail ? targetSegments.slice(0, -1) : targetSegments;

  // 挂载点通常没有尾斜杠语义；exact 策略下挂载点自身带尾斜杠不常见，仍要求长度条件
  if (!splat && effective.length < fixedCount) {
    return { matched: false, reason: 'PREFIX_TOO_SHORT' };
  }
  if (splat && effective.length < fixedCount + 1) {
    return { matched: false, reason: 'PREFIX_TOO_SHORT' };
  }
  if (trailingPolicy === 'exact' && mount.tailEmpty) {
    // /m/ 形式挂载点：目标必须正好以空段结束在该边界
    if (!ttail || effective.length !== fixedCount) {
      return { matched: false, reason: 'TRAILING_SLASH_MISMATCH' };
    }
  }

  const params = {};
  const paramIndices = {};
  for (let i = 0; i < fixedCount; i += 1) {
    const p = segs[i];
    const t = effective[i];
    if (t.empty) return { matched: false, reason: 'EMPTY_SEGMENT', at: i };
    if (p.type === 'lit') {
      if (p.value !== t.raw) return { matched: false, reason: 'LITERAL_MISMATCH', at: i };
    } else {
      params[p.name] = t.raw;
      paramIndices[p.name] = i;
    }
  }
  let remainder;
  if (splat) {
    // splat 值捕获剩余段作为挂载参数；remainder 同样保留全部剩余段，
    // 让资源层在其之上继续做模式匹配（splat 起到“锚定前缀”的作用）
    const tail = effective.slice(fixedCount);
    params[splat.name] = tail.map((s) => s.raw);
    paramIndices[splat.name] = { splatFrom: fixedCount, splatTo: effective.length };
    remainder = targetSegments.slice(fixedCount);
  } else {
    remainder = targetSegments.slice(fixedCount);
  }
  return { matched: true, params, paramIndices, remainder };
}

/**
 * 编译主机模式。
 * @param {string} source
 */
export function compileHostPattern(source) {
  const labels = source.split('.');
  const compiled = labels.map((label) => {
    if (label.startsWith(':')) return { type: 'param', name: label.slice(1) };
    if (label === '*') return { type: 'wild1' };
    if (label === '**') return { type: 'wildN' };
    return { type: 'lit', value: label };
  });
  compiled.forEach((l, i) => {
    if ((l.type === 'wild1' || l.type === 'wildN') && i !== 0) {
      throw new Error(`主机模式 ${source} 的 * / ** 只能出现在首标签`);
    }
  });
  // 主机特异性：标签数越多越具体；长度相同再逐段比较（字面量>参数>通配）
  let specificity = compiled.length * 10;
  for (const l of compiled) {
    specificity += l.type === 'lit' ? 2 : l.type === 'param' ? 1 : 0;
  }
  return { source, labels: compiled, specificity };
}

/**
 * 匹配主机（两侧都应已按策略归一化）。
 * @returns {{matched:boolean, params?:object, reason?:string}}
 */
export function matchHost(pattern, normalizedHost) {
  if (normalizedHost == null) return { matched: false, reason: 'NO_HOST' };
  const hostLabels = normalizedHost.split('.');
  const pl = pattern.labels;
  const first = pl[0];
  let offset = 0;

  if (first && first.type === 'wildN') {
    offset = hostLabels.length - (pl.length - 1);
    if (offset < 1) return { matched: false, reason: 'HOST_LABEL_COUNT' };
  } else if (first && first.type === 'wild1') {
    offset = hostLabels.length - pl.length;
    if (offset !== 0) return { matched: false, reason: 'HOST_LABEL_COUNT' };
  } else if (hostLabels.length !== pl.length) {
    return { matched: false, reason: 'HOST_LABEL_COUNT' };
  }

  const params = {};
  const paramLabels = {};
  for (let i = 0; i < pl.length; i += 1) {
    const p = pl[i];
    const h = hostLabels[offset + i];
    if (h === undefined) return { matched: false, reason: 'HOST_LABEL_COUNT' };
    if (p.type === 'lit') {
      if (p.value !== h) return { matched: false, reason: 'HOST_LITERAL_MISMATCH', at: i };
    } else if (p.type === 'param') {
      params[p.name] = h;
      paramLabels[p.name] = offset + i;
    }
    // wild1 / wildN 的首标签不捕获（需要值时请用 :name）
  }
  return { matched: true, params, paramLabels };
}

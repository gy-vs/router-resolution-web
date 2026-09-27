/**
 * 请求目标解析与归一化。
 *
 * 输入目标可以是 origin-form（"/v1/users/42?x=1"）或绝对 URI
 * （"https://API.Example.com/v1/path"）。解析保留：
 *  - 原始串（rawPath / rawQuery / host 原文）
 *  - 每个原始分段的字节位置（定位失败输入的证据）
 *  - 归一化事件（折叠、去尾斜杠、主机小写……）
 *
 * 边界策略全部显式可配（见 DEFAULT_POLICY），策略拒绝会产出
 * normalizationFailed，resolver 据此归类为 TARGET_INVALID，
 * 不会继续任何分层查询。
 */

export const DEFAULT_POLICY = Object.freeze({
  /** 编码斜杠 %2F：keep=保留在单段内 | split=拆成多段 | reject=拒绝目标 */
  encodedSlash: 'keep',
  /** 重复分隔符 //：collapse=折叠 | keep=保留空段 | reject=拒绝目标 */
  duplicateSeparators: 'collapse',
  /** 尾部斜杠：ignore=忽略 | exact=按精确匹配处理（/users 与 /users/ 不同） */
  trailingSlash: 'ignore',
  /** 主机大小写：insensitive=归一为小写 | exact=保留原文 */
  hostCase: 'insensitive',
  /** 主机端口：strip=去除 :port | keep=保留 */
  hostPort: 'strip',
  /** 路径分段大小写：exact（默认）/ insensitive */
  pathCase: 'exact'
});

const ENCODED_SLASH = /%2f/i;

/**
 * 扫描 pathname，按 '/' 切出带字节位置的原始分段（不做任何解码）。
 * @param {string} path
 * @returns {Array<{raw:string,start:number,end:number,empty:boolean,encodedSlash:boolean}>}
 */
export function scanRawSegments(path) {
  const segments = [];
  const absolute = path.startsWith('/');
  let start = absolute ? 1 : 0;
  for (let i = start; i <= path.length; i += 1) {
    if (i === path.length || path[i] === '/') {
      const raw = path.slice(start, i);
      segments.push({
        raw,
        start,
        end: i,
        empty: raw === '',
        encodedSlash: ENCODED_SLASH.test(raw)
      });
      start = i + 1;
      if (i === path.length) break;
    }
  }
  return segments;
}

/**
 * 应用编码斜杠策略，返回展开后的分段（一个原始段可能因 split 变成多段）。
 */
function applyEncodedSlash(rawSegments, policy, events) {
  const out = [];
  for (const seg of rawSegments) {
    if (!seg.encodedSlash) {
      out.push(seg);
      continue;
    }
    if (policy.encodedSlash === 'reject') {
      return {
        failed: {
          code: 'ENCODED_SLASH_REJECTED',
          segment: seg,
          message: `分段 "${seg.raw}" 含编码斜杠，策略 encodedSlash=reject`
        }
      };
    }
    if (policy.encodedSlash === 'split') {
      // 按 %2F 边界切开，分隔符本身被消费
      const parts = seg.raw.split(ENCODED_SLASH);
      let cursor = seg.start;
      parts.forEach((part, idx) => {
        out.push({
          raw: part,
          start: cursor,
          end: cursor + part.length,
          empty: part === '',
          encodedSlash: false,
          splitFrom: seg.start
        });
        cursor += part.length;
        if (idx < parts.length - 1) cursor += 3; // %2F 三字节
      });
      events.push({ type: 'encoded-slash-split', at: seg.start, raw: seg.raw });
    } else {
      // keep：原样保留，%2F 留在段内，匹配后解码时才变成 '/'
      out.push(seg);
      events.push({ type: 'encoded-slash-kept', at: seg.start, raw: seg.raw });
    }
  }
  return { segments: out };
}

/**
 * 应用重复分隔符策略与尾部斜杠策略。
 */
function normalizeSegments(rawSegments, rawPath, policy, events) {
  // 根路径 "/" 只有一个空段，它不构成“重复分隔”，也不是尾部斜杠差异
  if (rawPath === '/' || rawPath === '') return { segments: [] };

  const trailingRaw = rawPath.endsWith('/');
  let segments = rawSegments;

  if (policy.duplicateSeparators === 'reject') {
    const offender = segments.find((s) => s.empty && s.end < rawPath.length);
    if (offender) {
      return {
        failed: {
          code: 'DUPLICATE_SEPARATOR_REJECTED',
          segment: offender,
          message: `位置 ${offender.start} 出现重复分隔符，策略 duplicateSeparators=reject`
        }
      };
    }
  } else if (policy.duplicateSeparators === 'collapse') {
    const kept = [];
    for (const seg of segments) {
      if (seg.empty && seg.end < rawPath.length) {
        events.push({ type: 'separator-collapsed', at: seg.start });
        continue;
      }
      kept.push(seg);
    }
    segments = kept;
  }

  if (trailingRaw && policy.trailingSlash === 'ignore') {
    // 折叠/保留之后，末尾空段代表尾斜杠
    if (segments.length > 0 && segments[segments.length - 1].empty) {
      const removed = segments.pop();
      events.push({ type: 'trailing-slash-ignored', at: removed.start });
    }
  }
  // exact：保留末尾空段（pattern 编译侧同样把尾斜杠编成空字面量段）

  return { segments };
}

/**
 * 解析查询串为有序 entry 列表（重复键保留，不做解码）。
 * @param {string} rawQuery 不含 '?'
 * @returns {Array<{key:string,rawValue:string|null,index:number,start:number}>}
 */
export function parseQueryEntries(rawQuery) {
  if (!rawQuery) return [];
  const entries = [];
  let start = 0;
  let index = 0;
  for (let i = 0; i <= rawQuery.length; i += 1) {
    if (i === rawQuery.length || rawQuery[i] === '&') {
      const piece = rawQuery.slice(start, i);
      if (piece !== '') {
        const eq = piece.indexOf('=');
        const key = eq === -1 ? piece : piece.slice(0, eq);
        const rawValue = eq === -1 ? null : piece.slice(eq + 1);
        entries.push({ key, rawValue, index, start });
        index += 1;
      } else {
        // && 之类的空 entry 记录为事件，不参与匹配
        entries.push({ key: '', rawValue: null, index, start, empty: true });
        index += 1;
      }
      start = i + 1;
      if (i === rawQuery.length) break;
    }
  }
  return entries;
}

/**
 * 主机归一化（小写、尾点、端口）。
 * @returns {{raw:string|null,normalized:string|null,events:object[],lowercased:boolean}}
 */
export function normalizeHost(rawHost, policy) {
  const events = [];
  if (rawHost == null) return { raw: null, normalized: null, events, lowercased: false };
  let host = String(rawHost);
  let lowercased = false;
  if (policy.hostPort === 'strip') {
    // 去 :port（IPv6 数字形式不在本题范围）
    const colon = host.lastIndexOf(':');
    if (colon !== -1) {
      events.push({ type: 'host-port-stripped', at: colon, raw: host.slice(colon) });
      host = host.slice(0, colon);
    }
  }
  if (host.endsWith('.')) {
    events.push({ type: 'host-trailing-dot-trimmed', raw: host });
    host = host.slice(0, -1);
  }
  if (policy.hostCase === 'insensitive') {
    const lowered = host.toLowerCase();
    if (lowered !== host) {
      lowercased = true;
      events.push({ type: 'host-lowercased', from: host, to: lowered });
    }
    host = lowered;
  }
  return { raw: String(rawHost), normalized: host, events, lowercased };
}

/**
 * 解析请求目标。
 *
 * @param {{method?:string,host?:string,target:string}} request
 * @param {typeof DEFAULT_POLICY} [policy]
 * @returns {object} ParsedTarget
 */
export function parseTarget(request, policy = DEFAULT_POLICY) {
  const events = [];
  let host = request.host ?? null;
  let rawPath;
  let rawQuery = '';

  const target = String(request.target ?? '');
  if (/^https?:\/\//i.test(target)) {
    // 绝对 URI：用 URL 取出 host 与 path（pathname 仍是百分号编码原文）
    let url;
    try {
      url = new URL(target);
    } catch (err) {
      return { invalid: { code: 'URI_MALFORMED', message: err.message }, rawTarget: target };
    }
    host ??= url.host;
    rawPath = url.pathname;
    rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  } else {
    const q = target.indexOf('?');
    if (q === -1) {
      rawPath = target;
    } else {
      rawPath = target.slice(0, q);
      rawQuery = target.slice(q + 1);
    }
  }

  if (!rawPath.startsWith('/')) {
    return {
      invalid: {
        code: 'PATH_NOT_ABSOLUTE',
        message: `origin-form 目标必须以 "/" 开头：${rawPath}`,
        at: rawPath
      },
      rawTarget: target
    };
  }

  const hostInfo = normalizeHost(host, policy);
  events.push(...hostInfo.events);

  const rawSegments = scanRawSegments(rawPath);
  const slashResult = applyEncodedSlash(rawSegments, policy, events);
  if (slashResult.failed) {
    return { invalid: slashResult.failed, rawTarget: target, events, host: hostInfo };
  }
  const normResult = normalizeSegments(slashResult.segments, rawPath, policy, events);
  if (normResult.failed) {
    return { invalid: normResult.failed, rawTarget: target, events, host: hostInfo };
  }

  return {
    invalid: null,
    rawTarget: target,
    method: (request.method ?? 'GET').toUpperCase(),
    host: hostInfo,
    rawPath,
    rawQuery,
    rawSegments,
    segments: normResult.segments,
    queryEntries: parseQueryEntries(rawQuery),
    events
  };
}

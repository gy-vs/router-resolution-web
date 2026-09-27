/**
 * 匹配终态分类与错误类型。
 *
 * 四类失败 + 成功，调用方可以仅凭 reason 语义区分：
 *  - NO_MATCH                 没有任何挂载/资源结构匹配
 *  - METHOD_NOT_ALLOWED       结构匹配但方法约束全部淘汰
 *  - DECODE_FAILED            匹配成功，但某层参数解码规则失败
 *  - HANDLER_REJECTED         处理器内部拒绝
 *  - MATCHED                  成功
 *
 * 另有两类内核侧异常（不属于“请求匹配失败”，而是工作台自身状态）：
 *  - TARGET_INVALID           原始目标无法解析（编码斜杠/重复分隔符等边界策略拒绝）
 *  - SNAPSHOT_UNKNOWN         请求引用的快照版本不存在或已被淘汰
 */

export const Reason = Object.freeze({
  MATCHED: 'MATCHED',
  NO_MATCH: 'NO_MATCH',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  DECODE_FAILED: 'DECODE_FAILED',
  HANDLER_REJECTED: 'HANDLER_REJECTED',
  TARGET_INVALID: 'TARGET_INVALID',
  SNAPSHOT_UNKNOWN: 'SNAPSHOT_UNKNOWN'
});

/** 终态 -> HTTP 状态码（用于 HTTP 适配层，内核不强制） */
export const STATUS_BY_REASON = Object.freeze({
  MATCHED: 200,
  NO_MATCH: 404,
  METHOD_NOT_ALLOWED: 405,
  DECODE_FAILED: 400,
  HANDLER_REJECTED: 400,
  TARGET_INVALID: 400,
  SNAPSHOT_UNKNOWN: 409
});

export class RoutingFailure extends Error {
  /**
   * @param {string} reason  Reason 之一
   * @param {object} [extra]
   * @param {object} [extra.evidence] 指向失败输入/中间状态的证据
   */
  constructor(reason, extra = {}) {
    super(reason);
    this.name = 'RoutingFailure';
    this.reason = reason;
    this.evidence = extra.evidence ?? null;
    if (extra.allow !== undefined) this.allow = extra.allow;
  }
}

export class DecodeFailure extends RoutingFailure {
  constructor(evidence) {
    super(Reason.DECODE_FAILED, { evidence });
    this.name = 'DecodeFailure';
  }
}

export class HandlerRejection extends RoutingFailure {
  constructor(evidence, status = 400) {
    super(Reason.HANDLER_REJECTED, { evidence });
    this.name = 'HandlerRejection';
    this.status = status;
  }
}

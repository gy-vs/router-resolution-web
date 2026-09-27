/**
 * 关联感知的异步查询总线。
 *
 * 每一层（应用扫描、挂载匹配、资源查询、方法校验、排序、服务端计算、
 * 参数解码、处理器）都是一次“查询作业”，统一经总线投递。总线不保证
 * 按层顺序返回结果 —— 真实的服务端计算与查询层可能乱序，甚至给旧
 * 关联送来迟到响应。resolver 必须：
 *
 *  1. 按固定层级顺序组装证据，与返回顺序无关；
 *  2. 用 correlationId 过滤别的解释的响应（foreign）；
 *  3. 同一 jobId 的重复响应当作 stale 记录，绝不二次应用。
 *
 * 生产用默认后端（微任务 FIFO，模拟查询层延迟）；测试用 ControlledBus
 * 精确控制完成顺序、注入外域响应和迟到响应。
 */

class Mailbox {
  constructor(correlationId, bus) {
    this.correlationId = correlationId;
    this.bus = bus;
    /** @type {object[]} */
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.duplicates = 0;
    /** 解释存活期间本信箱丢弃的统计 */
    this.stats = { foreign: 0, stale: 0 };
    /** 已收到过的作业 id，重复到达即记为 stale */
    this.settledJobs = new Set();
    /** 已投递但尚未被消费的作业 id（用于识别“首响应还在排队时的重复投递”） */
    this.pendingJobs = new Set();
  }

  push(envelope) {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(envelope);
      return;
    }
    this.queue.push(envelope);
  }

  /** 取得下一个属于本作业的响应；外域响应会被跳过但计数，其他作业的响应留在队列。 */
  receive(jobId) {
    for (let i = 0; i < this.queue.length; i += 1) {
      const env = this.queue[i];
      if (env.correlationId !== this.correlationId) {
        this.stats.foreign += 1;
        this.bus.noteForeign(env);
        this.queue.splice(i, 1);
        i -= 1;
        continue;
      }
      if (env.jobId !== jobId) continue; // 乱序先到的其他作业响应，留在队列
      this.queue.splice(i, 1);
      this.pendingJobs.delete(jobId);
      this.settledJobs.add(jobId);
      return Promise.resolve(env);
    }
    return new Promise((resolve) => {
      const waiter = (env) => resolve(env);
      waiter.jobId = jobId;
      this.waiting.push(waiter);
    });
  }
}

export class CorrelationBus {
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,Mailbox>} */
    this.mailboxes = new Map();
    this.foreign = [];
  }

  mailbox(correlationId) {
    let box = this.mailboxes.get(correlationId);
    if (!box) {
      box = new Mailbox(correlationId, this);
      this.mailboxes.set(correlationId, box);
    }
    return box;
  }

  noteForeign(env) {
    this.foreign.push(env);
  }

  _ingest(envelope) {
    const box = this.mailboxes.get(envelope.correlationId);
    if (!box) {
      // 解释已回收/不存在：属于外域迟到响应
      this.noteForeign(envelope);
      return;
    }
    if (box.settledJobs.has(envelope.jobId) || box.pendingJobs.has(envelope.jobId)) {
      // 同一作业的第二个响应：无论首响应是否已消费，都记为迟到结果，绝不二次应用
      box.stats.stale += 1;
      return;
    }
    // 唤醒对应的等待接收者
    for (let i = 0; i < box.waiting.length; i += 1) {
      const waiter = box.waiting[i];
      if (waiter.jobId === envelope.jobId) {
        box.waiting.splice(i, 1);
        box.settledJobs.add(envelope.jobId);
        waiter(envelope);
        return;
      }
    }
    box.pendingJobs.add(envelope.jobId);
    box.queue.push(envelope);
  }

  /**
   * 投递一个作业，返回该作业的接收 Promise。
   * @param {object} job
   * @param {string} correlationId
   * @returns {{receive:()=>Promise<object>, mailbox:Mailbox}}
   */
  post(job, correlationId) {
    const mailbox = this.mailbox(correlationId);
    const envelopeBase = { jobId: job.id, correlationId, kind: job.kind };
    this.backend.submit({
      job,
      correlationId,
      emit: (result) => {
        this._ingest({ ...envelopeBase, ...result, settledAt: this.backend.now() });
      }
    });
    return {
      receive: () => mailbox.receive(job.id),
      mailbox
    };
  }

  /** 测试用：直接塞入一个响应（绕过计算），可用于外域/迟到注入 */
  inject(envelope) {
    this._ingest(envelope);
  }

  markDone(correlationId) {
    const box = this.mailboxes.get(correlationId);
    if (box) box.done = true;
  }
}

/** 默认后端：微任务 FIFO，延迟可配，返回顺序与提交顺序一致。 */
export class FIFOBackend {
  constructor({ delayMs = 0 } = {}) {
    this.delayMs = delayMs;
    this.settleSeq = 0;
  }

  now() {
    return this.settleSeq;
  }

  submit({ job, emit }) {
    const run = async () => {
      this.settleSeq += 1;
      const seq = this.settleSeq;
      try {
        const value = await job.compute(seq);
        emit({ ok: true, value, seq });
      } catch (err) {
        emit({ ok: false, error: serializeError(err), seq });
      }
    };
    if (this.delayMs > 0) setTimeout(run, this.delayMs);
    else queueMicrotask(run);
  }
}

/**
 * 受控后端：作业挂起，测试代码用 settle(order) 决定完成顺序，
 * 并可注入失败、外域响应和重复（迟到）响应。
 */
export class ControlledBackend {
  constructor() {
    /** @type {Array<{id:string,kind:string,correlationId:string,compute:Function,emit:Function,submittedSeq:number}>} */
    this.pending = [];
    this.settleSeq = 0;
    this.submittedSeq = 0;
  }

  now() {
    return this.settleSeq;
  }

  submit(entry) {
    this.pending.push({
      ...entry,
      id: entry.job.id,
      kind: entry.job.kind,
      compute: entry.job.compute,
      submittedSeq: this.submittedSeq++
    });
  }

  /** 找到待处理作业。 */
  find(predicate) {
    return this.pending.find((p) => predicate(p)) ?? null;
  }

  byKind(kind, correlationId = null) {
    return this.find(
      (p) => p.kind === kind && (correlationId === null || p.correlationId === correlationId)
    );
  }

  settle(entryLike, overrides = {}) {
    const idx = this.pending.findIndex(
      (p) => p.id === entryLike.id && p.correlationId === entryLike.correlationId
    );
    if (idx === -1) throw new Error(`作业 ${entryLike.id} 不在待处理队列`);
    const [entry] = this.pending.splice(idx, 1);
    this.settleSeq += 1;
    if (overrides.error) {
      entry.emit({ ok: false, error: overrides.error, seq: this.settleSeq });
      return Promise.resolve(entry);
    }
    return Promise.resolve()
      .then(() => (overrides.value !== undefined ? overrides.value : entry.compute(this.settleSeq)))
      .then(
        (value) => {
          entry.emit({ ok: true, value, seq: this.settleSeq });
          return entry;
        },
        (err) => {
          entry.emit({
            ok: false,
            error: err instanceof Error ? serializeError(err) : { message: String(err) },
            seq: this.settleSeq
          });
          return entry;
        }
      );
  }

  /** 已 settle 的作业再投递一个响应（模拟迟到/重复结果）。 */
  resend(entry, result) {
    this.settleSeq += 1;
    entry.emit({ seq: this.settleSeq, ...result });
  }

  /** 注入一条响应（不改 pending），用于外域/重复响应。 */
  emitRaw(entryLike, result) {
    this.settleSeq += 1;
    entryLike.emit({ seq: this.settleSeq, ...result });
  }

  pendingKinds(correlationId = null) {
    return this.pending
      .filter((p) => correlationId === null || p.correlationId === correlationId)
      .map((p) => p.kind);
  }
}

export function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

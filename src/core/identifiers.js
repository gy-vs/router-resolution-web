/**
 * 稳定标识与规范化哈希。
 *
 * 解释链上的每一个对象（快照、解释、候选、样本……）都有可读 id；
 * 快照指纹用规范化 JSON + sha256 生成，保证“同一份路由表 -> 同一个指纹”，
 * 使回归重放能在不同进程里恢复出版本对应关系。
 */
import { createHash } from 'node:crypto';

let seq = 0;

/**
 * 生成进程内可读 id。
 * @param {string} prefix
 * @returns {string}
 */
export function genId(prefix) {
  seq += 1;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}${seq.toString(36)}${rand}`;
}

/**
 * 规范化 JSON：对象键排序，数组保持顺序。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`)
    .join(',')}}`;
}

/**
 * 计算值的 sha256 指纹（十六进制，前 16 位足够作为版本标签）。
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprint(value) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

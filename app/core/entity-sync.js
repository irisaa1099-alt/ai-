/** 角色卡、群资料的三方合并；浏览器与服务器共用，不依赖存储或界面。 */
import { applyChanges, diffChanges } from './sync.js';

const managed = new Set(['version', 'history', 'createdAt', 'updatedAt']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const entityFields = (value) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !managed.has(key)));
const fields = entityFields;
const atPath = (value, path) => path.reduce((node, key) => node?.[key], value);

function conflict() {
  const err = new Error('其他页面已修改同一份资料；本地修改已保留，请核对后再同步');
  err.status = 409;
  err.code = 'entity-conflict';
  return err;
}

/** base 为编辑前快照；只合并实际修改的字段，同字段冲突时保留两端并明确报错。 */
export function mergeEntity(current, body) {
  const data = body.data || body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('资料格式无效');
  if (current && equal(fields(current), fields(data))) {
    return { ...current, updatedAt: Math.max(Number(current.updatedAt || 0), Number(data.updatedAt || 0)) };
  } // 断线重放不重复加版本；单独更新时间仍生效
  if (!Object.hasOwn(body, 'base')) {
    // 兼容旧队列，但不允许旧版本整卡覆盖新版本。
    if (current && data.version != null && current.version != null && Number(data.version) <= Number(current.version)) throw conflict();
    return data;
  }
  if (!body.base) {
    if (current) throw conflict();
    return data;
  }
  if (!current) throw conflict();
  const before = fields(body.base);
  const changes = diffChanges(before, fields(data));
  for (const change of changes) {
    const live = atPath(fields(current), change.path);
    if (!equal(live, atPath(before, change.path)) && !equal(live, change.value)) throw conflict();
  }
  if (changes.every((change) => equal(atPath(fields(current), change.path), change.value))) {
    return { ...current, updatedAt: Math.max(Number(current.updatedAt || 0), Number(data.updatedAt || 0)) };
  }
  const next = applyChanges(current, changes);
  next.createdAt = current.createdAt;
  next.updatedAt = Math.max(Date.now(), Number(current.updatedAt || 0) + 1);
  next.version = Number(current.version || 0) + 1;
  if (Array.isArray(data.history) || Array.isArray(current.history)) {
    const snapshot = { ...current };
    delete snapshot.history;
    next.history = [...(current.history || []), { at: next.updatedAt, snapshot }].slice(-20);
  }
  return next;
}

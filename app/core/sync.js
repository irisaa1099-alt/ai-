/** JSON leaf changes: arrays are replaced, objects are merged field by field. */
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);

export function diffChanges(before, after, path = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !forbidden.has(key))
      .flatMap((key) => diffChanges(before[key], after[key], [...path, key]));
  }
  return [{ path, ...(after === undefined ? { remove: true } : { value: after }) }];
}

export function applyChanges(base, changes) {
  let result = JSON.parse(JSON.stringify(base || {}));
  if (!Array.isArray(changes)) throw new Error('无效的同步补丁');
  for (const change of changes) {
    const keys = change?.path;
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || forbidden.has(k))) {
      throw new Error('无效的同步路径');
    }
    if (!keys.length) {
      if (!object(change.value)) throw new Error('同步根节点必须是对象');
      result = JSON.parse(JSON.stringify(change.value));
      continue;
    }
    let target = result;
    for (const key of keys.slice(0, -1)) {
      if (!object(target[key])) target[key] = {};
      target = target[key];
    }
    const last = keys.at(-1);
    if (change.remove) delete target[last];
    else target[last] = JSON.parse(JSON.stringify(change.value));
  }
  return result;
}

/** Validate the complete backup before either storage layer is cleared. */
export function validateBackup(pack) {
  if (!object(pack) || !Array.isArray(pack.characters)) throw new Error('备份缺少有效的角色列表');
  const fields = { characters: ['id'], messages: ['id', 'charId'], memory: ['charId'],
    groups: ['id'], groupMessages: ['id', 'groupId'] };
  for (const [field, required] of Object.entries(fields)) {
    if (pack[field] === undefined && field !== 'characters') continue;
    if (!Array.isArray(pack[field])) throw new Error(`备份 ${field} 必须是数组`);
    const seen = new Set();
    for (const row of pack[field]) {
      if (!object(row) || required.some((key) => typeof row[key] !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(row[key]))) {
        throw new Error(`备份 ${field} 含有无效记录`);
      }
      const id = row.id || row.charId;
      if (seen.has(id)) throw new Error(`备份 ${field} 含有重复 ID`);
      seen.add(id);
    }
  }
  for (const field of ['settings', 'runtime']) {
    if (pack[field] != null && !object(pack[field])) throw new Error(`备份 ${field} 必须是对象`);
  }
}

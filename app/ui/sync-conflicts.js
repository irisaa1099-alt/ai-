import { getSyncConflict, resolveSyncConflict } from '../core/filestore.js';
import { el } from './dom.js';
import { modal, toast } from './toast.js';

const labels = { name: '名称', tagline: '简介', persona: '人设', personality: '性格', world: '世界观',
  style: '说话风格', members: '群成员', topic: '群主题', color: '主题色', avatar: '头像', emoji: '表情',
  greeting: '开场白', model: '模型', voice: '声音', lorebook: '世界书', pinned: '置顶', muted: '免打扰' };
const atPath = (value, path) => path.reduce((node, key) => node?.[key], value);
const show = (value) => value === undefined ? '（空）' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

export async function openSyncConflict() {
  try {
    const conflict = await getSyncConflict();
    const body = el('div', el('p', { text: `「${conflict.name}」在其他页面也有修改。请选择本次修改涉及字段要保留的内容，其他字段会保留电脑文件中的较新版本。` }));
    for (const change of conflict.changes) {
      body.appendChild(el('div',
        el('strong', { text: labels[change.path.at(-1)] || labels[change.path[0]] || '资料内容' }),
        el('p.muted.small', { text: '电脑文件中的内容' }), el('pre', { text: show(atPath(conflict.remote, change.path)), style: { 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' } }),
        el('p.muted.small', { text: '本次修改后的内容' }), el('pre', { text: show(change.value), style: { 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' } })));
    }
    let resolving = false;
    const resolve = async (choice) => {
      if (resolving) return;
      resolving = true;
      try {
        await resolveSyncConflict(conflict.sequence, choice);
        window.location.reload();
      } catch (err) { resolving = false; toast(err.message || '处理失败，请重新查看冲突', 'error', 6000); }
    };
    modal({ title: '处理资料同步冲突', body, width: 640, actions: [
      { text: '稍后处理' },
      { text: '保留电脑版本', keepOpen: true, onClick: () => resolve('remote') },
      { text: '保留本次修改', keepOpen: true, kind: 'primary', onClick: () => resolve('local') },
    ] });
  } catch (err) { toast(err.message || '读取冲突失败', 'error'); }
}

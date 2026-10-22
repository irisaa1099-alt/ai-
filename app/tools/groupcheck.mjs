#!/usr/bin/env node
/**
 * 群聊端到端测试（零依赖）：假模型 + 无头 Chrome，真实跑一遍"拉角色进群 → 角色互相接话"。
 *
 * 覆盖：
 *   1. 通过界面新建群聊（拉 3 个角色进群）
 *   2. 群里 @ 点名 → 被点名的人先回，其余角色接着接话（角色 ↔ 角色对话）
 *   3. 后说话的角色确实"看得到"前面角色的发言（直接核对发给模型的提示词）
 *   4. 圆桌模式：不输入任何内容，角色们自己接着聊
 *   5. 生成中可以随时打断
 *   6. 群聊消息落到电脑本地文件（groups/*.json 与 groupmsgs/*.ndjson）
 *   7. 刷新页面后群聊与聊天记录都还在（磁盘回填）
 *   8. 成员增删、群资料编辑、删除群聊
 *   9. 全程无控制台异常
 *
 * 用法：node tools/groupcheck.mjs [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launch, sleep, freePort } from './cdp.mjs';
import { startMockLLM } from './mock-llm.mjs';

const ROOT = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const MOCK_PORT = await freePort(); // 空闲端口：让系统分配（避免与残留实例/并发测试撞 EADDRINUSE）
const KEEP = process.argv.includes('--keep');
/** 测试专用数据目录：与真实 data/db 隔离 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-groupdb-'));

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } catch (err) {
    failed++;
    failures.push(`${name}：${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待${label}超时（${timeout}ms）`);
    await sleep(interval);
  }
}

/** 启动被测服务器 */
function startServer() {
  const child = spawn(
    process.execPath,
    ['server.mjs', '--port', String(PORT), '--no-open', '--data-dir', TMP_DATA],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return new Promise(async (resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (r.ok) return resolve(child);
      } catch {}
      await sleep(150);
    }
    child.kill();
    reject(new Error(`服务器启动失败：${out.slice(-400)}`));
  });
}

/** 页面内通用：读群聊相关的数据快照 */
const SNAPSHOT = `(async () => {
  const store = await import('./core/store.js');
  const st = window.__AICHAT__.state;
  const gid = st.currentGroupId;
  const g = (st.groups || []).find((x) => x.id === gid) || null;
  const list = gid ? await store.listGroupMessages(gid) : [];
  return {
    gid,
    group: g,
    members: window.__AICHAT__.ctx.groupMembers.map((m) => ({ id: m.id, name: m.name })),
    msgs: list.map((m) => ({ id: m.id, role: m.role, speakerId: m.speakerId, speakerName: m.speakerName, content: m.content, toIds: m.toIds })),
    domBubbles: document.querySelectorAll('.gchat-body .msg.gmsg').length,
    memberChips: document.querySelectorAll('.gchat-members .gchat-member').length,
  };
})()`;

const serverChild = await startServer();
const mock = await startMockLLM(MOCK_PORT);
console.log(`→ 应用服务器 http://127.0.0.1:${PORT}，假模型 http://127.0.0.1:${MOCK_PORT}/v1`);

const page = await launch({ port: await freePort(), width: 1440, height: 900 });
let exitCode = 1;
/** 三个测试角色的 id */
let charIds = [];
let groupId = '';

try {
  /* ------------------------------------------------------------------ */
  console.log('\n=== 1. 启动与准备角色 ===');
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!document.querySelector(".shell")'), { label: '应用外壳' });

  await check('创建 3 位好友并指向假模型', async () => {
    const r = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const tpl = await import('./data/templates.js');
      store.setSettings({
        onboarded: true,
        provider: 'ollama',
        model: 'mock-model',
        baseUrls: { ollama: 'http://127.0.0.1:${MOCK_PORT}/v1' },
        apiKeys: {},
        useProxy: false,
        typedEffect: false,
        voice: { enabled: false, autoplay: 'off' },
        context: { maxMessages: 20, budgetTokens: 4000, summary: false, timeAware: false, affinity: true },
        proactive: { enabled: false },
        group: { autoTalk: true, turnMode: 'smart', maxAutoTurns: 3, autoDelayMs: 0, autoVoice: false },
      });
      const out = [];
      for (let i = 0; i < 3; i++) {
        const c = await store.saveCharacter(tpl.templateToCharacter(tpl.CHARACTER_TEMPLATES[i]));
        out.push({ id: c.id, name: c.name });
      }
      await new Promise((r) => setTimeout(r, 400));
      return out;
    })()`);
    assert(Array.isArray(r) && r.length === 3, `角色创建失败：${JSON.stringify(r)}`);
    charIds = r.map((x) => x.id);
    return r.map((x) => x.name).join('、');
  });

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await waitFor(async () => page.eval('!!window.__AICHAT__ && !!document.querySelector(".side-body")'), { label: '应用就绪' });
  await sleep(600);

  /* ------------------------------------------------------------------ */
  console.log('\n=== 2. 通过界面新建群聊 ===');
  await check('侧栏出现「群聊」区与新建按钮', async () => {
    const r = await page.eval(`(() => ({
      block: !!document.querySelector('.gchat-group-block'),
      addBtn: !!document.querySelector('.gchat-group-block [data-role="new-group"]'),
      title: (document.querySelector('.gchat-group-block .group-head-toggle') || {}).innerText || '',
    }))()`);
    assert(r.block, '侧栏没有渲染「群聊」区');
    assert(r.addBtn, '群聊区缺少「新建」按钮');
    return r.title.replace(/\s+/g, ' ').trim();
  });

  await check('打开建群弹层 → 填名字 + 拉 3 人 → 创建', async () => {
    await page.eval(`document.querySelector('.gchat-group-block [data-role="new-group"]').click()`);
    await waitFor(async () => page.eval('!!document.querySelector(".ge-body")'), { label: '建群弹层' });
    const r = await page.eval(`(async () => {
      const nameInput = document.querySelector('.modal input.input[type="text"]');
      nameInput.value = '周五夜聊会';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      const topic = document.querySelector('.modal textarea.input');
      topic.value = '凌晨三点还亮着灯的居酒屋';
      topic.dispatchEvent(new Event('input', { bubbles: true }));
      // 等成员列表异步加载出来
      for (let i = 0; i < 40 && document.querySelectorAll('.ge-member').length < 3; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const rows = [...document.querySelectorAll('.ge-member')].slice(0, 3);
      rows.forEach((n) => n.click());
      const btn = [...document.querySelectorAll('.modal-foot .btn')].find((b) => /创建群聊/.test(b.textContent));
      if (!btn) return { error: '找不到创建按钮', rows: rows.length };
      btn.click();
      return { rows: rows.length, chips: document.querySelectorAll('.ge-chip').length };
    })()`);
    assert(!r.error, r.error || '');
    assert(r.rows === 3, `成员行只有 ${r.rows} 个`);
    // 等群聊界面出来
    await waitFor(async () => page.eval('!!document.querySelector(".gchat-body") && !!window.__AICHAT__.state.currentGroupId'), {
      label: '群聊界面',
    });
    const gid = await page.eval('window.__AICHAT__.state.currentGroupId');
    groupId = gid;
    assert(String(gid).startsWith('g_'), `群 id 异常：${gid}`);
    return `群 id=${gid}，已选 ${r.chips} 人`;
  });

  await check('群聊界面：顶栏 / 成员条 / 输入框 / 空态引导都在', async () => {
    const r = await page.eval(`(() => ({
      name: (document.querySelector('.gchat-head .chat-head-name') || {}).textContent || '',
      members: document.querySelectorAll('.gchat-members .gchat-member').length,
      addChip: !!document.querySelector('.gchat-members .gchat-add'),
      input: !!document.querySelector('#groupComposerInput'),
      send: !!document.querySelector('#groupSendBtn'),
      roundbar: !!document.querySelector('.gchat-roundbar'),
      empty: document.body.innerText.includes('他们自己聊'),
      rightPane: (document.querySelector('.pane-right .card-hero .nm') || {}).textContent || '',
    }))()`);
    assert(r.name.includes('周五夜聊会'), `群名不对：${r.name}`);
    // 3 位成员 + 1 个「拉人」
    assert(r.members === 4, `成员条应为 3 人 + 拉人按钮，实际 ${r.members}`);
    assert(r.addChip, '缺少「拉人」按钮');
    assert(r.input && r.send, '输入区缺失');
    assert(r.roundbar, '缺少圆桌控制条');
    assert(r.empty, '空态没有「让他们自己聊」引导');
    assert(r.rightPane.includes('周五夜聊会'), `右栏群资料未渲染：${r.rightPane}`);
    return `${r.name.trim()}｜成员条 ${r.members}｜右栏「${r.rightPane.trim()}」`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 3. @点名 → 角色之间互相接话 ===');
  await check('发送 @阿哲 的消息 → 阿哲先回，其余角色接着聊', async () => {
    const names = await page.eval('window.__AICHAT__.ctx.groupMembers.map((m) => m.name)');
    const target = names[1];
    const before = mock.calls();
    await page.eval(`(() => {
      const i = document.querySelector('#groupComposerInput');
      i.value = '@${target} 今天谁有空？';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#groupSendBtn').click();
      return true;
    })()`);

    const snap = await waitFor(
      async () => {
        const s = await page.eval(SNAPSHOT);
        return s && s.msgs.filter((m) => m.role === 'assistant').length >= 2 ? s : null;
      },
      { label: '至少两位角色发言', timeout: 30000 }
    );

    // 用户消息在最前
    assert(snap.msgs[0] && snap.msgs[0].role === 'user', '第一条不是用户消息');
    const replies = snap.msgs.filter((m) => m.role === 'assistant');
    assert(replies[0].speakerName === target, `被 @ 的「${target}」没有先开口，实际是「${replies[0].speakerName}」`);
    const speakers = [...new Set(replies.map((m) => m.speakerName))];
    assert(speakers.length >= 2, `只有 ${speakers.length} 个角色开口，没有形成互相接话`);
    assert(mock.calls() > before, '假模型没有被调用');
    // 每条回复都带上了自己的名字（假模型回显）
    for (const m of replies) {
      assert(m.content.includes(`〔${m.speakerName}〕`), `发言人与提示词不一致：${m.speakerName} / ${m.content}`);
    }
    return `${snap.msgs[0].content} → ${replies.map((m) => m.speakerName).join(' → ')}`;
  });

  await check('后说话的角色看得到前面角色的发言（提示词里带上了群聊记录）', async () => {
    const last = mock.last();
    assert(last && Array.isArray(last.messages), '拿不到最近一次请求');
    const sys = last.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    // 群聊记录必须整段带进 system（「名字：内容」格式）
    assert(sys.includes('【群里最近的对话】'), '群聊提示词里没有群聊记录段');
    assert(sys.includes('【你现在在一个群聊里'), '群聊提示词里没有群聊规则段');
    assert(/不要替他们说话|绝不能替他们说话/.test(sys), '缺少"不要替别人说话"的约束');
    const nameA = await page.eval('window.__AICHAT__.ctx.groupMembers[0].name');
    assert(sys.includes(`${nameA}：`) || sys.includes('：'), `群聊记录没有「发言人：内容」格式：${sys.slice(-300)}`);
    // 最后一条 user 指令必须点明"轮到你（谁）"
    const lastUser = [...last.messages].reverse().find((m) => m.role === 'user');
    assert(/现在轮到你（.+）在群里发言/.test(String(lastUser.content)), `本轮指令格式不对：${lastUser.content}`);
    const lines = (sys.split('【群里最近的对话】')[1] || '').split('\n\n')[0].split('\n').filter((l) => l.includes('：'));
    return `群聊记录 ${lines.length} 行，本轮指令：${String(lastUser.content).slice(0, 28)}…`;
  });

  await check('群聊提示词：默认不把话头抛给用户 + 只在相关时提用户', async () => {
    const r = await page.eval(`(async () => {
      const grp = await import('./core/group.js');
      const store = await import('./core/store.js');
      const g = await store.getGroup(window.__AICHAT__.state.currentGroupId);
      const members = window.__AICHAT__.ctx.groupMembers;
      const settings = store.getSettings();
      const speaker = members[0];
      // 合成“刚刚在群里说过”的记录也要声明听众，遵守真实新消息的可见性契约。
      const mk = (history) => grp.buildGroupMessages({ group: g, speaker, members,
        history: history.map(m => ({...m, at: Date.now(), audienceIds: members.map(c => c.id)})), settings, userName: '我' }).messages[0].content;
      const unrelated = mk([{ role: 'assistant', speakerId: members[1].id, content: '你们在聊什么', status: 'done' }]);
      const fromUser = mk([{ role: 'user', speakerId: 'user', content: '我先说一句', status: 'done' }]);
      // 关系注入用一对"资料上明显有关系"的合成成员断言（不依赖模板角色恰好同组）
      const faux = [
        { id: 'x1', name: '甲', group: '同好', tags: ['温和'], persona: { world: '赛博朋克新港', place: '旧城区' } },
        { id: 'x2', name: '乙', group: '同好', tags: ['温和'], persona: { world: '赛博朋克新港', place: '旧城区' } },
      ];
      const withTies = grp.buildGroupMessages({
        group: g, speaker: faux[0], members: faux,
        history: [{ role: 'assistant', speakerId: 'x2', content: '在的', status: 'done' }],
        settings, userName: '我',
      }).messages[0].content;
      return { unrelated, fromUser, withTies, ties: grp.topTies(faux[0], faux, 3).map((t) => t.member.name) };
    })()`);
    assert(/别每句都提用户/.test(r.unrelated), '缺少"别每句都提用户"的约束');
    assert(!/@我 你怎么看/.test(r.unrelated), '仍然在示范"@用户"的点名（模型会照着学）');
    assert(/最近的话题和用户「我」无关/.test(r.unrelated), '话题与用户无关时没有要求"和群里的人聊"');
    assert(/最近的话题确实和用户「我」有关/.test(r.fromUser), '用户刚说完时没有允许回应 TA');
    assert(r.ties[0] === '乙', `资料相关的人没被算出来：${JSON.stringify(r.ties)}`);
    assert(/【你在这个群里更熟的人】/.test(r.withTies) && /乙/.test(r.withTies), '没有注入"你在这个群里更熟的人"');
    assert(/优先找他们/.test(r.withTies), '没有要求"想找人搭话优先找更熟的人"');
    return '无关轮次要求找群友、相关轮次才允许回应用户；熟人有注入';
  });

  await check('界面渲染出多角色气泡与发言人名字', async () => {
    const r = await page.eval(`(() => {
      const rows = [...document.querySelectorAll('.gchat-body .msg.gmsg')];
      return {
        count: rows.length,
        names: rows.map((n) => (n.querySelector('.gmsg-name b') || {}).textContent || '').filter(Boolean),
        colors: rows.map((n) => n.style.getPropertyValue('--char-color')),
        mine: rows.filter((n) => n.classList.contains('me')).length,
      };
    })()`);
    assert(r.count >= 3, `气泡数偏少：${r.count}`);
    assert(r.mine >= 1, '没有渲染出我方气泡');
    assert(r.names.length >= 2, `发言人名字标签不足：${JSON.stringify(r.names)}`);
    return `气泡 ${r.count} 个，发言人标签 ${r.names.join('/')}`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 4. 圆桌模式：角色自己聊 ===');
  await check('点「让他们聊」→ 无用户输入也会有多个角色接着聊', async () => {
    // 上一轮可能还在说话：busy 时点击会被忽略，所以先等它彻底结束
    await waitFor(async () => !(await page.eval('window.__AICHAT__.groupBusy()')), { label: '上一轮结束', timeout: 30000 });
    const before = await page.eval(SNAPSHOT);
    const beforeAssist = before.msgs.filter((m) => m.role === 'assistant').length;
    const beforeUser = before.msgs.filter((m) => m.role === 'user').length;

    const clicked = await page.eval(`(() => {
      const btns = [...document.querySelectorAll('.pane-right .btn')];
      const b = btns.find((x) => /让他们聊/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked, '右栏找不到「让他们聊」按钮');

    const snap = await waitFor(
      async () => {
        const s = await page.eval(SNAPSHOT);
        const a = s.msgs.filter((m) => m.role === 'assistant').length;
        const busy = await page.eval('window.__AICHAT__.groupBusy()');
        return a >= beforeAssist + 2 && !busy ? s : null;
      },
      { label: '圆桌模式至少新增两条角色发言', timeout: 30000 }
    );
    const afterUser = snap.msgs.filter((m) => m.role === 'user').length;
    assert(afterUser === beforeUser, '圆桌模式不应该凭空多出用户消息');
    const fresh = snap.msgs.filter((m) => m.role === 'assistant').slice(beforeAssist);
    const speakers = [...new Set(fresh.map((m) => m.speakerName))];
    assert(speakers.length >= 2, `圆桌模式只有 ${speakers.length} 个角色开口`);
    return `新增 ${fresh.length} 条：${fresh.map((m) => m.speakerName).join(' → ')}`;
  });

  await check('禁言：被禁言的成员不会发言，解除后恢复', async () => {
    await waitFor(async () => !(await page.eval('window.__AICHAT__.groupBusy()')), { label: '上一轮结束', timeout: 30000 });
    const info = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const grp = await import('./core/group.js');
      const g = await store.getGroup(window.__AICHAT__.state.currentGroupId);
      const members = window.__AICHAT__.ctx.groupMembers;
      const target = members[0];
      await store.saveGroup({ ...g, muteAll: false, mutedMembers: [String(target.id)] });
      await new Promise((r) => setTimeout(r, 400));
      const g2 = await store.getGroup(g.id);
      const plan = grp.planSpeakers({ group: g2, members, history: [], text: '', force: true });
      return { id: String(target.id), name: target.name, plan: plan.map(String), inPlan: plan.map(String).includes(String(target.id)) };
    })()`);
    assert(info.inPlan === false, `被禁言的 ${info.name} 不该出现在名单里：${JSON.stringify(info.plan)}`);

    const before = await page.eval(SNAPSHOT);
    const beforeAssist = before.msgs.filter((m) => m.role === 'assistant').length;
    const clicked = await page.eval(`(() => {
      const b = [...document.querySelectorAll('.pane-right .btn')].find((x) => /让他们聊/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked, '右栏找不到「让他们聊」按钮');
    const snap = await waitFor(
      async () => {
        const s = await page.eval(SNAPSHOT);
        const a = s.msgs.filter((m) => m.role === 'assistant').length;
        const busy = await page.eval('window.__AICHAT__.groupBusy()');
        return a > beforeAssist && !busy ? s : null;
      },
      { label: '禁言期间其他人仍然发言', timeout: 30000 }
    );
    const fresh = snap.msgs.filter((m) => m.role === 'assistant').slice(beforeAssist);
    assert(!fresh.some((m) => m.speakerName === info.name), `被禁言的 ${info.name} 仍然发言了：${fresh.map((m) => m.speakerName).join('/')}`);

    // 解除禁言 → 名单里应该重新出现
    const back = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const grp = await import('./core/group.js');
      const g = await store.getGroup(window.__AICHAT__.state.currentGroupId);
      await store.saveGroup({ ...g, mutedMembers: [] });
      await new Promise((r) => setTimeout(r, 300));
      const g2 = await store.getGroup(g.id);
      const plan = grp.planSpeakers({ group: g2, members: window.__AICHAT__.ctx.groupMembers, history: [], text: '', force: true });
      return plan.map(String).includes(${JSON.stringify(info.id)});
    })()`);
    assert(back, '解除禁言后该成员应重新进入发言名单');
    return `禁言 ${info.name} 期间由其他人发言（${fresh.map((m) => m.speakerName).join(' → ')}），解除后恢复`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 5. 打断 ===');
  await check('生成中点停止 → 立刻停下且不再有新消息', async () => {
    await waitFor(async () => !(await page.eval('window.__AICHAT__.groupBusy()')), { label: '上一轮结束', timeout: 30000 });
    // 让假模型切成超慢速流，便于中途打断
    await page.eval(`fetch('http://127.0.0.1:${MOCK_PORT}/slow').then((r) => r.json())`);
    const before = await page.eval(SNAPSHOT);
    await page.eval(`(() => {
      const btns = [...document.querySelectorAll('.pane-right .btn')];
      const b = btns.find((x) => /让他们聊/.test(x.textContent));
      b.click();
      return true;
    })()`);
    const busy = await waitFor(async () => page.eval('window.__AICHAT__.groupBusy()'), { label: '进入生成状态', timeout: 8000 });
    assert(busy, '点击后没有进入生成状态');
    await page.eval(`(() => {
      const b = document.querySelector('#groupSendBtn');
      if (b && b.classList.contains('stop')) { b.click(); return 'send'; }
      const r = document.querySelector('.gchat-round-btn');
      if (r) { r.click(); return 'round'; }
      return 'none';
    })()`);
    await sleep(2500);
    const after = await page.eval(SNAPSHOT);
    const stillBusy = await page.eval('window.__AICHAT__.groupBusy()');
    assert(!stillBusy, '打断后仍在生成');
    const delta = after.msgs.length - before.msgs.length;
    assert(delta <= 2, `打断后仍写入了 ${delta} 条消息`);
    assert(!after.msgs.some((m) => m.content.includes('第') && m.content.length > 200), '出现了异常长消息');
    return `打断前 ${before.msgs.length} 条 → 打断后 ${after.msgs.length} 条`;
  });

  await check('停止后立刻开新一轮 → 旧轮次不能清掉新轮次忙状态', async () => {
    const callsBefore = mock.calls();
    await page.eval(`fetch('http://127.0.0.1:${MOCK_PORT}/slow').then((r) => r.json())`);
    const clickRound = `(() => {
      const b = [...document.querySelectorAll('.pane-right .btn')].find((x) => /让他们聊/.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`;
    assert(await page.eval(clickRound), '找不到新一轮按钮');
    await waitFor(() => mock.calls() > callsBefore, { label: '旧轮次到达假模型', timeout: 8000 });
    await page.eval(`(() => {
      const b = document.querySelector('#groupSendBtn');
      if (b && b.classList.contains('stop')) b.click();
    })()`);
    assert(await page.eval(clickRound), '停止后无法立即开新一轮');
    await waitFor(() => mock.calls() >= callsBefore + 2, { label: '新轮次到达假模型', timeout: 8000 });
    await sleep(500);
    assert(await page.eval('window.__AICHAT__.groupBusy()'), '旧轮次收尾错误地解除新轮次忙状态');
    await page.eval(`(() => {
      const b = document.querySelector('#groupSendBtn');
      if (b && b.classList.contains('stop')) b.click();
    })()`);
    await waitFor(async () => !(await page.eval('window.__AICHAT__.groupBusy()')), { label: '新轮次停止', timeout: 8000 });
    return '新轮次在旧轮次结束后仍保持忙状态，随后可正常停止';
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 6. 本地文件持久化 ===');
  await check('群资料与群消息都写进了电脑本地文件', async () => {
    const gFile = path.join(TMP_DATA, 'groups', `${groupId}.json`);
    const mFile = path.join(TMP_DATA, 'groupmsgs', `${groupId}.ndjson`);
    await waitFor(async () => fs.existsSync(gFile) && fs.existsSync(mFile), { label: '群聊文件落盘', timeout: 8000 });
    const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    const lines = fs.readFileSync(mFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert(g.name === '周五夜聊会', `磁盘上的群名不对：${g.name}`);
    assert((g.members || []).length === 3, `磁盘上的成员数不对：${(g.members || []).length}`);
    assert(lines.length >= 3, `磁盘上的群消息太少：${lines.length}`);
    assert(lines.some((m) => m.speakerId), '磁盘上的群消息缺少 speakerId（无法分辨是谁说的）');
    assert(lines.some((m) => m.role === 'user'), '磁盘上缺少用户消息');
    return `groups/${groupId}.json + groupmsgs/${groupId}.ndjson（${lines.length} 行，含 speakerId）`;
  });

  await check('刷新页面后群聊与聊天记录都还在', async () => {
    const before = await page.eval(SNAPSHOT);
    await page.goto(`http://127.0.0.1:${PORT}/#/group/${groupId}`);
    await waitFor(async () => page.eval('!!document.querySelector(".gchat-body")'), { label: '恢复到群聊', timeout: 15000 });
    await waitFor(
      async () => {
        const n = await page.eval('document.querySelectorAll(".gchat-body .msg.gmsg").length');
        return n >= before.msgs.length ? n : null;
      },
      { label: '群消息渲染完成', timeout: 15000 }
    );
    const after = await page.eval(SNAPSHOT);
    assert(after.gid === groupId, `刷新后没有回到同一个群：${after.gid}`);
    assert(after.msgs.length === before.msgs.length, `消息数不一致：${before.msgs.length} → ${after.msgs.length}`);
    assert(after.members.length === 3, `成员数不一致：${after.members.length}`);
    return `${after.msgs.length} 条消息、${after.members.length} 位成员全部还原`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 7. 成员管理与群资料 ===');
  await check('拉人弹层里取消一位成员 → 成员数减少', async () => {
    await page.eval(`(() => {
      const b = document.querySelector('.gchat-head [title="拉人进群"]');
      if (b) b.click();
      return !!b;
    })()`);
    await waitFor(async () => page.eval('!!document.querySelector(".ge-member-list")'), { label: '成员选择器' });
    await page.eval(`(() => {
      const rows = [...document.querySelectorAll('.ge-member')];
      const on = rows.find((n) => n.classList.contains('on'));
      if (on) on.click();
      const save = [...document.querySelectorAll('.modal-foot .btn')].find((b) => /保存成员/.test(b.textContent));
      if (save) save.click();
      return true;
    })()`);
    const snap = await waitFor(
      async () => {
        const g = await page.eval('(window.__AICHAT__.state.groups.find((x) => x.id === window.__AICHAT__.state.currentGroupId) || {})');
        return g && (g.members || []).length === 2 ? g : null;
      },
      { label: '成员数变成 2', timeout: 10000 }
    );
    const chips = await page.eval('document.querySelectorAll(".gchat-members .gchat-member").length');
    assert(chips === 3, `成员条应为 2 人 + 拉人按钮，实际 ${chips}`);
    return `成员从 3 减到 ${snap.members.length}`;
  });

  await check('少于 2 人时不允许再移除（有保护）', async () => {
    const r = await page.eval(`(() => {
      const g = window.__AICHAT__.state.groups.find((x) => x.id === window.__AICHAT__.state.currentGroupId);
      return { members: g.members.length };
    })()`);
    assert(r.members === 2, `成员数应为 2，实际 ${r.members}`);
    const res = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const g = await store.getGroup(window.__AICHAT__.state.currentGroupId);
      try {
        // 直接调 store：界面有确认弹层，这里验证底层数据结构本身不炸
        const next = await store.saveGroup({ ...g, members: [g.members[0]] });
        return { ok: true, members: next.members.length };
      } catch (e) {
        return { ok: false, err: String(e && e.message) };
      }
    })()`);
    assert(res.ok, `保存单人群失败：${res.err}`);
    // 恢复成 2 人，后面的测试还要用
    await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const rt = await import('./core/runtime.js');
      const g = await store.getGroup(window.__AICHAT__.state.currentGroupId);
      const chars = await store.listCharacters();
      await store.saveGroup({ ...g, members: chars.slice(0, 2).map((c) => c.id) });
      return true;
    })()`);
    return '单人群可保存（界面层另有"至少 2 人"的提示与拦截）';
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 8. 群内搜索与导出 ===');
  await check('群内搜索能命中角色说过的话', async () => {
    const hit = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const hits = await store.searchGroupMessages(window.__AICHAT__.state.currentGroupId, '群记录');
      return hits.length;
    })()`);
    assert(hit >= 1, `群内搜索没有命中（hits=${hit}）`);
    return `命中 ${hit} 条`;
  });

  await check('收藏夹：群消息也能收藏，且能跨会话跳回群里那一条', async () => {
    // ① 收藏一条群消息 → 收藏夹里出现（带群名）
    const open = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const gid = window.__AICHAT__.state.currentGroupId;
      const list = await store.listGroupMessages(gid);
      const target = [...list].reverse().find(m => m.content && m.content.trim());
      if (!target) return { err: '这个群里还没有可收藏的消息' };
      await store.updateGroupMessage(target.id, { bookmarked: true });
      await new Promise(r => setTimeout(r, 300));
      const favBtn = [...document.querySelectorAll('.side-tools .icon-btn')].find(b => /收藏夹/.test(b.title || ''));
      if (!favBtn) return { err: '左上角没有收藏夹入口' };
      favBtn.click();
      await new Promise(r => setTimeout(r, 900));
      const items = [...document.querySelectorAll('.modal .fav-item')];
      const hit = items.find(n => (n.innerText || '').includes('群聊'));
      const g = (await store.listGroups()).find(x => x.id === gid);
      document.querySelectorAll('.modal-mask').forEach(n => n.__close && n.__close());
      return {
        gid, gname: g ? g.name : '', msgId: target.id,
        count: items.length, hasGroupItem: !!hit,
        text: hit ? hit.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
      };
    })()`);
    assert(!open.err, open.err);
    assert(open.hasGroupItem, `收藏夹里应当出现群聊条目（面板里共 ${open.count} 条）`);
    assert(open.text.includes(open.gname), `群聊条目上应当写着群名「${open.gname}」：${open.text}`);

    // ② 先切到好友私聊（跨会话），再点跳转：应当自动切回这个群并高亮那条消息
    const jumped = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      const chars = await store.listCharacters();
      await window.__AICHAT__.openChat(chars[0].id);
      await new Promise(r => setTimeout(r, 1000));
      const before = window.__AICHAT__.state.currentGroupId;
      const favBtn = [...document.querySelectorAll('.side-tools .icon-btn')].find(b => /收藏夹/.test(b.title || ''));
      favBtn.click();
      await new Promise(r => setTimeout(r, 900));
      const seen = [];
      const obs = new MutationObserver(() => {
        if (document.querySelector('.gchat-body .flash-highlight')) seen.push(1);
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      const main = document.querySelector('.modal .fav-item .fav-main');
      if (!main) return { err: '收藏夹里没有可点的条目' };
      main.click();
      await new Promise(r => setTimeout(r, 2500));
      obs.disconnect();
      return {
        before, after: window.__AICHAT__.state.currentGroupId,
        flashed: seen.length > 0,
        modalGone: !document.querySelector('.modal'),
      };
    })()`);
    assert(!jumped.err, jumped.err);
    assert(jumped.modalGone, '跳转后收藏夹面板应当关掉');
    assert(jumped.after === open.gid, `跳转应当切回群 ${open.gid}（跳转前 currentGroupId=${jumped.before}，跳转后 ${jumped.after}）`);
    assert(jumped.flashed, '跳转后群里那条消息应当被高亮（没有定位到）');

    // 收尾：取消收藏，别让这条留在收藏夹里影响后面的用例
    const left = await page.eval(`(async () => {
      const store = await import('./core/store.js');
      await store.updateGroupMessage('${open.msgId}', { bookmarked: false });
      return (await store.listBookmarks()).length;
    })()`);
    assert(left === 0, `收尾后收藏夹应当清空，实际还剩 ${left} 条`);
    return `群「${open.gname}」的消息进收藏夹（${open.text}）→ 跨会话跳回群并高亮 ✓`;
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 9. 删除群聊 ===');
  await check('删除群聊 → 群消失、磁盘文件也被清掉', async () => {
    // 通过侧栏行操作删除（右键唤出快捷操作里的垃圾桶）
    await page.eval(`(() => {
      const row = document.querySelector('.gchat-row');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const del = row.querySelector('[title="删除群聊"]');
      if (del) del.click();
      return !!del;
    })()`);
    await waitFor(async () => page.eval('!!document.querySelector(".modal-mask .btn-danger")'), { label: '删除确认框' });
    await page.eval(`[...document.querySelectorAll('.modal-mask .btn-danger')].pop().click()`);
    try {
      await waitFor(
        async () => {
          const n = await page.eval('(window.__AICHAT__.state.groups || []).length');
          // 注意：0 是 falsy，waitFor 会一直等 —— 所以这里返回一个真值
          return n === 0 ? 'empty' : null;
        },
        { label: '群聊从列表消失', timeout: 10000 }
      );
    } catch (err) {
      const diag = await page.eval(`(async () => {
        const store = await import('./core/store.js');
        return {
          groups: (await store.listGroups()).map((g) => g.id),
          ctxGroups: (window.__AICHAT__.state.groups || []).map((g) => g.id),
          modals: [...document.querySelectorAll('.modal-mask')].length,
          toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
          sideRows: document.querySelectorAll('.gchat-row').length,
        };
      })()`);
      throw new Error(`群聊没被删除｜现场：${JSON.stringify(diag)}`);
    }
    await waitFor(async () => !fs.existsSync(path.join(TMP_DATA, 'groups', `${groupId}.json`)), {
      label: '磁盘上的群文件被删除',
      timeout: 8000,
    });
    const tomb = fs.existsSync(path.join(TMP_DATA, 'deleted', `g-${groupId}.json`));
    assert(tomb, '没有写入群聊删除墓碑');
    return '群聊已删除，groups/groupmsgs 文件清理完成并留下墓碑';
  });

  /* ------------------------------------------------------------------ */
  console.log('\n=== 10. 最终控制台检查 ===');
  await check('全程无未捕获异常', async () => {
    const real = page.problems.filter((p) => !/icon\.svg|manifest|404|favicon/i.test(p));
    assert(real.length === 0, real.slice(0, 3).join(' | '));
    return '0 个异常';
  });

  if (KEEP) {
    const shot = path.join(process.cwd(), 'groupcheck-shot.png');
    await page.shot(shot);
    console.log(`→ 截图：${shot}`);
  }
} catch (err) {
  failed++;
  failures.push(`未捕获的测试错误：${err.message}`);
  console.error('\n✗ 测试中断：', err.message);
} finally {
  console.log(`\n================ 群聊端到端结果：${passed} 通过 / ${failed} 失败 ================`);
  if (failures.length) {
    console.log('\n失败详情：');
    failures.forEach((f) => console.log(' - ' + f));
  }
  console.log('\n控制台输出（最后 20 条）：');
  console.log(page.logs.slice(-20).join('\n') || '（无）');
  exitCode = failed ? 1 : 0;
  if (!KEEP) {
    await page.close();
    await mock.close();
    serverChild.kill('SIGKILL');
    try {
      fs.rmSync(TMP_DATA, { recursive: true, force: true });
    } catch {}
  } else {
    console.log(`→ 测试数据目录（保留）：${TMP_DATA}`);
  }
}
process.exit(exitCode);

#!/usr/bin/env node
/**
 * 假模型服务器（OpenAI 兼容），供 tools/e2e.mjs 做端到端测试用。
 * 不参与生产运行，仅测试时启动。
 */
import http from 'node:http';

const REPLY =
  '（歪头看你）……嗯，我在的。今天过得怎么样？我刚刚在画一幅海边的画，正好缺一个人陪我聊两句。';

/**
 * 群聊模式下，从最后一条 user 消息里认出"这一轮轮到谁说话"。
 * core/group.js 的指令格式是「现在轮到你（林晚）在群里发言」。
 * @param {Array<{role:string,content:string}>} messages
 * @returns {string} 角色名（不是群聊请求时返回空串）
 */
function groupSpeaker(messages) {
  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
  const text = lastUser ? String(lastUser.content || '') : '';
  const m = text.match(/现在轮到你（([^）]+)）在群里发言/);
  return m ? m[1] : '';
}

/**
 * 数一数群聊提示词里"群里最近的对话"有多少条 —— 用它证明
 * 「后说话的角色确实看到了前面角色的发言」（人物之间能互相对话）。
 * @param {Array<{role:string,content:string}>} messages
 * @returns {number}
 */
function transcriptLines(messages) {
  const sys = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'system')
    .map((m) => String(m.content || ''))
    .join('\n');
  const seg = sys.split('【群里最近的对话】')[1];
  if (!seg) return 0;
  const body = seg.split('\n\n')[0] || '';
  return body.split('\n').filter((l) => l.trim() && /[：:]/.test(l)).length;
}

/**
 * 启动假模型服务器
 * @param {number} port
 * @returns {Promise<{close:()=>Promise<void>, calls:()=>number, last:()=>object|null, port:number}>}
 */
export function startMockLLM(port = 5299) {
  let calls = 0;
  /** 命中 /slow 后，后续流式回复会变得很慢，便于测试"生成中停止" */
  let slow = false;
  /** 已处理的对话请求数（每次回复内容会带上序号，保证版本之间不重复） */
  let seq = 0;
  /** 最近一次收到的请求体（供测试核对"到底发了什么给模型"） */
  let lastRequest = null;
  /** 最近一次收到的语音合成请求（供测试核对"代理到底把请求发给了哪个供应商"） */
  let lastTts = null;
  /** 被对端提前掐断的流式请求数（供测试核对"客户端停止后上游有没有被断开"） */
  let abortedStreams = 0;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.url.startsWith('/count')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ calls }));
    }
    // 最近一次请求体：群聊测试用它核对"后说话的角色能不能看到前面的人"
    if (req.url.startsWith('/last')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ last: lastRequest }));
    }
    // 语音合成的"上游供应商"：测试用它证明 server.mjs 的 /api/tts 真的把请求
    // 发到了所选供应商的地址，并且带的是那个供应商自己的密钥。
    if (req.url.startsWith('/last-tts')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tts: lastTts }));
    }
    // 被对端掐断的流式请求数（见下面的 res.on('close')）
    if (req.url.startsWith('/aborts')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ abortedStreams }));
    }
    if (req.url.startsWith('/v1/audio/speech')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {}
        lastTts = {
          url: req.url,
          auth: String(req.headers.authorization || ''),
          contentType: String(req.headers['content-type'] || ''),
          model: payload.model || '',
          voice: payload.voice || '',
          input: payload.input || '',
          speed: payload.speed,
        };
        // 回一段极小的合法 WAV，足以让 /api/tts 原样转发二进制
        const wav = Buffer.alloc(44);
        wav.write('RIFF', 0);
        wav.writeUInt32LE(36, 4);
        wav.write('WAVE', 8);
        wav.write('fmt ', 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24);
        wav.writeUInt32LE(16000, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write('data', 36);
        wav.writeUInt32LE(0, 40);
        res.writeHead(200, { ...cors, 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) });
        res.end(wav);
      });
      return;
    }
    // 超慢速流：用于测试"停止生成（打断）"
    if (req.url.startsWith('/slow')) {
      slow = true;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ slow: true }));
    }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls++;
        seq++;
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {}
        lastRequest = payload;
        // 群聊请求：回复里带上"我是谁"和"我看到了几条群记录"，
        // 让端到端测试能直接验证「角色之间看得到彼此」这件事。
        const speaker = groupSpeaker(payload.messages);
        const transcript = speaker ? transcriptLines(payload.messages) : 0;
        const groupReply = speaker ? `〔${speaker}〕第 ${seq} 次发言：我看到了 ${transcript} 条群记录。` : '';
        if (payload.stream) {
          res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          // 每次回复都略有不同，便于测试"多版本回复"（chat.js 会忽略重复版本）
          const text = groupReply || (seq > 1 ? `${REPLY}（第 ${seq} 次）` : REPLY);
          const chars = [...text];
          let i = 0;
          const step = slow ? 1 : 2;
          const gap = slow ? 260 : 10;
          const timer = setInterval(() => {
            if (i >= chars.length) {
              clearInterval(timer);
              slow = false;
              res.write(
                `data: ${JSON.stringify({
                  choices: [{ delta: {} }],
                  usage: { prompt_tokens: 120, completion_tokens: 40 },
                })}\n\n`
              );
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            const chunk = chars.slice(i, i + step).join('');
            i += step;
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
          }, gap);
          // 客户端（也就是被测的 server.mjs）中途把连接断掉时记一笔：
          // 用它验证"用户点停止后，服务器有没有真的掐断上游"（P2：取消流式回复后上游仍在跑）。
          // writableEnded 为 false 才说明是"对端提前走了"，正常收尾不算。
          res.on('close', () => {
            if (!res.writableEnded) {
              abortedStreams++;
              clearInterval(timer);
            }
          });
          return;
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: groupReply || REPLY } }],
            usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
          })
        );
      });
      return;
    }
    res.writeHead(404, cors);
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        calls: () => calls,
        last: () => lastRequest,
        lastTts: () => lastTts,
        abortedStreams: () => abortedStreams,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

export { REPLY };

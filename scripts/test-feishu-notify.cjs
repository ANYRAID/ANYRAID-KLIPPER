const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.FEISHU_QUEUE_ISSUE = '12';
const { isBusinessTime, encode, decode, enqueue, flush } = require('./feishu-queue.cjs');
const { messageFor, sendMessage } = require('./feishu-notify.cjs');
const repo = 'ANYRAID/ANYRAID-KLIPPER';
const monday = () => new Date('2026-10-26T01:00:00Z');
const saturday = () => new Date('2026-10-24T04:00:00Z');
const event = (number = 20) => ({ action: 'opened', issue: { number, title: '<test>', user: { login: 'user' } } });
const record = (key = 'issue:20', status = 'pending') => ({ key, status, message: messageFor('issues', event(), repo) });

function memoryQueue(initial = []) {
  const comments = initial.map((value, i) => ({ id: i + 1, user: { login: 'github-actions[bot]' }, body: encode(value) }));
  let failSent = false;
  const api = async (route, method = 'GET', body) => {
    if (method === 'GET') return comments;
    if (method === 'POST') {
      const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, ...body };
      comments.push(comment);
      return comment;
    }
    if (method === 'PATCH') {
      if (failSent && body.body.includes('"status": "sent"')) throw new Error('模拟状态写入失败');
      const comment = comments.find(item => item.id === Number(route.split('/').pop()));
      assert.ok(comment);
      Object.assign(comment, body);
      return comment;
    }
    throw new Error('未预期的队列操作');
  };
  return { api, comments, values: () => comments.map(decode), failSent: () => { failSent = true; } };
}

test('香港工作时段边界、周末和跨周补发', () => {
  for (const [date, expected] of [
    ['2026-10-26T00:59:59Z', false], ['2026-10-26T01:00:00Z', true],
    ['2026-10-26T09:59:59Z', true], ['2026-10-26T10:00:00Z', false],
    ['2026-10-23T09:59:59Z', true], ['2026-10-24T04:00:00Z', false],
    ['2026-10-25T04:00:00Z', false],
  ]) assert.equal(isBusinessTime(new Date(date)), expected, date);
});

test('只通知新 Issue 和合入本仓库 main 的 PR，清理标题标记', () => {
  assert.match(messageFor('issues', event(), repo).content.text, /＜test＞/);
  assert.equal(messageFor('issues', { ...event(), action: 'edited' }, repo), null);
  assert.equal(messageFor('issues', { ...event(), issue: { ...event().issue, pull_request: {} } }, repo), null);
  const pr = { action: 'closed', pull_request: { number: 30, merged: true, title: '合并', base: { ref: 'main', repo: { full_name: repo } } } };
  assert.match(messageFor('pull_request_target', pr, repo).content.text, /已合入 main/);
  pr.pull_request.merged = false;
  assert.equal(messageFor('pull_request_target', pr, repo), null);
  pr.pull_request.merged = true;
  pr.pull_request.base.ref = 'develop';
  assert.equal(messageFor('pull_request_target', pr, repo), null);
  pr.pull_request.base.ref = 'main';
  pr.pull_request.base.repo.full_name = 'someone/fork';
  assert.equal(messageFor('pull_request_target', pr, repo), null);
});

test('队列自身不通知，重复事件只入队一次', async () => {
  const q = memoryQueue();
  await enqueue(q.api, 'issues', event(12), repo, '1');
  assert.equal(q.comments.length, 0);
  await enqueue(q.api, 'issues', event(), repo, '1');
  await enqueue(q.api, 'issues', event(), repo, '2');
  assert.equal(q.comments.length, 1);
});

test('非机器人伪造记录被忽略，损坏机器人记录拒绝处理', () => {
  assert.equal(decode({ user: { login: 'user' }, body: encode(record()) }), null);
  assert.throws(() => decode({ user: { login: 'github-actions[bot]' }, body: encode({ ...record(), status: 'bad' }) }));
});

test('周末保留队列，周一发送一次，重复记录和后续补发不重复发送', async () => {
  const q = memoryQueue([record(), record()]);
  let sends = 0;
  const send = async () => { sends++; };
  await flush(q.api, send, saturday);
  assert.equal(sends, 0);
  assert.equal(q.values()[0].status, 'pending');
  await flush(q.api, send, monday);
  await flush(q.api, send, monday);
  assert.equal(sends, 1);
  assert.deepEqual(q.values().map(item => item.status), ['sent', 'duplicate']);
});

test('发送失败或发送后状态写入失败均不盲目重发', async () => {
  for (const writeFailure of [false, true]) {
    const q = memoryQueue([record()]);
    if (writeFailure) q.failSent();
    let sends = 0;
    const send = async () => { sends++; if (!writeFailure) throw new Error('模拟网络超时'); };
    await assert.rejects(flush(q.api, send, monday));
    assert.equal(q.values()[0].status, 'unknown');
    await assert.rejects(flush(q.api, send, monday));
    assert.equal(sends, 1);
  }
});

test('发送进程中断留下 sending 时不重发，但允许处理其他新事件', async () => {
  const q = memoryQueue([record('issue:19', 'sending'), record()]);
  let sends = 0;
  await assert.rejects(flush(q.api, async () => { sends++; }, monday));
  assert.equal(sends, 1);
  assert.deepEqual(q.values().map(item => item.status), ['sending', 'sent']);
});

test('跨过 18:00 时退回 pending，不发送', async () => {
  const q = memoryQueue([record()]);
  let checks = 0;
  let sends = 0;
  const now = () => new Date(++checks < 3 ? '2026-10-26T09:59:59Z' : '2026-10-26T10:00:00Z');
  await flush(q.api, async () => { sends++; }, now);
  assert.equal(sends, 0);
  assert.equal(q.values()[0].status, 'pending');
});

test('Webhook 校验、HTTP/业务错误和异常脱敏；所有请求均为模拟', async () => {
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder';
  const message = record().message;
  let calls = 0;
  const success = async () => { calls++; return { ok: true, json: async () => ({ code: 0 }) }; };
  await assert.rejects(sendMessage('https://example.com/hook', message, success));
  assert.equal(calls, 0);
  await sendMessage(url, message, success);
  assert.equal(calls, 1);
  await assert.rejects(sendMessage(url, message, async () => ({ ok: false, status: 500 })), /HTTP/);
  await assert.rejects(sendMessage(url, message, async () => ({ ok: true, json: async () => ({ code: 19001 }) })), /业务/);
  await assert.rejects(sendMessage(url, message, async () => { throw new Error(url); }), error => !error.message.includes(url));
});

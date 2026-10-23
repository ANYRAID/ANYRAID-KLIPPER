const fs = require('node:fs');
const { messageFor, sendMessage } = require('./feishu-notify.cjs');
const QUEUE_ISSUE = Number(process.env.FEISHU_QUEUE_ISSUE);
const MARKER = '<!-- feishu-queue-v1 -->\n';

function isBusinessTime(date = new Date()) {
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return local.getUTCDay() >= 1 && local.getUTCDay() <= 5 && local.getUTCHours() >= 9 && local.getUTCHours() < 18;
}

function encode(record) { return MARKER + JSON.stringify(record, null, 2); }
function decode(comment) {
  if (comment.user?.login !== 'github-actions[bot]' || !comment.body?.startsWith(MARKER)) return null;
  const record = JSON.parse(comment.body.slice(MARKER.length));
  if (!/^(issue|pr|test):\d+$/.test(record.key) || !['pending', 'sending', 'sent', 'unknown', 'duplicate'].includes(record.status) || record.message?.msg_type !== 'text' || typeof record.message.content?.text !== 'string' || record.message.content.text.length > 5000) {
    throw new Error(`队列记录 ${comment.id} 无效，需人工检查`);
  }
  return { ...record, id: comment.id };
}

function githubClient(repository, token, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('缺少有效仓库或 GitHub Token');
  return async (route, method = 'GET', body) => {
    let response;
    try {
      response = await request(`https://api.github.com/repos/${repository}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('GitHub 队列请求失败；不自动重试写入'); }
    if (!response.ok) throw new Error(`GitHub 队列 API 失败：${response.status}`);
    return response.json();
  };
}

async function records(api) {
  const result = [];
  for (let page = 1; ; page++) {
    const comments = await api(`/issues/${QUEUE_ISSUE}/comments?per_page=100&page=${page}`);
    for (const comment of comments) {
      const record = decode(comment);
      if (record) result.push(record);
    }
    if (comments.length < 100) return result;
  }
}

async function enqueue(api, eventName, event, repository, runId) {
  if (eventName === 'issues' && event.issue?.number === QUEUE_ISSUE) return null;
  const message = messageFor(eventName, event, repository);
  if (!message) return null;
  const key = eventName === 'issues' ? `issue:${event.issue.number}` : eventName === 'pull_request_target' ? `pr:${event.pull_request.number}` : `test:${runId}`;
  if (!/^(issue|pr|test):\d+$/.test(key)) throw new Error('队列事件编号无效');
  if ((await records(api)).some(record => record.key === key)) return key;
  await api(`/issues/${QUEUE_ISSUE}/comments`, 'POST', { body: encode({ key, status: 'pending', queued_at: new Date().toISOString(), message }) });
  console.log(`已持久入队 ${key}；非工作时段不会发送`);
  return key;
}

async function update(api, record, status) {
  const { id, ...data } = record;
  await api(`/issues/comments/${id}`, 'PATCH', { body: encode({ ...data, status, updated_at: new Date().toISOString() }) });
  record.status = status;
}

async function flush(api, send, now = () => new Date()) {
  if (!isBusinessTime(now())) { console.log('香港时间非周一至周五 09:00–18:00，消息保留至下一工作时段'); return; }
  const queue = await records(api);
  // 先以已尝试的记录去重，防止入队请求并发时重复发送。
  const attempted = new Set(queue.filter(item => ['sending', 'sent', 'unknown'].includes(item.status)).map(item => item.key));
  let count = 0;
  let uncertain = queue.some(item => ['sending', 'unknown'].includes(item.status));
  for (const record of queue) {
    if (record.status !== 'pending') continue;
    if (attempted.has(record.key)) { await update(api, record, 'duplicate'); continue; }
    if (count >= 50 || !isBusinessTime(now())) break;
    await update(api, record, 'sending');
    // API 调用期间可能跨过 18:00；发送前再次检查。
    if (!isBusinessTime(now())) { await update(api, record, 'pending'); break; }
    attempted.add(record.key);
    try {
      await send(record.message);
      await update(api, record, 'sent');
      console.log(`飞书已接受 ${record.key}（业务 code=0）；群内显示由接收端确认`);
    } catch {
      // 飞书成功但状态写入失败也按未知处理，绝不盲目重发。
      await update(api, record, 'unknown');
      uncertain = true;
      console.error(`通知 ${record.key} 结果未知或失败，请核对后人工处理`);
    }
    count++;
  }
  if (uncertain) throw new Error('存在 sending/unknown 队列记录，已保留且不会自动重发');
}

async function main() {
  if (!Number.isSafeInteger(QUEUE_ISSUE) || QUEUE_ISSUE <= 0) throw new Error('缺少有效的 FEISHU_QUEUE_ISSUE 仓库变量');
  const repository = process.env.GITHUB_REPOSITORY;
  const api = githubClient(repository, process.env.GITHUB_TOKEN);
  const mode = process.argv[2];
  if (mode === 'enqueue') {
    let eventName = process.env.GITHUB_EVENT_NAME;
    let event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (eventName === 'workflow_dispatch') {
      const action = event.inputs?.action || 'flush';
      if (action === 'flush') return;
      if (action !== 'test') {
        const number = Number(event.inputs?.number);
        if (!['issue', 'pr'].includes(action) || !Number.isSafeInteger(number) || number <= 0) throw new Error('补录参数无效');
        if (action === 'issue') {
          eventName = 'issues'; event = { action: 'opened', issue: await api(`/issues/${number}`) };
        } else {
          eventName = 'pull_request_target'; event = { action: 'closed', pull_request: await api(`/pulls/${number}`) };
        }
      }
    }
    await enqueue(api, eventName, event, repository, process.env.GITHUB_RUN_ID);
  } else if (mode === 'flush') {
    await flush(api, message => sendMessage(process.env.FEISHU_WEBHOOK_URL?.trim(), message));
  } else throw new Error('必须指定 enqueue 或 flush');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { isBusinessTime, encode, decode, records, enqueue, flush };

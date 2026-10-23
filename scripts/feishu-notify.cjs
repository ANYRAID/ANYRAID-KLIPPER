function messageFor(eventName, event, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('仓库名称无效');
  const clean = value => String(value || '').replace(/[<>]/g, c => c === '<' ? '＜' : '＞').slice(0, 1000);
  let text;
  if (eventName === 'issues' && event.action === 'opened' && !event.issue?.pull_request) {
    const issue = event.issue;
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0) throw new Error('Issue 编号无效');
    text = `【${repository}】新建 Issue #${issue.number}\n${clean(issue.title)}\n创建者：${clean(issue.user?.login)}\nhttps://github.com/${repository}/issues/${issue.number}`;
  } else if (eventName === 'pull_request_target' && event.action === 'closed' && event.pull_request?.merged === true && event.pull_request.base?.ref === 'main' && event.pull_request.base?.repo?.full_name === repository) {
    const pr = event.pull_request;
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error('PR 编号无效');
    text = `【${repository}】PR #${pr.number} 已合入 main\n${clean(pr.title)}\n合并者：${clean(pr.merged_by?.login)}\nhttps://github.com/${repository}/pull/${pr.number}`;
  } else if (eventName === 'workflow_dispatch') {
    text = `【${repository}】飞书通知链路测试\n通知范围：Issue 新建、PR 成功合入 main。此消息为测试，不代表发生了新的 Issue 或 PR 合并。`;
  } else {
    return null;
  }
  return { msg_type: 'text', content: { text } };
}

async function sendMessage(url, message, request = fetch) {
  let target;
  try { target = new URL(url); } catch { throw new Error('未配置有效的飞书 Webhook Secret'); }
  if (target.protocol !== 'https:' || target.hostname !== 'open.feishu.cn' || !target.pathname.startsWith('/open-apis/bot/v2/hook/') || target.username || target.password || target.port || target.search || target.hash) {
    throw new Error('飞书 Webhook 地址类型不正确');
  }
  let response;
  try {
    response = await request(target, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(message),
    });
  } catch {
    // 不输出异常对象，避免请求错误携带完整机器人地址。
    throw new Error('飞书请求失败或超时；发送结果未知，人工确认后再重跑');
  }
  if (!response.ok) throw new Error(`飞书 HTTP 请求失败：${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error('飞书返回了无效 JSON'); }
  if (result.code !== 0) throw new Error(`飞书业务返回失败：${Number.isInteger(result.code) ? result.code : '未知错误码'}`);
}

if (require.main === module) {
  console.error('请通过 feishu-queue.cjs 入队及工作时段发送，禁止使用旧即时发送入口');
  process.exitCode = 1;
}
module.exports = { messageFor, sendMessage };

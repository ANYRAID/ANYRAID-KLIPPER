/** Browser-only view of the native queue. It never manufactures a print grant,
 * retries a mutation, or infers device completion from an HTTP acknowledgement. */
export const queuePanelStyles = `.queue-page{max-width:840px;margin:32px auto;padding:0 24px 40px}.queue-page h1{font-size:30px;margin:0 0 8px}.queue-page h2{font-size:20px;margin:0 0 12px}.queue-page p{margin:8px 0}.queue-page .muted{color:var(--muted)}.queue-page section{margin-top:24px}.queue-page .clearance{padding:24px;background:var(--panel);border:1px solid var(--border);border-radius:12px}.queue-page .filename{font-weight:650;overflow-wrap:anywhere;white-space:pre-wrap}.queue-page .check{display:flex;align-items:flex-start;gap:12px;margin:20px 0}.queue-page .check input{flex-shrink:0;width:24px;height:24px;margin:0;accent-color:var(--accent)}.queue-page .actions{display:flex;flex-wrap:wrap;gap:12px}.queue-page .secondary{background:var(--panel);color:var(--accent);border:1px solid var(--border)}.queue-page button:disabled{cursor:not-allowed}.queue-page ol{padding-left:24px}.queue-page li{padding:12px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere;white-space:pre-wrap}.queue-page a,.toolbar a{color:var(--accent)}.queue-page [hidden]{display:none}.queue-page [aria-busy=true]{opacity:.7}.queue-page .error{margin:16px 0}.queue-page .expiry{font-variant-numeric:tabular-nums}.toolbar a{flex-shrink:0;font-size:14px}@media(max-width:650px){.queue-page{margin:24px auto;padding:0 16px 32px}.queue-page .clearance{padding:20px}.queue-page .actions button{width:100%}.toolbar .account{max-width:25%}}`;
export const queuePanelBody = `<main class="queue-page"><h1>打印队列</h1><p class="muted">每份打印前清空打印台，再确认开始下一份。</p><p id="queue-state" role="status" aria-live="polite">正在读取队列</p><p id="queue-error" class="error" role="alert" aria-live="polite" hidden></p><section class="clearance" id="queue-operation" aria-busy="false"><h2>下一份打印</h2><p id="queue-file" class="filename">正在读取</p><p id="queue-guidance" class="muted">请等待队列状态确认。</p><p id="queue-expiry" class="muted expiry" hidden></p><label class="check"><input id="queue-cleared" type="checkbox" disabled><span>打印台已清空，下一份可以开始。</span></label><div class="actions"><button id="queue-confirm" type="button" disabled>确认并开始下一份</button><button id="queue-prepare" class="secondary" type="button" disabled>请求下一份确认</button></div></section><section aria-labelledby="queue-list-title"><h2 id="queue-list-title">等待打印的文件</h2><ol id="queue-list"></ol><p id="queue-empty" class="muted" hidden>队列为空。可返回控制台选择文件并加入队列。</p></section><section class="actions"><button id="queue-refresh" class="secondary" type="button">刷新状态</button><button id="queue-pause" class="secondary" type="button" disabled>停止后续排队</button></section><p class="muted">停止排队不会取消正在打印的作业。<a href="/_client/control">返回控制台查看当前打印</a></p></main>`;

export function queuePanelBrowser(win: Window & typeof globalThis): void {
  const doc = win.document;
  const element = (id: string) => doc.getElementById(id)!;
  const cleared = element('queue-cleared') as HTMLInputElement;
  const confirm = element('queue-confirm') as HTMLButtonElement;
  const prepare = element('queue-prepare') as HTMLButtonElement;
  const pause = element('queue-pause') as HTMLButtonElement;
  const refresh = element('queue-refresh') as HTMLButtonElement;
  const error = element('queue-error');
  type Job = { job_id: string; filename: string };
  type Confirmation = { version: number; phase: string; state_token: string; job_id: string; filename: string; expires_at: number };
  type Status = { queue_state: string; queued_jobs: Job[]; transition?: Confirmation | null };
  let status: Status | undefined, busy = false, stopped = false, sequence = 0, listing = '', mutationWarning = false;
  let reading: AbortController | undefined;
  const showError = (message: string) => { error.textContent = message; error.hidden = false; };
  const revoke = () => { cleared.checked = false; confirm.disabled = true; cleared.disabled = true; };
  function buttons(): void {
    const configured = !!status && Object.hasOwn(status, 'transition');
    cleared.disabled = busy || stopped || doc.visibilityState === 'hidden' || !configured || !status?.transition;
    confirm.disabled = cleared.disabled || !cleared.checked;
    prepare.disabled = busy || stopped || !configured || !status?.queued_jobs.length || status.queue_state !== 'paused' || !!status.transition;
    pause.disabled = busy || stopped || !status || !status.queued_jobs.length && !status.transition;
    refresh.disabled = busy || stopped;
    element('queue-operation').setAttribute('aria-busy', String(busy));
  }
  function parse(value: unknown): Status {
    const candidate = (value as { result?: Status })?.result;
    if (!candidate || !['paused', 'ready', 'loading', 'starting'].includes(candidate.queue_state) || !Array.isArray(candidate.queued_jobs) || candidate.queued_jobs.length > 128 || candidate.queued_jobs.some(job => !job || typeof job.job_id !== 'string' || typeof job.filename !== 'string' || job.filename.length > 4096)) throw Error('Invalid queue response');
    if (candidate.transition !== undefined && candidate.transition !== null) {
      const c = candidate.transition, head = candidate.queued_jobs[0];
      if (c.version !== 1 || c.phase !== 'awaiting_confirmation' || !/^[a-f0-9]{32}$/.test(c.state_token) || !Number.isFinite(c.expires_at) || !head || c.job_id !== head.job_id || c.filename !== head.filename) throw Error('Invalid queue confirmation');
    }
    return candidate;
  }
  function render(next: Status): void {
    if (!status || status.transition?.state_token !== next.transition?.state_token || status.queued_jobs[0]?.job_id !== next.queued_jobs[0]?.job_id) revoke();
    status = next;
    const configured = Object.hasOwn(next, 'transition'), pending = next.transition;
    const labels: Record<string, string> = { paused: '队列已暂停', ready: '等待当前打印结束', loading: '正在准备打印', starting: '正在提交打印' };
    element('queue-state').textContent = pending ? '等待清台确认' : labels[next.queue_state];
    element('queue-file').textContent = next.queued_jobs[0]?.filename ?? '暂无下一份打印';
    element('queue-guidance').textContent = !configured ? '当前设备未启用逐份清台确认，请联系设备管理员。' : pending ? '取走成品及残留材料，确认打印台已准备好。' : next.queued_jobs.length ? next.queue_state === 'paused' ? '请求本次确认后，核对文件并清空打印台。此步骤不会开始打印。' : '当前作业结束后，再确认下一份打印。' : '加入新的文件后，再请求清台确认。';
    element('queue-expiry').hidden = !pending;
    element('queue-expiry').textContent = pending ? '本次确认有效至 ' + new Date(pending.expires_at).toLocaleTimeString('zh-CN') + '，过期后需重新请求。' : '';
    const signature = JSON.stringify(next.queued_jobs.map(job => [job.job_id, job.filename]));
    if (signature !== listing) {
      const children = next.queued_jobs.map(job => { const item = doc.createElement('li'); item.textContent = job.filename; return item; });
      element('queue-list').replaceChildren(...children); listing = signature;
    }
    element('queue-empty').hidden = !!next.queued_jobs.length; buttons();
  }
  async function read(): Promise<void> {
    if (stopped || busy || reading || doc.visibilityState === 'hidden') return;
    const id = sequence, controller = new AbortController(); reading = controller;
    try {
      const response = await win.fetch('/server/job_queue/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (response.status === 401) { stopped = true; revoke(); win.location.replace('/_client/login'); return; }
      if (!response.ok) throw Error(); const next = parse(await response.json());
      if (id === sequence && !stopped) { render(next); if (!mutationWarning) error.hidden = true; }
    } catch {
      if (id === sequence && !stopped) { status = undefined; revoke(); buttons(); showError('无法确认队列状态，已暂停页面操作。请检查连接后刷新。'); }
    } finally { if (reading === controller) reading = undefined; }
  }
  async function mutate(path: string, body: object): Promise<void> {
    if (busy || stopped) return;
    busy = true; sequence++; reading?.abort(); reading = undefined; revoke(); buttons(); error.hidden = true; mutationWarning = false;
    try {
      const response = await win.fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (stopped) return;
      if (response.status === 401) { stopped = true; win.location.replace('/_client/login'); return; }
      if (!response.ok) {
        mutationWarning = true;
        showError(response.status === 403 ? '当前账号不能确认这份任务，请重新请求自己的确认。' : [409, 410].includes(response.status) ? '队列或确认已改变，请刷新后重新请求。' : '请求未被接受，请查看当前打印状态后再操作。'); status = undefined; return;
      }
      const next = parse(await response.json()); if (stopped) return; render(next);
      if (path.endsWith('/pause')) element('queue-state').textContent = '后续排队已停止，当前打印保持原状态';
      else if ('transition_token' in body) element('queue-state').textContent = '清台确认已提交，请在控制台查看打印状态';
    } catch { if (!stopped) { status = undefined; mutationWarning = true; showError('请求结果未确认，请返回控制台查看当前打印。不会自动重试。'); } }
    finally { busy = false; revoke(); buttons(); }
  }
  cleared.addEventListener('change', buttons);
  confirm.addEventListener('click', () => { if (!confirm.disabled && cleared.checked && status?.transition) void mutate('/server/job_queue/start', { transition_token: status.transition.state_token }); });
  prepare.addEventListener('click', () => { if (!prepare.disabled) void mutate('/server/job_queue/start', { request_confirmation: true }); });
  pause.addEventListener('click', () => { if (!pause.disabled) void mutate('/server/job_queue/pause', {}); });
  refresh.addEventListener('click', () => { mutationWarning = false; revoke(); void read(); });
  doc.addEventListener('visibilitychange', () => { sequence++; reading?.abort(); reading = undefined; revoke(); if (doc.visibilityState !== 'hidden') void read(); });
  const timer = win.setInterval(() => { void read(); }, 1000);
  win.addEventListener('pagehide', () => { stopped = true; sequence++; reading?.abort(); revoke(); win.clearInterval(timer); }, { once: true });
  win.addEventListener('pageshow', event => { if (event.persisted) win.location.reload(); });
  void read();
}

export function queuePanelScript(): string { return '(' + queuePanelBrowser.toString() + ')(window);'; }

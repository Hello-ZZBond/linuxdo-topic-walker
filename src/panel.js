  /* ════════════════════════════════════════════════════════════════
   * 14. 面板：字段声明 + 自动渲染/回填/持久化
   * ════════════════════════════════════════════════════════════════ */
  const FIELDS = [
    // ── 帖子层面：按「一个帖子」为单位生效 ──
    { id: 'mode', group: '帖子', row: 1, label: '模式', type: 'select',
      options: [['iframe', 'iframe 实读（计已读）'], ['goto', '整页跳转（最像真人）']],
      title: '决定怎么打开帖子。两种都会真的渲染楼层、计入评论已读' },
    { id: 'maxCollect', group: '帖子', row: 1, label: '收集上限', type: 'number', min: 0, step: 50,
      title: '一次最多从 /unseen 收集多少帖；0 = 不限制' },
    { id: 'topicInterval', group: '帖子', row: 1, label: '帖子间隔 ms', type: 'number', min: 300, step: 100, fallback: 1500,
      title: '处理完一帖到开始下一帖之间等多久，防连续请求被限流' },
    { id: 'trackVisit', group: '帖子', row: 1, label: '补记浏览数', type: 'checkbox',
      title: '每帖补发一次浏览记录，让「浏览话题」增长。站点按「不重复话题」统计：进过的帖不会 +1，数字滞后 5~15 分钟' },

    // ── 评论层面：按「帖子内部的楼层」为单位生效 ──
    { id: 'dwell', group: '评论', row: 2, label: '加载停留 s', type: 'number', min: 1, step: 1, fallback: 3,
      title: '帖子加载完后先停这么久，让 Discourse 完成首屏楼层上报，再开始滚动' },
    { id: 'scrollMode', group: '评论', row: 2, label: '滚动', type: 'select',
      options: [['step', '逐屏（计已读）'], ['jump', '直接跳到底'], ['none', '不滚动']],
      title: '逐屏才会计入楼层已读；跳到底只求「打开过」' },
    { id: 'stepDwell', group: '评论', row: 2, label: '每屏停留 s', type: 'number', min: 1, step: 1, fallback: 3,
      title: '滚一屏后停多久。低于 2 秒大概率不计已读' },
    { id: 'maxScreens', group: '评论', row: 2, label: '每帖最多屏', type: 'number', min: 0, step: 10,
      title: '你自己定：单帖最多滚多少屏。到上限就结算这一帖并直接进下一帖，不会停；0 = 不限（超长帖会很久且容易 429）' },

    // ── 点赞 ──
    { id: 'likeEnabled', group: '点赞', row: 4, label: '给楼主点赞', type: 'checkbox',
      title: '给处理过的帖子点一个赞。已赞过的自动跳过，绝不会取消已有赞' },
    { id: 'likeChance', group: '点赞', row: 4, label: '点赞概率 %', type: 'number', min: 0, max: 100, step: 5, allowZero: true, fallback: 100,
      title: '按百分比随机点赞：100 = 每帖都赞，0 = 都不赞' },
    { id: 'likeInterval', group: '点赞', row: 4, label: '点赞最小间隔 ms', type: 'number', min: 0, step: 500, allowZero: true, fallback: 3000,
      title: '两次点赞之间至少隔多久，避免触发风控' }
  ];

  const CSS = `
    #${NS}-panel{position:fixed;left:14px;bottom:14px;z-index:999999;width:430px;max-width:calc(100vw - 28px);
      background:var(--secondary,#fff);color:var(--primary,#222);border:1px solid var(--primary-low,#d7d7d7);
      border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.24);font:13px/1.5 "Segoe UI",system-ui,sans-serif;
      box-sizing:border-box;overflow:hidden}
    #${NS}-panel *{box-sizing:border-box}
    #${NS}-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;
      background:var(--primary-very-low,#f2f2f2);user-select:none;font-weight:700;font-size:13px}
    #${NS}-head button{border:0;background:transparent;color:inherit;font-size:17px;line-height:1;cursor:pointer;padding:0 4px}
    #${NS}-body{padding:10px 12px 12px}
    #${NS}-body.hide{display:none}
    .${NS}-row{display:flex;flex-wrap:wrap;gap:6px 8px;margin-bottom:8px;align-items:center}
    .${NS}-group{font-size:12px;font-weight:700;color:var(--tertiary,#08c);margin:2px 0 5px;
      padding-bottom:2px;border-bottom:1px solid var(--primary-low,#e6e6e6)}
    .${NS}-row label{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--primary-medium,#666)}
    .${NS}-row input[type=number]{width:78px}
    .${NS}-row input,.${NS}-row select{padding:3px 6px;border:1px solid var(--primary-low,#ccc);
      border-radius:6px;background:var(--secondary,#fff);color:inherit;font-size:12px}
    .${NS}-row input:focus,.${NS}-row select:focus{outline:2px solid var(--tertiary,#08c);outline-offset:-1px}
    .${NS}-btns{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
    .${NS}-btns button{padding:5px 10px;border:0;border-radius:7px;font-size:12px;font-weight:700;
      cursor:pointer;color:#fff;background:#4caf50;white-space:nowrap}
    .${NS}-btns button.gray{background:#607d8b}
    .${NS}-btns button.red{background:#e04a4a}
    #${NS}-log{margin:0;padding:8px;height:132px;overflow:auto;background:var(--primary-very-low,#f7f7f7);
      border:1px solid var(--primary-low,#e2e2e2);border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;
      white-space:pre-wrap;word-break:break-all}
    .${NS}-meta{display:flex;gap:12px;font-size:12px;color:var(--primary-medium,#666);margin-bottom:8px;flex-wrap:wrap}
    .${NS}-meta b{color:var(--primary,#222)}
    .${NS}-alert{display:none;font-size:12px;line-height:1.45;padding:6px 8px;border-radius:6px;margin-bottom:6px;
      border-left:3px solid #e08a00;background:rgba(224,138,0,.12);color:#8a5a00;white-space:pre-wrap}
    .${NS}-alert.err{border-left-color:#e04a4a;background:rgba(224,74,74,.14);color:#a52c2c}
  `;

  function fieldHtml(field) {
    const title = field.title ? ` title="${field.title}"` : '';

    if (field.type === 'select') {
      const options = field.options
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join('');
      return `<label>${field.label} <select id="${NS}-${field.id}">${options}</select></label>`;
    }

    if (field.type === 'checkbox') {
      return `<label><input type="checkbox" id="${NS}-${field.id}"${title}> ${field.label}</label>`;
    }

    const min = field.min === undefined ? '' : ` min="${field.min}"`;
    const step = field.step === undefined ? '' : ` step="${field.step}"`;
    return `<label>${field.label} <input type="number" id="${NS}-${field.id}"${min}${step}${title}></label>`;
  }

  function rowsHtml() {
    const byRow = new Map();
    for (const field of FIELDS) {
      if (!byRow.has(field.row)) byRow.set(field.row, []);
      byRow.get(field.row).push(field);
    }

    let lastGroup = '';
    return [...byRow.keys()]
      .sort((a, b) => a - b)
      .map((row) => {
        const fields = byRow.get(row);
        const group = fields[0].group || '';
        const head = group && group !== lastGroup ? `<div class="${NS}-group">${group}</div>` : '';
        lastGroup = group;
        return head + `<div class="${NS}-row">${fields.map(fieldHtml).join('')}</div>`;
      })
      .join('');
  }

  /** 把控件原始值按字段规则收敛成合法值 */
  function coerce(field, el) {
    if (field.type === 'select') return el.value;
    if (field.type === 'checkbox') return !!el.checked;

    const num = Number(el.value);
    const useRaw = Number.isFinite(num) && (num !== 0 || field.allowZero);
    const base = useRaw ? num : (field.fallback !== undefined ? field.fallback : 0);
    const min = field.min === undefined ? 0 : field.min;
    const max = field.max === undefined ? Infinity : field.max;
    return Math.min(max, Math.max(min, base));
  }

  function readFields() {
    const next = {};
    for (const field of FIELDS) {
      const el = $(field.id);
      if (el) next[field.id] = coerce(field, el);
    }
    return next;
  }

  function fillFields(cfg) {
    for (const field of FIELDS) {
      const el = $(field.id);
      if (!el) continue;
      if (field.type === 'checkbox') el.checked = !!cfg[field.id];
      else el.value = cfg[field.id];
    }
  }

  /** 应用折叠状态：面板重建或页面刷新后保持用户的选择 */
  function applyFold(folded) {
    const body = $('body');
    if (body) {
      if (folded) body.classList.add('hide');
      else body.classList.remove('hide');
    }
    const btn = $('fold');
    if (btn) btn.textContent = folded ? '+' : '–';
  }

  function buildPanel() {
    if (!document.body || $('panel')) return;

    // 样式只注入一次：面板重建时重复 appending 会叠加一堆相同的 <style>
    if (!$('style')) {
      const style = document.createElement('style');
      style.id = NS + '-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = NS + '-panel';
    panel.innerHTML = `
      <div id="${NS}-head">
        <span>🧭 linux.do 帖子巡览器</span>
        <span>
          <button id="${NS}-fold" title="折叠/展开">–</button>
          <button id="${NS}-close" title="隐藏面板">×</button>
        </span>
      </div>
      <div id="${NS}-body">
        ${rowsHtml()}
        <div class="${NS}-btns">
          <button id="${NS}-start" title="重新收集 /unseen 快照，然后连续跑，直到队列清空">▶ 开始</button>
          <button id="${NS}-pause" class="gray" title="停住当前屏、不再开新帖；再点继续">⏸ 暂停</button>
          <button id="${NS}-stop" class="red" title="当前等待 200ms 内退出，并且不再跳下一帖">⏹ 停止</button>
          <button id="${NS}-step" class="gray" title="空闲时：复用当前队列跑 1 帖就停。运行/暂停时：让当前这一帖跑完再停住">⏭ 单步</button>
        </div>
        <div class="${NS}-btns">
          <button id="${NS}-retryVisit" class="gray">👁️ 补记浏览数</button>
          <button id="${NS}-clearQueue" class="gray">🗑️ 清空队列</button>
          <button id="${NS}-resetSess" class="red">♻️ 重置本次会话</button>
          <button id="${NS}-selfCheck" class="gray">🔍 自检</button>
        </div>
        <div class="${NS}-meta">
          <span>状态 <b id="${NS}-state">空闲</b></span>
          <span>当前 <b id="${NS}-cur">-</b></span>
          <span title="本次会话读完的帖子数">已读帖子 <b id="${NS}-topics">0</b></span>
          <span title="本次会话计入已读的评论（楼层）数">已读评论 <b id="${NS}-comments">0</b></span>
          <span title="本次会话成功点赞的帖子数">已点赞 <b id="${NS}-likes">0</b></span>
          <span title="未读列表快照里还剩多少帖">队列 <b id="${NS}-queue">0</b></span>
        </div>
        <div id="${NS}-status" style="font-size:12px;margin-bottom:6px;color:var(--primary-medium,#666)">空闲</div>
        <div id="${NS}-alert" class="${NS}-alert"></div>
        <pre id="${NS}-log"></pre>
      </div>
    `;
    document.body.appendChild(panel);

    fillFields(config.read());
    view.stats(session.read());
    view.queue((store.sget(SKEY.queue, []) || []).length);

    bindFields();
    bindButtons(panel);

    applyFold(config.read().panelFolded);
  }

  function bindFields() {
    for (const field of FIELDS) {
      const el = $(field.id);
      if (!el) continue;
      el.addEventListener('change', () => {
        config.write(readFields());
      });
    }
  }

  function bindButtons(panel) {
    $('fold').addEventListener('click', () => {
      const folded = !config.read().panelFolded;
      config.write({ panelFolded: folded });
      applyFold(folded);
    });

    $('close').addEventListener('click', () => {
      if (rt.active) return alert('运行中不能关闭面板');
      panel.remove();
      log('面板已关闭；按 F5 刷新页面可重新显示');
    });

    $('start').addEventListener('click', () => {
      config.write(readFields());
      // 新会话：计数清零、队列重取（已读帖会立刻从 /unseen 消失，旧快照可能过期）
      session.reset();
      store.sset(SKEY.queue, []);
      view.queue(0);
      // 清掉上一次的运行状态：否则「已停止」会被整页跳转的接力带进新一轮
      store.sset(SKEY.handoff, false);
      run.clear();
      rt.paused = false;
      rt.stopped = false;
      rt.stepRequest = false;
      syncPauseButton();
      runOnce(false);
    });

    $('step').addEventListener('click', () => {
      config.write(readFields());

      // 运行中 / 已暂停：像调试器那样「放行一帖」，跑完仍停在暂停态
      if (rt.active) {
        rt.stepRequest = true;
        rt.paused = false;
        run.write({ paused: false });
        syncPauseButton();
        log('⏭ 单步：当前这一帖跑完就停住');
        return;
      }

      // 空闲：复用当前队列，跑 1 帖就收工（不重新收集 /unseen）
      runOnce(true);
    });

    $('pause').addEventListener('click', () => {
      rt.paused = !rt.paused;
      run.write({ paused: rt.paused });
      syncPauseButton();
      log(rt.paused ? '⏸ 已暂停（当前屏停住，不再开新帖）' : '▶ 继续');
    });

    $('stop').addEventListener('click', () => {
      stopRun();
      syncPauseButton();
      log('⏹ 已请求停止（当前等待最多 200ms 后退出，且不再跳下一帖）');
    });

    $('retryVisit').addEventListener('click', retryVisits);
    $('clearQueue').addEventListener('click', clearQueue);
    $('resetSess').addEventListener('click', resetSession);
    $('selfCheck').addEventListener('click', selfCheck);
  }

  /** 🔍 自检：把选择器命中情况、点赞按钮信号、运行状态一次性写进日志 */
  function selfCheck() {
    const cfg = config.read();
    const seen = new Set();
    scroll.collectFloors(document, seen);
    const post = liker.firstPost(document);
    const btn = liker.likeButton(post);
    const s = session.read();

    log(`🔍 自检 ${location.pathname}｜模式=${cfg.mode}｜滚动=${cfg.scrollMode}｜点赞=${cfg.likeEnabled ? '开' : '关'}`);
    log(`🔍 楼层节点 ${scroll.nodeCount(document)} 个 → 解析出 ${seen.size} 个楼层号：${[...seen].slice(0, 12).join(',')}`);
    if (btn) {
      const sig = liker.signals(btn);
      log(`🔍 点赞按钮 title="${sig.title}"｜图标=${sig.iconClass}｜href=${sig.iconHref}｜判定=${liker.likedState(btn)}`);
      log(`🔍 按钮 class=${sig.btnClass}`);
    } else {
      log('🔍 没找到点赞按钮（选择器全部没命中）');
    }
    log(`🔍 reactions 计数=${post ? liker.countOf(post) : '-'}`);
    log(`🔍 会话：帖子 ${s.topics} / 评论 ${s.comments} / 赞 ${s.likes}｜run=${JSON.stringify(run.read())}｜pause=${rt.paused} stop=${rt.stopped}`);
    log(`🔍 补记浏览数=${cfg.trackVisit ? '开' : '关（「浏览话题」不会增长）'}｜待补记 ${s.pendingVisit.length} 帖`);
    log('🔍 口径：站点「浏览话题」按 topic_views 去重统计，同一个帖再读不会 +1；「浏览帖子」只算新读的楼层，两者都会滞后 5~15 分钟');
    view.status('自检结果已写入日志');
  }

  /** 重置本次会话：三个计数 + 队列 + 待补记清单全部归零 */
  function resetSession() {
    if (rt.active) return alert('运行中不能重置');
    const s = session.read();
    if (!confirm(`重置本次会话？\n\n已读帖子 ${s.topics} / 已读评论 ${s.comments} / 已点赞 ${s.likes}，以及未读队列都会清零。`)) return;
    session.reset();
    store.sset(SKEY.queue, []);
    store.sset(SKEY.handoff, false);
    run.clear();
    rt.paused = false;
    rt.stopped = false;
    rt.stepRequest = false;
    view.queue(0);
    syncPauseButton();
    log('♻️ 已重置本次会话');
  }

  /** 清空「未读队列」快照：下次点「开始」会重新收集 */
  function clearQueue() {
    const n = (store.sget(SKEY.queue, []) || []).length;
    store.sset(SKEY.queue, []);
    // 清空队列 = 让下一次「开始 / 单步」重新收集，而不是当成「本轮已清空」直接收工
    run.write({ collected: false });
    view.queue(0);
    log(`🗑️ 已清空未读队列（原有 ${n} 帖），下次「开始」会重新收集`);
  }

  /** 对未确认的记录补发浏览计数（已确认的跳过） */
  async function retryVisits() {
    const pending = session.read().pendingVisit.slice();
    if (!pending.length) return alert('本次会话没有未确认的浏览计数');
    if (!confirm(`对 ${pending.length} 帖补发浏览计数？`)) return;

    // 允许在停止状态下手动触发（内存 + 落盘状态一起清，否则 hold() 立刻返回 false）
    rt.stopped = false;
    rt.paused = false;
    run.write({ stopped: false, paused: false });

    const cfg = config.read();
    let done = 0;
    let confirmed = 0;

    for (const id of pending) {
      if (rt.stopped) break;
      view.status(`补记浏览数 ${done + 1}/${pending.length}`);
      const info = await visit.track(id);
      if (info.state === 'confirmed') {
        confirmed += 1;
        session.removePendingVisit(id);
      }
      done += 1;
      if (!(await hold(Math.max(600, cfg.topicInterval)))) break;
    }

    const summary = `补记完成：处理 ${done} 条，确认 ${confirmed} 条`;
    view.status(summary);
    log(`👁️ ${summary}`);
    alert(summary);
  }

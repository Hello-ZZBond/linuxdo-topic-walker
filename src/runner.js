  /* ════════════════════════════════════════════════════════════════
   * 13. 运行器：只做编排，阅读方式交给 reader 策略
   * ════════════════════════════════════════════════════════════════ */
  async function runOnce(stepOnly) {
    if (rt.active) return;

    const cfg = config.read();
    if (!cfg.trackVisit) {
      log('⚠️ 「补记浏览数」已关闭：本次不会增加「浏览话题」（站点按不重复话题统计，进过的帖也不会 +1）');
    }

    rt.active = true;
    rt.stopped = false;
    rt.done = 0;
    rt.paused = run.read().paused; // 暂停状态跨页面继承
    run.write({ running: true, stopped: false, phase: 'run', rateLimited: false });
    view.alert(''); // 新一轮开始：清掉上一轮的告警
    syncPauseButton();

    const source = unseenSource(cfg);
    const reader = readers[cfg.mode] || readers.iframe;
    let navigated = false;

    try {
      if (!(await source.prepare())) return;
      if (rt.stopped) return;

      log(`▶️ 开始：模式=${cfg.mode}，帖子间隔=${cfg.topicInterval}ms`);

      while (!rt.stopped) {
        while (rt.paused && !rt.stopped) await sleep(250);
        if (rt.stopped) break;

        const next = source.peek();
        if (next.done) {
          if (next.reason) log(next.reason);
          break;
        }

        const id = next.id;
        view.current(id);
        view.status(`探测 /t/${id}.json`);
        run.write({ currentId: id, phase: 'probe' });

        const probe = await discourse.topic(id);
        if (!probe) break;
        if (probe.kind === 'limited') {
          run.write({ rateLimited: true });
          view.status('被限流');
          const left = (store.sget(SKEY.queue, []) || []).length;
          log(`⛔ 被限流打断：队列还剩 ${left} 帖，没有丢。等 1~2 分钟再点「▶ 开始」`);
          view.alert(`被限流（429）：队列还剩 ${left} 帖，没有丢。等 1~2 分钟再点「▶ 开始」`, 'err');
          break;
        }
        if (probe.kind === 'abort') break;

        if (probe.kind === 'miss') {
          source.onMiss(probe.code);
          source.advance();
          if (!(await hold(Math.min(cfg.topicInterval, 400)))) break;
          continue;
        }

        // last_read > 0 = 这帖以前点开过；站点对「话题」按帖去重，
        // 所以它能涨评论、不会涨话题。明说，免得把正常现象当成故障。
        const readBefore = Number(probe.topic.last_read_post_number) || 0;
        if (readBefore > 0) {
          log(`ℹ️ /t/${id} 之前已进过（已读到 ${readBefore} 楼）：本话题不会增加「浏览话题」，只会增加评论数`);
        }

        const ctx = { id, topic: probe.topic, title: discourse.title(probe.topic), cfg };
        const visitInfo = await trackVisitOnce(id, cfg);
        // 记下这次补发是否被服务端确认：整页跳转会在下一页面用它决定补不补
        run.write({ visitConfirmed: visitInfo.state === 'confirmed' });
        // 没被确认记上的，留给「补记浏览数」按钮
        if (visitInfo.state !== 'confirmed' && visitInfo.state !== 'skipped') session.addPendingVisit(id);

        const result = await reader(ctx);

        // iframe 模式没有「落地页」可依赖：读完如果补发仍未确认，
        // 趁这一页还在，再补一次（整页跳转由 resumeHandoff 负责）。
        if (result.kind === 'ok' && cfg.trackVisit && run.read().visitConfirmed === false) {
          const retry = await trackVisitOnce(id, cfg);
          run.write({ visitConfirmed: retry.state === 'confirmed' });
          if (retry.state !== 'confirmed') session.addPendingVisit(id);
        }

        if (result.kind === 'aborted') {
          log(`⏸ /t/${id} 被打断，不计入已读`);
          break;
        }

        if (result.kind === 'handoff') {
          // 交接：已读由落地页结算，这里只推进队列 + 跳转
          source.advance();
          rt.done += 1;
          framePane.show(false);
          rt.active = false;

          if (rt.stopped || run.read().stopped) {
            run.write({ running: false, phase: 'idle' });
            log('⏹ 已停止，不再跳转');
            return;
          }

          navigated = true;
          view.status(`跳转 /t/${id}/1`);
          location.href = `/t/${id}/1`;
          return;
        }

        session.addTopic(result.read);
        source.advance();
        rt.done += 1;
        view.status(`已完成 ${rt.done} 帖`);

        if (stepOnly) break;

        // 暂停中点了「单步」：放行这一帖，然后回到暂停态等下一步
        if (rt.stepRequest) {
          rt.stepRequest = false;
          rt.paused = true;
          run.write({ paused: true });
          syncPauseButton();
          log(`⏭ 已完成一步（${rt.done} 帖），仍保持暂停`);
          continue;
        }
        if (!(await hold(cfg.topicInterval))) break;
      }
    } finally {
      rt.active = false;
      // 跳转交接时不能清状态：下一个页面要靠它接力
      if (!navigated) {
        const stopped = rt.stopped;
        rt.paused = false;
        rt.stepRequest = false;
        rt.stopped = false;
        run.write({ running: false, paused: false, phase: 'idle' });
        syncPauseButton();
        const limited = !!run.read().rateLimited;
        view.status(stopped ? '已停止' : limited ? '被限流' : '已完成');
        log(stopped ? '⏹ 已停止' : limited ? '⛔ 本轮被限流打断：队列和计数都保留，过几分钟再点「▶ 开始」' : '✅ 本轮结束');
      }
    }
  }

  /** 停止：内存 + 持久状态一起改，页面重载后接力不会把它复活 */
  function stopRun() {
    rt.stopped = true;
    rt.paused = false;
    run.write({ running: false, stopped: true, paused: false, phase: 'idle' });
    store.sset(SKEY.handoff, false);
  }

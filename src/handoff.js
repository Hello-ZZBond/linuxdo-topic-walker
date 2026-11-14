  /* ════════════════════════════════════════════════════════════════
   * 15. 整页跳转模式的接力
   *
   *    goto 模式每帖都会真跳一次页面，JS 上下文随之重建，
   *    所以「正在跑 / 已暂停 / 已停止」全部落在 sessionStorage 里，
   *    新页面 boot() 取回来之后再决定要不要继续。
   *    （v2 只存内存：用户点暂停/停止后页面一跳，状态就被抹平了。）
   * ════════════════════════════════════════════════════════════════ */
  function resumeHandoff() {
    const st = run.read();
    if (!st.running) return false;

    const cfg = config.read();

    if (st.stopped || rt.stopped) {
      run.write({ running: false, paused: false, phase: 'idle' });
      view.status('已停止');
      log('⏹ 上次已停止，本页不接力');
      return false;
    }

    if (cfg.mode !== 'goto') {
      run.write({ running: false, phase: 'idle' });
      return false;
    }

    // 只认「上一页刚写下的交接标记」；用户自己按 F5 不该把一整轮又跑起来。
    // 标记用完即清，所以落地页刷新一次就干净退出。
    if (store.sget(SKEY.handoff, false) !== true) {
      run.write({ running: false, paused: false, phase: 'idle' });
      return false;
    }
    store.sset(SKEY.handoff, false);

    const id = st.currentId || currentTopicId();
    log(`🔁 接力 /t/${id}：${cfg.dwell}s 后点赞 + 滚动，读完接着跑下一帖`);

    // 跳转前那次补发可能随页面卸载丢掉（Cloudflare 挑战、请求被取消等）。
    // 落地页本身就是话题页，这里补一次；只在明确「未确认」时补，避免重复请求。
    if (id && st.visitConfirmed === false && cfg.trackVisit) {
      log('👁️ 落地页补发浏览记录（跳转前那次未确认）');
      (async () => {
        const info = await trackVisitOnce(id, cfg);
        run.write({ visitConfirmed: info.state === 'confirmed' });
        if (info.state !== 'confirmed') session.addPendingVisit(id);
      })();
    }

    (async () => {
      const bail = (why) => {
        run.write({ running: false, paused: false, phase: 'idle' });
        view.status(why);
        log(`⏹ ${why}`);
      };

      if (!(await hold(cfg.dwell * 1000 + 1200))) return bail('已停止');
      if (!id) return bail('取不到话题 id');

      let likeState = '';
      if (cfg.likeEnabled) likeState = await likeFirstPost(document, id, cfg);
      if (rt.stopped) return bail('已停止');

      const floors = await scroll.apply(document, window, cfg);
      if (rt.stopped) return bail('已停止');

      // 点赞已在 likeFirstPost 里就地计过数，这里只结算「帖子 + 楼层」
      session.addTopic(floors);

      if (run.read().stopped) return bail('已停止');
      run.write({ phase: 'run' });
      runOnce(false);
    })();

    return true;
  }

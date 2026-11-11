  /* ════════════════════════════════════════════════════════════════
   * 11. 阅读器策略
   *   接口：read({ id, topic, title, cfg }) →
   *         {kind:'ok', read, pages} | {kind:'aborted'} | {kind:'handoff'}
   * ════════════════════════════════════════════════════════════════ */
  const readers = {

    /** iframe 内真实渲染 + 逐屏滚动 —— 由 Discourse 前端自己上报已读 */
    async iframe(ctx) {
      const { id, topic, title, cfg } = ctx;
      view.status(`实读 《${title.slice(0, 20)}》 停留 ${cfg.dwell}s`);
      const opened = await framePane.open(id, cfg);
      if (opened.aborted) return { kind: 'aborted' };
      log(`📄 /t/${id} 《${title.slice(0, 30)}》 全帖 ${discourse.floorCount(topic)} 楼，本轮读到 ${opened.floors} 楼`);
      return { kind: 'ok', like: opened.like || '', read: opened.floors || 0 };
    },

    /** 整页跳转：写状态 → 由页面重载接力 */
    async goto(ctx) {
      const { id, title } = ctx;
      store.sset(SKEY.handoff, true);
      run.write({ running: true, currentId: id, stopped: false, paused: false, phase: 'handoff' });
      log(`🚀 跳转 /t/${id}/1 《${title.slice(0, 30)}》`);
      return { kind: 'handoff' };
    }
  };

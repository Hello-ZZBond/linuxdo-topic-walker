  /* ════════════════════════════════════════════════════════════════
   * 3. 运行状态
   *
   *   rt  = 当前页面的内存镜像
   *   run = 落盘状态（sessionStorage）—— 整页跳转每帖都会重载页面，
   *         不落盘的暂停/停止会在下一次导航时被抹平（v2 的病根）
   * ════════════════════════════════════════════════════════════════ */
  const rt = {
    active: false,
    paused: false,
    stopped: false,
    done: 0,
    // 暂停/运行中点了「单步」：放行当前这一帖后重新停住
    stepRequest: false
  };

  const EMPTY_RUN = {
    running: false,
    paused: false,
    stopped: false,
    currentId: null,
    phase: 'idle',
    // 本轮是否已经收集过 /unseen：true 之后队列空了就收工，不再重开一轮
    collected: false,
    // 本轮是否被 429 打断（只影响结束时的措辞与状态显示）
    rateLimited: false,
    // 最近一条错误/警告：面板顶部那条带色提示，跨页面重载也会带过去
    lastError: null
  };

  const run = {
    read() {
      const s = store.sget(SKEY.run, null);
      return Object.assign({}, EMPTY_RUN, s && typeof s === 'object' ? s : {});
    },
    write(patch) {
      const next = Object.assign(run.read(), patch);
      store.sset(SKEY.run, next);
      return next;
    },
    clear() {
      store.sset(SKEY.run, Object.assign({}, EMPTY_RUN));
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 可被「暂停 / 停止」打断的等待；返回 false 表示已被停止。
   * 暂停期间不消耗毫秒数：v2 用墙钟 deadline，暂停 10 秒后恢复，
   * 本该停 3 秒的那一屏会被直接跳过，看着像暂停失效。
   */
  async function hold(ms) {
    let left = Math.max(0, Number(ms) || 0);
    while (left > 0) {
      if (rt.stopped || run.read().stopped) return false;
      if (rt.paused) {
        await sleep(150);
        continue;
      }
      const chunk = Math.min(200, left);
      await sleep(chunk);
      left -= chunk;
    }
    return !(rt.stopped || run.read().stopped);
  }

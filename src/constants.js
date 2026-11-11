  /* ════════════════════════════════════════════════════════════════
   * 1. 常量
   * ════════════════════════════════════════════════════════════════ */
  const NS = 'ldtw';
  const UNSEEN_PATH = '/unseen.json';

  /** localStorage：只放设置（跨会话保留） */
  const KEY = {
    settings: NS + ':settings'
  };

  /** sessionStorage：浏览数据只活一个会话（一个标签页），关掉就没了 */
  const SKEY = {
    queue: NS + ':queue',
    handoff: NS + ':handoff',
    sess: NS + ':sess',
    run: NS + ':run',
    visitSession: NS + ':visit-session'
  };

  const LIMIT = {
    logKeep: 400,
    logShow: 80,
    listPages: 200,
    screensFallback: 400,
    jumpRounds: 15,
    // 等 iframe 触发 load 的上限；超时也继续往下走（真正的判据是「楼层出现」）
    loadWait: 15000,
    // 等楼层渲染出来的上限与轮询步长
    renderWait: 6000,
    pollStep: 200,
    // 同一个请求最多容忍几次 429（含首次）：超过就放弃并让整轮停下，而不是空转
    rateLimit429: 2,
    // 确认「已经到底、没有新楼层」时的等待。
    // 故意不听「每屏停留」：那是给人看一屏的时间（默认 3 秒），
    // 拿来等懒加载会让每个帖子末尾白等两次 stepDwell。
    bottomWait: 1000
  };

  const DEFAULTS = Object.freeze({
    // ── 帖子层面（一个帖子 = 一次处理） ──
    mode: 'iframe',
    maxCollect: 500,
    topicInterval: 1500,
    trackVisit: true,

    // ── 评论层面（帖子内部的楼层 / 滚动） ──
    dwell: 3,
    scrollMode: 'step',
    stepDwell: 3,
    maxScreens: 60,

    // ── 点赞 ──
    likeEnabled: false,
    likeChance: 100,
    likeInterval: 3000,

    // 面板折叠状态（无 UI 字段：只用来在重建/刷新后保持原样）
    panelFolded: false
  });

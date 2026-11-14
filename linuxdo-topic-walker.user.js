// ==UserScript==
// @name         linux.do 帖子巡览器
// @namespace    https://linux.do/
// @version      3.2.8
// @description  只消费 linux.do 的 /unseen 未读列表：逐帖打开、逐屏滚动计入已读，补发浏览记录，可给楼主帖点赞；统计「已读帖子/已读评论/已点赞」三项，数据只活一个会话。
// @author       PI-Desktop
// @match        https://linux.do/*
// @icon         https://linux.do/uploads/default/original/1X/91c61b570c26eae8bb5e60b0f9b1f0b2ed97e742.png
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计要点
 * ───────────────────────────────────────────────────────────────────────────
 * 1. 为什么用 @grant none + 同源 fetch
 *    linux.do 挂在 Cloudflare 后面，脱离浏览器的裸请求会被 challenge。
 *    脚本跑在页面里，fetch('/t/123.json') 是同源请求，自动带 Cookie 和
 *    cf_clearance。一旦换成 GM_xmlhttpRequest 会脱离页面上下文，反而缺 Cookie。
 *
 * 2. 为什么不需要知道「有多少条评论」
 *    /t/{id}.json 的 highest_post_number 就是楼层上界。逐页累加 post_number，
 *    一旦 >= highest_post_number 即本帖结束。注意 posts_count ≠ 楼层数：
 *    删帖后楼层号会跳号，拿 posts_count 算页数会翻到空页才停。
 *
 * 3. 为什么优先用 /unseen
 *    只列你还没读过的帖子，id 全部有效，不会把额度浪费在大片空洞上。
 *    但读过的帖子会立刻从列表消失，所以必须先把列表整份收集成快照再逐条消费；
 *    边翻页边读会让分页偏移错位，整批漏帖。
 *
 * 4. 为什么必须逐屏滚动
 *    Discourse 的阅读追踪按「每个楼层在视口里累计可见的毫秒数」计算。
 *    一步跳到最底时中间楼层的 msecs 接近 0，服务端不会标记已读。
 *
 * 5. 架构
 *    存储 / 日志 / HTTP / discourse 领域层 / 滚动 / 阅读器策略 /
 *    未读来源 / 运行器 / 面板(声明式) / 记录
 *
 *    未读来源   unseenSource → prepare / peek / advance
 *    阅读器策略 (json | iframe | goto) → read
 *    运行器只做编排，阅读方式按 cfg.mode 选一个 reader。
 *
 * 6. 只做未读
 *    本工具只消费 /unseen，不提供「按 ID 扫描」模式 ——
 *    漫无目的地扫 ID 会撞上大片已删 / 私密空洞，纯属浪费额度。
 *
 * 7. 源码结构
 *    开发时按层拆在 src/（一个文件 = 一层），node build.mjs 拼成这一个
 *    单文件产物。产物可直接粘贴安装；改代码请改 src/ 后重新构建。
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ⚠️ 本文件由 src/ 下各模块拼接生成（node build.mjs），不要直接改这里 */

  /* 自己创建的 iframe 内部不再初始化 */
  try {
    if (window.self !== window.top) return;
  } catch (e) {
    return;
  }

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

  /* ════════════════════════════════════════════════════════════════
   * 2. 存储
   * ════════════════════════════════════════════════════════════════ */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    /** 写入成功返回 true；配额不足返回 false，由调用方决定怎么降级 */
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },

    /* ── sessionStorage：数据只活在当前标签页会话里 ── */
    sget(key, fallback) {
      try {
        const raw = sessionStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    sset(key, value) {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  const config = {
    read: () => Object.assign({}, DEFAULTS, store.get(KEY.settings, {})),
    write: (patch) => store.set(KEY.settings, Object.assign(config.read(), patch))
  };

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

  /* ════════════════════════════════════════════════════════════════
   * 4. DOM 与视图
   * ════════════════════════════════════════════════════════════════ */
  const $ = (id) => document.getElementById(NS + '-' + id);

  const view = {
    text(id, value) {
      const el = $(id);
      if (el) el.textContent = value;
    },
    status(text) {
      view.text('status', text);
    },
    current(id) {
      view.text('cur', id === null || id === undefined ? '-' : String(id));
    },
    queue(n) {
      view.text('queue', String(n));
    },
    /** 三个会话计数一次性刷新 */
    stats(s) {
      view.text('topics', String((s && s.topics) || 0));
      view.text('comments', String((s && s.comments) || 0));
      view.text('likes', String((s && s.likes) || 0));
    },

    /** 面板警示条：level = 'warn'(黄) | 'err'(红)；传空字符串清除 */
    alert(text, level) {
      const el = $('alert');
      const tone = level === 'err' ? 'err' : 'warn';
      if (el) {
        el.className = text ? `${NS}-alert ${tone}` : `${NS}-alert`;
        el.textContent = text || '';
      }
      run.write({ lastError: text ? { text, tone, at: Date.now() } : null });
    }
  };

  /* ── 日志 ── */
  const logBuffer = [];

  function log(message) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logBuffer.push(`[${stamp}] ${message}`);
    if (logBuffer.length > LIMIT.logKeep) logBuffer.shift();

    const box = $('log');
    if (box) {
      box.textContent = logBuffer.slice(-LIMIT.logShow).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    console.log('[ldtw]', message);
  }

  /** 暂停按钮文字 + 状态徽标：页面重载后也要显示真实状态 */
  function syncPauseButton() {
    const st = run.read();
    const state = rt.paused
      ? '已暂停'
      : rt.stopped || st.stopped
        ? '已停止'
        : rt.active
          ? '运行中'
          : st.running
            ? '接力中'
            : '空闲';
    view.text('pause', rt.paused ? '▶ 继续' : '⏸ 暂停');
    view.text('state', state);
  }

  /* ════════════════════════════════════════════════════════════════
   * 5. HTTP：同源 fetch + 429 退避
   * ════════════════════════════════════════════════════════════════ */
  const HEADERS = { Accept: 'application/json, text/plain, */*' };

  /**
   * 统一请求：同源 fetch + 429 退避。
   * options: { method, headers, retries, keepalive }
   * 返回 { status, ok, body, headers } —— headers 用于读取浏览计数的确认头
   */
  /**
   * 429 该等多久 —— 这个秒数是**站点说了算**的，不是我们的默认值：
   *   1. `Retry-After` 响应头（标准做法，Discourse 会带）
   *   2. Discourse 的 429 body：`{ extras: { wait_seconds } }`
   *   3. 两个都没有（例如被 Cloudflare 拦成 HTML）→ 保守等 10 秒
   */
  async function rateLimitWait(res) {
    const header = parseInt(res.headers.get('Retry-After') || '', 10);
    if (Number.isFinite(header) && header > 0) return Math.max(3, header);
    try {
      const body = await res.json();
      const sec = Number(body && body.extras && body.extras.wait_seconds);
      if (Number.isFinite(sec) && sec > 0) return Math.max(3, sec);
    } catch (e) {
      /* body 不是 JSON，多半是 CF 的拦截页 */
    }
    return 10;
  }

  async function http(path, options = {}) {
    const { method = 'GET', headers = HEADERS, retries = 4, keepalive = false } = options;

    const init = { method, credentials: 'same-origin', headers };
    if (keepalive) {
      init.keepalive = true; // 让请求活过页面跳转
      init.cache = 'no-store';
    }

    let attempt = 0;
    let limited = 0;

    for (;;) {
      if (rt.stopped) return null;

      let res;
      try {
        res = await fetch(path, init);
      } catch (err) {
        log(`网络异常 ${path} — ${err.message}`);
        if (attempt >= retries) return null;
        attempt += 1;
        if (!(await hold(1500 * attempt))) return null;
        continue;
      }

      if (res.status === 429) {
        limited += 1;
        const wait = await rateLimitWait(res);
        if (limited > LIMIT.rateLimit429) {
          log(`⛔ ${path} 连续 ${limited} 次 429，放弃这次请求`);
          return { status: 429, ok: false, body: null, headers: res.headers, rateLimited: true };
        }
        log(`⚠️ ${path} 触发限流 429，等待 ${wait}s 后重试（${limited}/${LIMIT.rateLimit429}）`);
        if (!(await hold(wait * 1000))) return null;
        continue;
      }

      let body = null;
      try {
        body = await res.json();
      } catch (e) {
        body = null;
      }
      return { status: res.status, ok: res.ok, body, headers: res.headers };
    }
  }

  /* ════════════════════════════════════════════════════════════════
   * 6. Discourse 领域层
   * ════════════════════════════════════════════════════════════════ */
  const discourse = {
    /** 探测单帖 → {kind:'ok',topic} | {kind:'miss',code} | {kind:'limited'} | {kind:'abort'} */
    async topic(id) {
      const res = await http(`/t/${id}.json`);
      if (!res) return { kind: 'abort' };
      if (res.rateLimited) return { kind: 'limited' };
      if (!res.ok || !res.body || !res.body.post_stream) return { kind: 'miss', code: res.status };
      return { kind: 'ok', topic: res.body };
    },

    /** 列表分页 → topic_list 或 null */
    async listPage(path) {
      const res = await http(path);
      if (!res || !res.ok || !res.body || !res.body.topic_list) {
        log(`⛔ 收集失败：${path}（HTTP ${res ? res.status : '无响应'}）`);
        view.alert(`收集未读列表失败：${path}（HTTP ${res ? res.status : '无响应'}）`, 'err');
        return null;
      }
      return res.body.topic_list;
    },

    /** more_topics_url 形如 /unseen?page=1，需要补 .json 才能拿到 JSON */
    toJsonPath(url) {
      try {
        const abs = new URL(url, location.origin);
        let path = abs.pathname;
        if (!/\.json$/.test(path)) path = path.replace(/\/+$/, '') + '.json';
        return path + abs.search;
      } catch (e) {
        return null;
      }
    },

    title(topic) {
      return String(topic.title || topic.fancy_title || '(无标题)').trim();
    },

    floorCount(topic) {
      return topic.highest_post_number || 0;
    }
  };

  /* ────────────────────────────────────────────────────────────────
   * 话题浏览计数（topics_entered）
   *
   * 实测结论（2026-11，登录态在 linux.do 上验证）：
   *   ✓ POST /pageview                     → 204，端点存在（注意不是 /t/{id}/pageview）
   *   ✓ GET  /t/{id}.json?track_visit=true → 200，响应带
   *        x-discourse-trackview: 1 / x-discourse-browserpageview: 1
   *
   * ⚠️ 「浏览话题」计数本身是异步的：connect.linux.do 上有延迟，
   *    这里只能确认「请求被接受」，不能确认计数立刻 +1。
   * ──────────────────────────────────────────────────────────────── */
  const visit = {
    sessionId: null,

    meta(name) {
      const el = document.querySelector(`meta[name="${name}"]`);
      return (el && el.content) || '';
    },

    basePath() {
      return visit.meta('discourse-base-uri').replace(/\/$/, '');
    },

    /** 追踪会话 id：优先用站点给的 meta，没有就自己造一个存 sessionStorage */
    session() {
      if (visit.sessionId) return visit.sessionId;

      const fromMeta = visit.meta('discourse-track-view-session-id');
      if (fromMeta) {
        visit.sessionId = fromMeta;
        return fromMeta;
      }

      const key = SKEY.visitSession;
      let id = store.sget(key, null);
      if (!id) {
        const c = typeof crypto !== 'undefined' ? crypto : null;
        id = c && typeof c.randomUUID === 'function'
          ? c.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        store.sset(key, id);
      }
      visit.sessionId = id;
      return id;
    },

    commonHeaders() {
      const headers = {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
      };
      const csrf = visit.meta('csrf-token');
      if (csrf) headers['X-CSRF-Token'] = csrf;
      return headers;
    },

    pageviewHeaders(id) {
      return Object.assign(visit.commonHeaders(), {
        'Discourse-Present': 'true',
        'Discourse-Track-View-Deferred': 'true',
        'Discourse-Track-View-Topic-Id': String(id),
        'Discourse-Track-View-Url': `${location.origin}/t/${id}`,
        'Discourse-Track-View-Referrer': document.referrer || location.href,
        'Discourse-Track-View-Session-Id': visit.session()
      });
    },


    jsonHeaders(id) {
      return Object.assign(visit.commonHeaders(), {
        'Discourse-Present': 'true',
        'Discourse-Track-View': 'true',
        'Discourse-Track-View-Topic-Id': String(id)
      });
    },

    readResult(endpoint, res) {
      const pick = (name) =>
        res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
      const trackView = pick('x-discourse-trackview');
      const pageView = pick('x-discourse-browserpageview');
      return {
        endpoint,
        status: res ? res.status : 0,
        ok: !!(res && res.ok),
        trackView,
        pageView,
        confirmed: trackView === '1' || pageView === '1'
      };
    },

    /**
     * 补发一次浏览记录 → { state: 'confirmed'|'accepted'|'failed', via, attempts }
     *
     * 实测（2026-11，登录态在 linux.do 上验证）：
     *   ✓ POST /pageview                     → 204，端点存在，但响应不带确认头
     *   ✓ GET  /t/{id}.json?track_visit=true → 200，带 x-discourse-trackview: 1
     *
     * 注意 URL 是 `/pageview`，**不是** `/t/{id}/pageview`（后者 404）。
     * 先打 /pageview（社区脚本的标准做法），再用 track_visit 拿确认头。
     */
    async track(id) {
      const attempts = [];

      const pageview = await http(`${location.origin}${visit.basePath()}/pageview`, {
        method: 'POST',
        headers: visit.pageviewHeaders(id),
        retries: 0,
        keepalive: true
      });
      if (pageview) attempts.push(visit.readResult('pageview', pageview));

      const early = attempts.find((a) => a.confirmed);
      if (early) return { state: 'confirmed', via: early.endpoint, attempts };

      const fallback = await http(
        `${location.origin}${visit.basePath()}/t/${id}.json?track_visit=true&forceLoad=true`,
        { headers: visit.jsonHeaders(id), retries: 0 }
      );
      if (fallback) attempts.push(visit.readResult('track_visit', fallback));

      const hit = attempts.find((a) => a.confirmed);
      if (hit) return { state: 'confirmed', via: hit.endpoint, attempts };
      if (attempts.some((a) => a.ok)) return { state: 'accepted', via: null, attempts };
      return { state: 'failed', via: null, attempts };
    }
  };

  /** 按配置补发话题浏览记录 */
  async function trackVisitOnce(id, cfg) {
    if (!cfg.trackVisit) {
      return { state: 'skipped', via: null, attempts: [] };
    }

    view.status(`补发浏览记录 /t/${id}`);
    const info = await visit.track(id);
    const label = {
      confirmed: '✅ 已确认',
      accepted: '⚠️ 已提交未确认',
      failed: '❌ 未记上'
    }[info.state] || info.state;
    log(`👁️ /t/${id} 浏览计数 ${label}${info.via ? ` (${info.via})` : ''}`);
    if (info.state !== 'confirmed') {
      log('↳ 这次补发没被确认：「浏览话题」不会增长，稍后可在面板点「👁️ 补记浏览数」');
    }
    return info;
  }

  /* ════════════════════════════════════════════════════════════════
   * 7. 滚动
   * ════════════════════════════════════════════════════════════════ */
  const scroll = {
    /** 楼层号：linux.do 只给 id="post_N"（实测没有 data-post-number） */
    floorOf(el) {
      if (!el || typeof el.getAttribute !== 'function') return 0;
      const attr = Number(el.getAttribute('data-post-number'));
      if (attr > 0) return attr;
      const m = /^post_(\d+)$/.exec(el.id || '');
      return m ? Number(m[1]) : 0;
    },

    /** 把当前文档里真实存在的楼层号收进 seen（Discourse 是虚拟列表，得跨屏累计） */
    collectFloors(doc, seen) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return seen;
      for (const node of doc.querySelectorAll('article[id^="post_"], article[data-post-number], .topic-post')) {
        const pn = scroll.floorOf(node);
        if (pn > 0) seen.add(pn);
      }
      return seen;
    },

    /** DOM 里的楼层节点数：有节点却解析不出号 = 选择器失配，不是没滚动 */
    nodeCount(doc) {
      if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
      return doc.querySelectorAll('article[id^="post_"], article[data-post-number], .topic-post').length;
    },

    /** 逐屏下移；返回肉眼经过的楼层数（= 已读评论数） */
    async stepwise(doc, win, cfg) {
      const seen = new Set();
      if (!doc || !win) return 0;

      const dwellMs = Math.max(200, (cfg.stepDwell || DEFAULTS.stepDwell) * 1000);
      const limit = cfg.maxScreens > 0 ? cfg.maxScreens : LIMIT.screensFallback;

      let idle = 0;
      let lastHeight = -1;

      for (let screen = 0; screen < limit; screen++) {
        if (rt.stopped) return seen.size;

        const el = doc.scrollingElement || doc.documentElement;
        if (!el) return seen.size;

        scroll.collectFloors(doc, seen);

        const viewH = win.innerHeight || el.clientHeight || 800;
        const maxTop = Math.max(0, el.scrollHeight - viewH);
        const atBottom = el.scrollTop >= maxTop - 4;

        if (atBottom) {
          // 到底了：Discourse 的下一批楼层是懒加载的。连续两次 scrollHeight 没变才算读完；
          // 每次确认固定 bottomWait（1 秒），不用「每屏停留」——后者默认 3 秒，会让末尾多等 6 秒。
          if (el.scrollHeight === lastHeight) {
            idle += 1;
            if (idle >= 2) {
              scroll.collectFloors(doc, seen);
              view.status(`滚动结束：共 ${screen} 屏，收到 ${seen.size} 楼`);
              return seen.size;
            }
          } else {
            idle = 0;
          }
          lastHeight = el.scrollHeight;
          if (!(await hold(LIMIT.bottomWait))) return seen.size;
          el.scrollTop = el.scrollHeight; // 再推一把，触发下一页懒加载
          continue;
        }

        view.status(`滚动第 ${screen + 1} 屏`);
        el.scrollTop = Math.min(el.scrollTop + Math.round(viewH * 0.85), maxTop);
        if (!(await hold(dwellMs))) return seen.size;
      }

      // 走满「每帖最多屏」还没到底：说明后面还有楼层没读，必须明说
      scroll.collectFloors(doc, seen);
      view.status(`已到每帖 ${limit} 屏上限，收到 ${seen.size} 楼`);
      const capMsg = `已到「每帖最多屏」上限 ${limit} 屏：本页读了 ${seen.size} 楼，剩余楼层未读，直接进下一帖`;
      log(`⚠️ ${capMsg}`);
      view.alert(capMsg, 'warn');
      return seen.size;
    },

    /** 一步跳到最底，只用于「只求打开过」的场景；返回最终可见的楼层数 */
    async jumpToBottom(doc) {
      const seen = new Set();
      for (let i = 0; i < LIMIT.jumpRounds; i++) {
        if (rt.stopped || !doc) return seen.size;
        const el = doc.scrollingElement || doc.documentElement;
        if (!el) return seen.size;
        const before = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        if (el.scrollTop === before) break;
        if (!(await hold(500))) return seen.size;
      }
      scroll.collectFloors(doc, seen);
      return seen.size;
    },

    /** 按 scrollMode 分派；返回已读楼层数 */
    async apply(doc, win, cfg) {
      let floors = 0;

      if (!cfg.scrollMode || cfg.scrollMode === 'none') {
        const seen = new Set();
        scroll.collectFloors(doc, seen);
        floors = seen.size;
      } else if (cfg.scrollMode === 'jump') {
        floors = await scroll.jumpToBottom(doc);
      } else {
        floors = await scroll.stepwise(doc, win, cfg);
      }

      const nodes = scroll.nodeCount(doc);
      if (!floors && nodes) {
        log(`⚠️ DOM 里有 ${nodes} 个楼层节点，却解析不出楼层号（选择器要更新）`);
      } else if (!floors) {
        log('⚠️ 没找到任何楼层节点：帖子可能还没渲染');
      } else {
        log(`📜 本轮读到 ${floors} 楼（虚拟列表此刻只保留 ${nodes} 个节点在 DOM 里）`);
      }
      return floors;
    },

    /** 取 iframe 的文档；跨源或未就绪时返回 null */
    frameParts(frameEl) {
      try {
        return { doc: frameEl.contentDocument, win: frameEl.contentWindow };
      } catch (e) {
        return { doc: null, win: null };
      }
    }
  };

  /* ════════════════════════════════════════════════════════════════
   * 10. 点赞（只给楼主帖，也就是 1 楼）
   *
   *   只走「点击页面真实按钮」：toggle 语义、CSRF、节流全交给 Discourse
   *   前端自己处理，我们只负责判定当前是否已赞 —— 已赞绝不点，
   *   否则等于取消赞。
   *
   *   ⚠️ 因此只在 iframe / 整页跳转模式生效（需要渲染好的 DOM）；
   *      JSON 速览没有渲染楼层，一律跳过。
   * ════════════════════════════════════════════════════════════════ */
  /* linux.do 装的是 discourse-reactions 插件，不是 Discourse 原生点赞。
   * 实测（未赞态）：
   *   <button class="btn btn-icon btn-toggle-reaction-like ... reaction-button"
   *           title="点赞此帖子">
   *     <svg class="d-icon d-icon-d-unliked"><use href="#far-heart"></use></svg>
   *   </button>
   * 已赞时插件把图标换成实心、按钮多出 reacted 之类的类名，
   * 帖子旁边还会出现 .discourse-reactions-counter。
   * 「再点一次 = 取消赞」，所以判定必须保守：看不清就跳过，绝不猜着点。 */
  const LIKE_SELECTOR = [
    'button.btn-toggle-reaction-like',
    'button.reaction-button',
    'button.toggle-like',
    '.post-controls button[title*="点赞"]',
    '.actions button[title*="点赞"]'
  ].join(', ');

  const liker = {
    lastAt: 0,

    /** 楼主帖元素：优先 post_1 / data-post-number=1 */
    firstPost(doc) {
      if (!doc || !doc.querySelector) return null;
      return (
        doc.querySelector('article[data-post-number="1"]') ||
        doc.querySelector('article#post_1') ||
        doc.querySelector('article[id^="post_"]') ||
        doc.querySelector('.topic-post')
      );
    },

    likeButton(post) {
      if (!post || !post.querySelector) return null;
      return post.querySelector(LIKE_SELECTOR) || post.querySelector('button[title*="点赞"]');
    },

    /** 帖子上的 reactions 计数（插件才有，没有返回 null） */
    counter(post) {
      if (!post || !post.querySelector) return null;
      return post.querySelector('.discourse-reactions-counter');
    },

    countOf(post) {
      const el = liker.counter(post);
      if (!el) return 0;
      const n = parseInt(String(el.textContent || '').replace(/[^\d]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    },

    /** 把按钮上所有能判断「赞没赞」的信号一次读出来 */
    signals(btn) {
      const svg = btn && btn.querySelector ? btn.querySelector('svg') : null;
      const use = svg && svg.querySelector ? svg.querySelector('use') : null;
      const iconClass = String((svg && svg.getAttribute('class')) || '');
      const iconHref = String(
        (use && (use.getAttribute('href') || use.getAttribute('xlink:href'))) || ''
      );
      return {
        iconClass,
        iconHref,
        unlikedIcon: /d-unliked/i.test(iconClass) || /far-heart/i.test(iconHref),
        btnClass: String(btn.className || ''),
        title: String(btn.getAttribute('title') || btn.getAttribute('aria-label') || ''),
        pressed: btn.getAttribute('aria-pressed')
      };
    },

    /** true = 已赞 / false = 未赞 / null = 看不出来（拿不准就别点） */
    likedState(btn) {
      if (!btn) return null;
      const s = liker.signals(btn);
      if (/取消|已赞|unlike/i.test(s.title)) return true;
      if (s.pressed === 'true') return true;
      if (/(^|\s)(has-like|my-likes|liked|reacted)(\s|$)/i.test(s.btnClass)) return true;
      if (s.unlikedIcon) return false;
      if (s.iconHref) return !/far-|unliked/i.test(s.iconHref);
      return null;
    },

    label(state) {
      return {
        liked: '👍 已点赞',
        already: '👍 早就赞过（跳过）',
        'no-button': '⚠️ 找不到点赞按钮',
        'no-doc': '⚠️ 没有渲染文档',
        'chance-skip': '按概率跳过',
        ambiguous: '🤔 状态看不清，保守跳过',
        unknown: '⚠️ 已点击但状态未确认',
        failed: '❌ 点了但状态没变',
        aborted: '已停止',
        disabled: '未启用'
      }[state] || state;
    },

    /**
     * 返回 { state, before, after, count }
     *   liked / already / unknown / failed / ambiguous / no-button / chance-skip / aborted
     */
    async run(doc, cfg) {
      if (!cfg.likeEnabled) return { state: 'disabled' };
      if (!doc) return { state: 'no-doc' };

      if (cfg.likeChance < 100 && Math.random() * 100 >= cfg.likeChance) {
        return { state: 'chance-skip' };
      }

      // 全局点赞最小间隔，避免连续点赞触发风控
      const wait = liker.lastAt + (cfg.likeInterval || 0) - Date.now();
      if (wait > 0 && !(await hold(Math.min(wait, 30000)))) return { state: 'aborted' };

      const post = liker.firstPost(doc);
      const btn = liker.likeButton(post);
      if (!btn) return { state: 'no-button' };

      const before = liker.likedState(btn);
      if (before === true) return { state: 'already' };
      if (before === null) return { state: 'ambiguous' };

      const countBefore = liker.countOf(post);

      try {
        if (post.scrollIntoView) post.scrollIntoView({ block: 'center' });
      } catch (e) {
        /* 滚不动就算了，按钮照样可点 */
      }
      if (!(await hold(400))) return { state: 'aborted' };

      try {
        btn.click();
      } catch (e) {
        return { state: 'failed' };
      }
      liker.lastAt = Date.now();

      // 等前端发完请求并回填状态（Ember 可能重建按钮，重新取一次）
      if (!(await hold(1500))) return { state: 'aborted' };

      const freshPost = liker.firstPost(doc);
      const after = liker.likedState(liker.likeButton(freshPost));
      const countAfter = liker.countOf(freshPost);

      if (after === true) return { state: 'liked', after, countBefore, countAfter };
      if (countAfter > countBefore) return { state: 'liked', after, countBefore, countAfter };
      if (after === false) return { state: 'failed', after, countBefore, countAfter };
      return { state: 'unknown', after, countBefore, countAfter };
    }
  };

  /** 给楼主帖点赞并写日志；点赞成功**就地计数**，不用等这一帖读完 */
  async function likeFirstPost(doc, id, cfg) {
    const info = await liker.run(doc, cfg);
    const extra = info.state === 'ambiguous' ? '（不敢点，怕取消已有赞）' : '';
    log(`👍 /t/${id} 楼主帖：${liker.label(info.state)}${extra}`);
    if (info.state === 'liked' || info.state === 'unknown') session.addLike();
    if (info.state === 'no-button' || info.state === 'failed') {
      view.alert(`点赞失败：${liker.label(info.state)}（/t/${id}）`, 'err');
    }
    return info.state;
  }

  /** 从当前地址取话题 id（整页跳转模式用） */
  function currentTopicId() {
    const m = String(location.pathname || '').match(/\/t\/[^/]+\/(\d+)/);
    return m ? m[1] : '';
  }

  /* ════════════════════════════════════════════════════════════════
   * 9. 会话统计（不跨会话复用）
   *
   *   数据生命周期 = 一个会话（一个标签页）：存 sessionStorage，
   *   整页跳转 / 刷新都还在，关掉标签页即消失。localStorage 只留设置。
   *
   *   统计三项：已读帖子 / 已读评论 / 已点赞
   * ════════════════════════════════════════════════════════════════ */
  const EMPTY_SESSION = { topics: 0, comments: 0, likes: 0, pendingVisit: [] };

  const session = {
    read() {
      const s = store.sget(SKEY.sess, null);
      return Object.assign({}, EMPTY_SESSION, s && typeof s === 'object' ? s : {});
    },

    write(data) {
      store.sset(SKEY.sess, data);
      view.stats(data);
    },

    reset() {
      session.write({ topics: 0, comments: 0, likes: 0, pendingVisit: [] });
    },

    /** 一帖读完：帖子 +1、评论 +floors（点赞由 likeFirstPost 单独计数） */
    addTopic(floors) {
      const s = session.read();
      const addFloor = Math.max(0, Number(floors) || 0);
      s.topics += 1;
      s.comments += addFloor;
      session.write(s);
      log(`📊 +1 帖 / +${addFloor} 楼 → 已读帖子 ${s.topics}，已读评论 ${s.comments}，已点赞 ${s.likes}`);
      return s;
    },

    /** 点赞成功立即 +1，面板与日志同步刷新 */
    addLike() {
      const s = session.read();
      s.likes += 1;
      session.write(s);
      log(`📊 +1 赞 → 已点赞 ${s.likes}`);
      return s;
    },

    /** 浏览计数没确认的帖子，留待手动补记 */
    addPendingVisit(id) {
      const s = session.read();
      if (s.pendingVisit.includes(id)) return;
      s.pendingVisit.push(id);
      if (s.pendingVisit.length > 200) s.pendingVisit.splice(0, s.pendingVisit.length - 200);
      session.write(s);
    },

    /** 补记成功后从未确认列表里摘掉 */
    removePendingVisit(id) {
      const s = session.read();
      const i = s.pendingVisit.indexOf(id);
      if (i < 0) return;
      s.pendingVisit.splice(i, 1);
      session.write(s);
    }
  };

  /* ════════════════════════════════════════════════════════════════
   * 8. iframe 容器
   * ════════════════════════════════════════════════════════════════ */
  const framePane = {
    host() {
      let host = $('frame-host');
      if (!host) {
        host = document.createElement('div');
        host.id = NS + '-frame-host';
        host.style.cssText = [
          'position:fixed', 'top:0', 'right:0', 'width:48vw', 'height:100vh',
          'z-index:999998', 'display:none', 'background:#fff',
          'border-left:1px solid rgba(0,0,0,.18)', 'box-shadow:-6px 0 24px rgba(0,0,0,.16)'
        ].join(';');
        document.body.appendChild(host);
      }
      return host;
    },

    show(on) {
      framePane.host().style.display = on ? 'block' : 'none';
    },

    /**
     * 打开一帖并等它被「读」完。
     * 全程可被暂停/停止打断，返回 { floors, like, aborted }。
     * v2 用一个 (dwell + 屏数×stepDwell + 60) 秒的长 setTimeout 兜底，
     * 默认参数下 = 243 秒，期间点停止完全没反应 —— 现在换成可中断的轮询。
     */
    async open(id, cfg) {
      const host = framePane.host();
      framePane.show(true);
      host.innerHTML = '';

      const frameEl = document.createElement('iframe');
      frameEl.style.cssText = 'width:100%;height:100%;border:0;background:#fff;display:block';
      frameEl.setAttribute('title', 'linux.do 巡览');
      frameEl.src = `/t/${id}/1`;
      host.appendChild(frameEl);

      const parts = () => scroll.frameParts(frameEl);
      const floorsNow = () => {
        const s = new Set();
        scroll.collectFloors(parts().doc, s);
        return s.size;
      };

      // 等 load。超时也往下走：Discourse 的 load 常常早于楼层渲染，
      // 真正该等的是「楼层出现」，下面那一步才是关键。
      //
      // 必须用可中断的 hold() 轮询等，不能裸 await 一个 Promise：
      // iframe 迟迟不触发 load 时，那种写法会让「停止」等到满 loadWait（15 秒）
      // 才生效 —— 真机上实测点停止后 12 秒才退出，正是这个原因。
      let loaded = false;
      frameEl.addEventListener(
        'load',
        () => {
          loaded = true;
        },
        { once: true }
      );
      for (let waited = 0; !loaded && waited < LIMIT.loadWait; waited += LIMIT.pollStep) {
        if (!(await hold(LIMIT.pollStep))) return { floors: 0, like: '', aborted: true };
      }
      if (rt.stopped) return { floors: 0, like: '', aborted: true };

      if (!(await hold(cfg.dwell * 1000))) return { floors: 0, like: '', aborted: true };

      // 等楼层真正渲染出来：v2 不等这一步，DOM 空着就滚，于是静默记 0 楼
      let rendered = floorsNow();
      for (let i = 0; !rendered && i * LIMIT.pollStep < LIMIT.renderWait; i++) {
        if (!(await hold(LIMIT.pollStep))) return { floors: 0, like: '', aborted: true };
        rendered = floorsNow();
      }
      if (!rendered) {
        const noFloor = `/t/${id} 楼层没渲染出来（等了 ${LIMIT.renderWait}ms），本页按 0 楼计`;
        log(`⚠️ ${noFloor}`);
        view.alert(noFloor, 'warn');
      }
      if (rt.stopped) return { floors: rendered, like: '', aborted: true };

      // 楼主帖此刻就在首屏，趁还没滚走先点赞（已赞会自动跳过，不会误取消）
      let like = '';
      if (cfg.likeEnabled) {
        like = await likeFirstPost(parts().doc, id, cfg);
        if (rt.stopped) return { floors: rendered, like, aborted: true };
      }

      const p = parts();
      const floors = await scroll.apply(p.doc, p.win, cfg);
      return { floors, like, aborted: rt.stopped };
    }
  };

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

  /* ════════════════════════════════════════════════════════════════
   * 12. 未读来源
   *   接口：prepare() / peek() → {id} | {done, reason} / onMiss / advance
   * ════════════════════════════════════════════════════════════════ */

  /** /unseen：先把列表整份抓成快照，再逐条消费 */
  function unseenSource(cfg) {
    let queue = store.sget(SKEY.queue, null);

    async function collect() {
      const seen = new Set(); // 只在本次收集内部跨页去重
      const items = []; // { id, at }：at = 发布时间，用来把新帖排在前面
      let path = UNSEEN_PATH;

      for (let page = 1; path && page <= LIMIT.listPages; page++) {
        view.status(`收集未读列表 第 ${page} 页（已有 ${items.length} 帖）`);

        const list = await discourse.listPage(path);
        if (!list) break;

        for (const item of list.topics || []) {
          const id = item && item.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          items.push({ id, at: Date.parse(item.created_at) || 0 });
          if (cfg.maxCollect > 0 && items.length >= cfg.maxCollect) break;
        }

        if (cfg.maxCollect > 0 && items.length >= cfg.maxCollect) {
          log(`已达收集上限 ${cfg.maxCollect} 帖`);
          break;
        }

        const next = list.more_topics_url;
        if (!next) break;
        path = discourse.toJsonPath(next);
        if (!path) break;
        if (!(await hold(cfg.topicInterval))) break;
      }

      // 话题数只对「从没进过」的帖 +1：刚发布的帖子最可能没被点开过，
      // 所以按发布时间从新到旧处理。没有 created_at 时保持原顺序（稳定排序）。
      items.sort((a, b) => b.at - a.at);
      return items.map((x) => x.id);
    }

    return {
      name: 'unseen',

      async prepare() {
        const hasQueue = Array.isArray(queue) && queue.length > 0;

        // 同一轮里队列空了就结束，绝不再去重新收集 ——
        // 否则整页跳转模式每落一页都要 runOnce 一次，就会无限开新轮。
        if (run.read().collected) {
          if (!hasQueue) {
            view.queue(0);
            log('✅ 本轮未读队列已清空，收工');
            return false;
          }
          log(`复用本轮队列，剩余 ${queue.length} 帖`);
          view.queue(queue.length);
          return true;
        }

        if (hasQueue) {
          log(`复用已存队列，剩余 ${queue.length} 帖`);
          view.queue(queue.length);
          run.write({ collected: true });
          return true;
        }

        log('正在收集未读列表…');
        queue = await collect();
        store.sset(SKEY.queue, queue);
        run.write({ collected: true });
        view.queue(queue.length);
        log(`未读列表快照：${queue.length} 帖`);

        if (!queue.length) {
          log('✅ 没有未读帖，收工');
          return false;
        }
        return true;
      },

      peek() {
        if (!queue.length) return { done: true, reason: '✅ 未读队列已清空，收工' };
        return { id: queue[0] };
      },

      onMiss(code) {
        log(`⤵️ /t/${queue[0]} → ${code}，跳过`);
      },

      advance() {
        queue.shift();
        store.sset(SKEY.queue, queue);
        view.queue(queue.length);
      }
    };
  }

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

  /* ════════════════════════════════════════════════════════════════
   * 15. 启动
   * ════════════════════════════════════════════════════════════════ */
  function boot() {
    if (window.__ldtwBooted) return;
    window.__ldtwBooted = true;

    // 先把持久化的运行状态取回内存：整页跳转每帖都会重载页面，
    // 暂停/停止必须跨重载存活，否则下一次导航就把用户的操作抹掉。
    const st = run.read();
    rt.paused = !!st.paused;
    rt.stopped = !!st.running && !!st.stopped;

    // 只建一次：Discourse 是 SPA，路由切换不会销毁面板也不会重载脚本，
    // 因此不需要任何轮询补建 —— 轮询反而会把用户手动关掉的面板复活。
    buildPanel();
    log('已加载。检查参数后点「开始」。');
    syncPauseButton();
    // 上次留下的错误也要能看见：整页跳转会把上一页的告警带过来
    const lastErr = st.lastError;
    if (lastErr && lastErr.text) view.alert(lastErr.text, lastErr.tone);
    if (rt.paused) log('⏸ 上次处于暂停状态，点「▶ 继续」恢复');
    if (rt.stopped) log('⏹ 上次已停止；点「▶ 开始」重新开始');
    resumeHandoff();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

})();

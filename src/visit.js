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
    return info;
  }

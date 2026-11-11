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

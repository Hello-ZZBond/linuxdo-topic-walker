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

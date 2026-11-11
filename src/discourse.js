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

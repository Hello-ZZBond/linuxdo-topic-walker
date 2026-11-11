  /* ════════════════════════════════════════════════════════════════
   * 12. 未读来源
   *   接口：prepare() / peek() → {id} | {done, reason} / onMiss / advance
   * ════════════════════════════════════════════════════════════════ */

  /** /unseen：先把列表整份抓成快照，再逐条消费 */
  function unseenSource(cfg) {
    let queue = store.sget(SKEY.queue, null);

    async function collect() {
      const seen = new Set(); // 只在本次收集内部跨页去重
      const ids = [];
      let path = UNSEEN_PATH;

      for (let page = 1; path && page <= LIMIT.listPages; page++) {
        view.status(`收集未读列表 第 ${page} 页（已有 ${ids.length} 帖）`);

        const list = await discourse.listPage(path);
        if (!list) break;

        for (const item of list.topics || []) {
          const id = item && item.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
          if (cfg.maxCollect > 0 && ids.length >= cfg.maxCollect) break;
        }

        if (cfg.maxCollect > 0 && ids.length >= cfg.maxCollect) {
          log(`已达收集上限 ${cfg.maxCollect} 帖`);
          break;
        }

        const next = list.more_topics_url;
        if (!next) break;
        path = discourse.toJsonPath(next);
        if (!path) break;
        if (!(await hold(cfg.topicInterval))) break;
      }

      return ids;
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

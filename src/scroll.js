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

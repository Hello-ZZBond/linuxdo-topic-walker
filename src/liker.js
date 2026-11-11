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

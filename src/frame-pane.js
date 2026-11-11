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

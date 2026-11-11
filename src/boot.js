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

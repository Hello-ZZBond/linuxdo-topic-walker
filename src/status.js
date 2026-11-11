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

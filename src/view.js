  /* ════════════════════════════════════════════════════════════════
   * 4. DOM 与视图
   * ════════════════════════════════════════════════════════════════ */
  const $ = (id) => document.getElementById(NS + '-' + id);

  const view = {
    text(id, value) {
      const el = $(id);
      if (el) el.textContent = value;
    },
    status(text) {
      view.text('status', text);
    },
    current(id) {
      view.text('cur', id === null || id === undefined ? '-' : String(id));
    },
    queue(n) {
      view.text('queue', String(n));
    },
    /** 三个会话计数一次性刷新 */
    stats(s) {
      view.text('topics', String((s && s.topics) || 0));
      view.text('comments', String((s && s.comments) || 0));
      view.text('likes', String((s && s.likes) || 0));
    },

    /** 面板警示条：level = 'warn'(黄) | 'err'(红)；传空字符串清除 */
    alert(text, level) {
      const el = $('alert');
      const tone = level === 'err' ? 'err' : 'warn';
      if (el) {
        el.className = text ? `${NS}-alert ${tone}` : `${NS}-alert`;
        el.textContent = text || '';
      }
      run.write({ lastError: text ? { text, tone, at: Date.now() } : null });
    }
  };

  /* ── 日志 ── */
  const logBuffer = [];

  function log(message) {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logBuffer.push(`[${stamp}] ${message}`);
    if (logBuffer.length > LIMIT.logKeep) logBuffer.shift();

    const box = $('log');
    if (box) {
      box.textContent = logBuffer.slice(-LIMIT.logShow).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    console.log('[ldtw]', message);
  }

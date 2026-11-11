  /* ════════════════════════════════════════════════════════════════
   * 9. 会话统计（不跨会话复用）
   *
   *   数据生命周期 = 一个会话（一个标签页）：存 sessionStorage，
   *   整页跳转 / 刷新都还在，关掉标签页即消失。localStorage 只留设置。
   *
   *   统计三项：已读帖子 / 已读评论 / 已点赞
   * ════════════════════════════════════════════════════════════════ */
  const EMPTY_SESSION = { topics: 0, comments: 0, likes: 0, pendingVisit: [] };

  const session = {
    read() {
      const s = store.sget(SKEY.sess, null);
      return Object.assign({}, EMPTY_SESSION, s && typeof s === 'object' ? s : {});
    },

    write(data) {
      store.sset(SKEY.sess, data);
      view.stats(data);
    },

    reset() {
      session.write({ topics: 0, comments: 0, likes: 0, pendingVisit: [] });
    },

    /** 一帖读完：帖子 +1、评论 +floors（点赞由 likeFirstPost 单独计数） */
    addTopic(floors) {
      const s = session.read();
      const addFloor = Math.max(0, Number(floors) || 0);
      s.topics += 1;
      s.comments += addFloor;
      session.write(s);
      log(`📊 +1 帖 / +${addFloor} 楼 → 已读帖子 ${s.topics}，已读评论 ${s.comments}，已点赞 ${s.likes}`);
      return s;
    },

    /** 点赞成功立即 +1，面板与日志同步刷新 */
    addLike() {
      const s = session.read();
      s.likes += 1;
      session.write(s);
      log(`📊 +1 赞 → 已点赞 ${s.likes}`);
      return s;
    },

    /** 浏览计数没确认的帖子，留待手动补记 */
    addPendingVisit(id) {
      const s = session.read();
      if (s.pendingVisit.includes(id)) return;
      s.pendingVisit.push(id);
      if (s.pendingVisit.length > 200) s.pendingVisit.splice(0, s.pendingVisit.length - 200);
      session.write(s);
    },

    /** 补记成功后从未确认列表里摘掉 */
    removePendingVisit(id) {
      const s = session.read();
      const i = s.pendingVisit.indexOf(id);
      if (i < 0) return;
      s.pendingVisit.splice(i, 1);
      session.write(s);
    }
  };

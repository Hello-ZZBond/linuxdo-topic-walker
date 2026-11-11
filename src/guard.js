  /* 自己创建的 iframe 内部不再初始化 */
  try {
    if (window.self !== window.top) return;
  } catch (e) {
    return;
  }

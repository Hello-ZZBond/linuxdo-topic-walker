// ==UserScript==
// @name         linux.do 帖子巡览器
// @namespace    https://linux.do/
// @version      3.2.3
// @description  只消费 linux.do 的 /unseen 未读列表：逐帖打开、逐屏滚动计入已读，补发浏览记录，可给楼主帖点赞；统计「已读帖子/已读评论/已点赞」三项，数据只活一个会话。
// @author       PI-Desktop
// @match        https://linux.do/*
// @icon         https://linux.do/uploads/default/original/1X/91c61b570c26eae8bb5e60b0f9b1f0b2ed97e742.png
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计要点
 * ───────────────────────────────────────────────────────────────────────────
 * 1. 为什么用 @grant none + 同源 fetch
 *    linux.do 挂在 Cloudflare 后面，脱离浏览器的裸请求会被 challenge。
 *    脚本跑在页面里，fetch('/t/123.json') 是同源请求，自动带 Cookie 和
 *    cf_clearance。一旦换成 GM_xmlhttpRequest 会脱离页面上下文，反而缺 Cookie。
 *
 * 2. 为什么不需要知道「有多少条评论」
 *    /t/{id}.json 的 highest_post_number 就是楼层上界。逐页累加 post_number，
 *    一旦 >= highest_post_number 即本帖结束。注意 posts_count ≠ 楼层数：
 *    删帖后楼层号会跳号，拿 posts_count 算页数会翻到空页才停。
 *
 * 3. 为什么优先用 /unseen
 *    只列你还没读过的帖子，id 全部有效，不会把额度浪费在大片空洞上。
 *    但读过的帖子会立刻从列表消失，所以必须先把列表整份收集成快照再逐条消费；
 *    边翻页边读会让分页偏移错位，整批漏帖。
 *
 * 4. 为什么必须逐屏滚动
 *    Discourse 的阅读追踪按「每个楼层在视口里累计可见的毫秒数」计算。
 *    一步跳到最底时中间楼层的 msecs 接近 0，服务端不会标记已读。
 *
 * 5. 架构
 *    存储 / 日志 / HTTP / discourse 领域层 / 滚动 / 阅读器策略 /
 *    未读来源 / 运行器 / 面板(声明式) / 记录
 *
 *    未读来源   unseenSource → prepare / peek / advance
 *    阅读器策略 (json | iframe | goto) → read
 *    运行器只做编排，阅读方式按 cfg.mode 选一个 reader。
 *
 * 6. 只做未读
 *    本工具只消费 /unseen，不提供「按 ID 扫描」模式 ——
 *    漫无目的地扫 ID 会撞上大片已删 / 私密空洞，纯属浪费额度。
 *
 * 7. 源码结构
 *    开发时按层拆在 src/（一个文件 = 一层），node build.mjs 拼成这一个
 *    单文件产物。产物可直接粘贴安装；改代码请改 src/ 后重新构建。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * 等价性回归：把同一组场景分别跑在
 *   A. test/fixtures/baseline.user.js（重构前的单文件产物，注入内部对象）
 *   B. src/ 构建出的测试版（build({ expose: true })）
 * 两边返回的结构必须深度相等；不一致就是重构改变了行为。
 *
 * 用法：node test/run.mjs
 */
import assert from 'node:assert/strict';
import { build, EXPOSE, unlistedSources } from '../build.mjs';
import { createEnv, load, instrument, readFixture, json } from './harness.mjs';

const NEW_CODE = build({ expose: true });
const BASE_CODE = instrument(readFixture('baseline.user.js'), EXPOSE);

const scenarios = [
  {
    name: 'unseen-snapshot：先整份收集，再消费',
    async run(api, env) {
      env.onFetch((url) => {
        if (url === '/unseen.json') {
          return json({
            topic_list: {
              topics: [{ id: 101 }, { id: 102 }, { id: 101 }],
              more_topics_url: '/unseen?page=1'
            }
          });
        }
        if (url === '/unseen.json?page=1') {
          return json({ topic_list: { topics: [{ id: 102 }, { id: 103 }] } });
        }
        return json({}, { status: 404 });
      });

      const source = api.unseenSource(api.config.read());
      const prepared = await source.prepare();
      const first = source.peek();
      source.advance();
      const second = source.peek();

      return {
        prepared,
        first,
        second,
        queue: api.store.sget(api.SKEY.queue, null),
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'unseen-empty：没有未读帖就收工',
    async run(api, env) {
      env.onFetch(() => json({ topic_list: { topics: [] } }));
      const source = api.unseenSource(api.config.read());
      const prepared = await source.prepare();
      return {
        prepared,
        queue: api.store.sget(api.SKEY.queue, null),
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'unseen-reuse：本轮队列复用、不再请求 /unseen',
    async run(api, env) {
      env.session.set('ldtw:queue', JSON.stringify([7, 8]));
      env.session.set('ldtw:run', JSON.stringify({ collected: true }));
      const source = api.unseenSource(api.config.read());
      const prepared = await source.prepare();
      return {
        prepared,
        peek: source.peek(),
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'unseen-cap：撞收集上限就停',
    async run(api, env) {
      env.onFetch(() =>
        json({
          topic_list: {
            topics: [{ id: 1 }, { id: 2 }, { id: 3 }],
            more_topics_url: '/unseen?page=1'
          }
        })
      );
      const cfg = { ...api.config.read(), maxCollect: 2 };
      const source = api.unseenSource(cfg);
      const prepared = await source.prepare();
      return {
        prepared,
        queue: api.store.sget(api.SKEY.queue, null),
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'http-429：退避后成功，日志说明第几次',
    async run(api, env) {
      let attempts = 0;
      env.onFetch(() => {
        attempts += 1;
        if (attempts <= 2) return json(null, { status: 429, headers: { 'Retry-After': '3' } });
        return json({ ok: true });
      });
      const res = await api.http('/t/42.json');
      return {
        result: { status: res.status, body: res.body, rateLimited: !!res.rateLimited },
        attempts,
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'http-429：连续超限就放弃并标记限流',
    async run(api, env) {
      env.onFetch(() => json(null, { status: 429, headers: { 'Retry-After': '1' } }));
      const res = await api.http('/t/42.json');
      return {
        result: { status: res.status, body: res.body, rateLimited: !!res.rateLimited },
        requests: env.requests.length,
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'toJsonPath：more_topics_url 规整',
    async run(api) {
      const inputs = ['/unseen?page=1', '/unseen', '/latest.json?page=2', 'https://linux.do/unseen?page=3', '/'];
      return inputs.map((input) => ({ input, path: api.discourse.toJsonPath(input) }));
    }
  },
  {
    name: 'floors：多信号取楼层号 + 到达上限的日志',
    async run(api, env) {
      const nodes = [
        { id: 'post_5', getAttribute: () => null },
        { id: '', getAttribute: (n) => (n === 'data-post-number' ? '7' : null) },
        { id: 'post_5', getAttribute: () => null, className: 'topic-post' },
        { id: '', getAttribute: () => null, className: 'topic-post' }
      ];
      const doc = { querySelectorAll: () => nodes };
      const seen = new Set();
      api.scroll.collectFloors(doc, seen);
      const floors = await api.scroll.apply(doc, null, { ...api.DEFAULTS, scrollMode: 'none' });

      const capped = { querySelectorAll: () => nodes };
      const capResult = await api.scroll.stepwise(capped, null, {
        ...api.DEFAULTS,
        stepDwell: 1,
        maxScreens: 1
      });

      return {
        floorOf: nodes.map((n) => api.scroll.floorOf(n)),
        seen: [...seen].sort((a, b) => a - b),
        nodeCount: api.scroll.nodeCount(doc),
        floors,
        capResult,
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'liker：四信号判定（含「看不清就跳过」）',
    async run(api) {
      const makeButton = ({ title = null, pressed = null, cls = '', svgClass = '', href = '' } = {}) => {
        const use = { getAttribute: (n) => (n === 'href' ? href || null : null) };
        const svg = {
          getAttribute: (n) => (n === 'class' ? svgClass || null : null),
          querySelector: (sel) => (sel === 'use' ? use : null)
        };
        return {
          className: cls,
          getAttribute: (n) => (n === 'title' ? title : n === 'aria-pressed' ? pressed : null),
          querySelector: (sel) => (sel === 'svg' ? svg : null)
        };
      };

      const buttons = {
        cancelled: makeButton({ title: '取消点赞此帖子' }),
        reactedClass: makeButton({ cls: 'btn reacted' }),
        pressed: makeButton({ pressed: 'true' }),
        unlikedIcon: makeButton({ svgClass: 'd-icon d-icon-d-unliked' }),
        farHeart: makeButton({ href: '#far-heart' }),
        solidHeart: makeButton({ href: '#heart' }),
        ambiguous: makeButton()
      };
      const states = Object.fromEntries(
        Object.entries(buttons).map(([key, btn]) => [key, api.liker.likedState(btn)])
      );

      const counter = { textContent: '12 赞' };
      const post = { querySelector: (sel) => (sel === '.discourse-reactions-counter' ? counter : null) };
      return { states, count: api.liker.countOf(post) };
    }
  },
  {
    name: 'like-first-post：未赞才点，点完计数',
    async run(api, env) {
      let counterText = '12';
      const counter = {
        get textContent() {
          return counterText;
        },
        set textContent(value) {
          counterText = value;
        }
      };
      const use = { getAttribute: (n) => (n === 'href' ? '#far-heart' : null) };
      const svg = {
        getAttribute: (n) => (n === 'class' ? 'd-icon d-icon-d-unliked' : null),
        querySelector: () => use
      };
      const btn = {
        className: 'btn btn-toggle-reaction-like',
        getAttribute: (n) => (n === 'title' ? '点赞此帖子' : null),
        querySelector: (sel) => (sel === 'svg' ? svg : null),
        click() {
          btn.className = 'btn btn-toggle-reaction-like reacted';
          counter.textContent = '13';
        }
      };
      const post = {
        querySelector: (sel) => {
          if (sel === '.discourse-reactions-counter') return counter;
          if (sel.includes('btn-toggle-reaction-like')) return btn;
          return null;
        },
        scrollIntoView() {}
      };
      const doc = { querySelector: () => post };

      const cfg = { ...api.DEFAULTS, likeEnabled: true, likeChance: 100, likeInterval: 0 };
      const state = await api.likeFirstPost(doc, '999', cfg);

      // 已赞的帖子：一次都不点
      btn.className = 'btn reacted';
      const already = await api.likeFirstPost(doc, '1000', cfg);

      return {
        state,
        already,
        clicks: state === 'liked' ? 1 : 0,
        likes: api.session.read().likes,
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'panel：构建面板 → 折叠 → 开始（空队列）',
    async run(api, env) {
      env.local.set('ldtw:settings', JSON.stringify({ mode: 'goto', dwell: 5, likeEnabled: false }));
      env.onFetch(() => json({ topic_list: { topics: [] } }));

      api.boot();
      const initial = {
        panel: !!env.doc.getElementById('ldtw-panel'),
        style: !!env.doc.getElementById('ldtw-style'),
        state: env.doc.getElementById('ldtw-state')?.textContent,
        fields: api.readFields(),
        queue: env.doc.getElementById('ldtw-queue')?.textContent,
        stats: ['topics', 'comments', 'likes'].map((k) => env.doc.getElementById(`ldtw-${k}`)?.textContent)
      };

      env.doc.getElementById('ldtw-fold').click();
      const folded = {
        settings: JSON.parse(env.local.get('ldtw:settings')),
        bodyClass: env.doc.getElementById('ldtw-body').className
      };

      env.doc.getElementById('ldtw-start').click();
      const settled = await env.settle(() => !api.rt.active && !api.run.read().running);

      return {
        initial,
        folded,
        settled,
        run: api.run.read(),
        queue: api.store.sget(api.SKEY.queue, null),
        session: api.session.read(),
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  },
  {
    name: 'goto-handoff：落地页接力、按楼层结算',
    async run(api, env) {
      env.local.set(
        'ldtw:settings',
        JSON.stringify({ mode: 'goto', dwell: 1, scrollMode: 'none', likeEnabled: false })
      );
      env.session.set(
        'ldtw:run',
        JSON.stringify({ running: true, currentId: '321', phase: 'handoff', collected: false })
      );
      env.session.set('ldtw:handoff', 'true');
      env.location.pathname = '/t/321/1';
      for (let i = 1; i <= 12; i += 1) {
        const el = env.doc.createElement('article');
        el.id = `post_${i}`;
        env.doc.posts.push(el);
      }
      env.onFetch(() => json({ topic_list: { topics: [] } }));

      api.boot();
      const settled = await env.settle(
        () => !api.run.read().running && env.timeline().some((line) => line.includes('本轮结束'))
      );

      return {
        settled,
        session: api.session.read(),
        run: api.run.read(),
        handoff: api.store.sget(api.SKEY.handoff, 'missing'),
        href: env.location.href,
        requests: env.requests.map((r) => r.url),
        timeline: env.timeline()
      };
    }
  }
];

async function runOne(code, scenario) {
  const env = createEnv();
  const api = load(env, code);
  const result = await scenario.run(api, env);
  return JSON.parse(JSON.stringify(result));
}

function structuralChecks(api) {
  const failures = [];

  const fieldIds = api.FIELDS.map((f) => f.id).sort();
  const configIds = Object.keys(api.DEFAULTS).filter((k) => k !== 'panelFolded').sort();
  if (JSON.stringify(fieldIds) !== JSON.stringify(configIds)) {
    failures.push(`面板字段与 DEFAULTS 不一致：${fieldIds} vs ${configIds}`);
  }
  for (const field of api.FIELDS) {
    if (!(field.id in api.DEFAULTS)) failures.push(`字段 ${field.id} 没有默认值`);
  }

  const readers = Object.keys(api.readers).sort();
  if (JSON.stringify(readers) !== JSON.stringify(['goto', 'iframe'])) {
    failures.push(`阅读器策略应只有 iframe/goto，实际 ${readers}`);
  }

  const missing = unlistedSources();
  if (missing.length) failures.push(`src 模块未进构建：${missing.join(', ')}`);

  if (build().includes('window.__ldtw =')) failures.push('正式产物里泄漏了测试钩子 window.__ldtw');

  return failures;
}

async function main() {
  let failed = 0;

  for (const scenario of scenarios) {
    const base = await runOne(BASE_CODE, scenario);
    const next = await runOne(NEW_CODE, scenario);
    try {
      assert.deepStrictEqual(next, base);
      console.log(`✓ ${scenario.name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${scenario.name}`);
      console.error(`  基线：${JSON.stringify(base).slice(0, 900)}`);
      console.error(`  重构：${JSON.stringify(next).slice(0, 900)}`);
    }
  }
  const env = createEnv();
  const api = load(env, NEW_CODE);
  const failures = structuralChecks(api);
  if (failures.length) {
    failed += failures.length;
    for (const failure of failures) console.error(`✗ 结构检查：${failure}`);
  } else {
    console.log('✓ 结构检查：面板字段 = DEFAULTS、reader 策略、模块清单、产物无测试钩子');
  }

  if (failed) {
    console.error(`\n${failed} 项未通过`);
    process.exit(1);
  }
  console.log(`\n全部通过（${scenarios.length} 个场景 + 结构检查）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

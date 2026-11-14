/**
 * 整页跳转的落地页补发回归。
 *
 * 场景：跳转前那次补发「未确认」（页面卸载 / CF 挑战都可能让请求丢掉），
 * 落地页应自己再补一次，并写回 visitConfirmed。
 */
import assert from 'node:assert/strict';
import { build } from '../build.mjs';
import { createEnv, load, json } from './harness.mjs';

const code = build({ expose: true });

function makeEnv(visitConfirmed) {
  const env = createEnv();
  env.local.set(
    'ldtw:settings',
    JSON.stringify({ mode: 'goto', dwell: 0, scrollMode: 'none', likeEnabled: false, trackVisit: true })
  );
  env.session.set(
    'ldtw:run',
    JSON.stringify({ running: true, currentId: '321', phase: 'handoff', collected: true, visitConfirmed })
  );
  env.session.set('ldtw:handoff', 'true');
  env.location.pathname = '/t/321/1';
  for (let i = 1; i <= 6; i += 1) {
    const el = env.doc.createElement('article');
    el.id = `post_${i}`;
    env.doc.posts.push(el);
  }
  return env;
}

function mockFetch(env, counters) {
  env.onFetch((url) => {
    if (url.endsWith('/pageview')) {
      counters.pageview += 1;
      return json(null, { status: 204 });
    }
    if (url.includes('/t/321.json?track_visit=true')) {
      counters.trackVisit += 1;
      return json({}, { headers: { 'x-discourse-trackview': '1' } });
    }
    if (url.endsWith('/unseen.json')) return json({ topic_list: { topics: [] } });
    return json({});
  });
}

// 1) 未确认 → 落地页补发
{
  const counters = { pageview: 0, trackVisit: 0 };
  const env = makeEnv(false);
  mockFetch(env, counters);
  const api = load(env, code);

  api.boot();
  await env.settle(() => !api.run.read().running && env.timeline().some((l) => l.includes('本轮结束')));
  await env.settle(() => api.run.read().visitConfirmed === true);

  assert.ok(counters.pageview >= 1, '落地页应补发 /pageview');
  assert.ok(counters.trackVisit >= 1, '落地页应补发 track_visit');
  assert.ok(env.timeline().some((l) => l.includes('落地页补发')), '日志应写明落地页补发');
  assert.equal(api.run.read().visitConfirmed, true, '补发后应写回 visitConfirmed');
  assert.deepEqual(
    { topics: api.session.read().topics, comments: api.session.read().comments },
    { topics: 1, comments: 6 }
  );
  console.log('✓ 整页跳转：未确认时落地页补发成功');
}

// 2) 已确认 → 不重复补发
{
  const counters = { pageview: 0, trackVisit: 0 };
  const env = makeEnv(true);
  mockFetch(env, counters);
  const api = load(env, code);

  api.boot();
  await env.settle(() => !api.run.read().running && env.timeline().some((l) => l.includes('本轮结束')));

  assert.equal(counters.pageview, 0, '已确认时不应再发 /pageview');
  assert.equal(counters.trackVisit, 0, '已确认时不应再发 track_visit');
  assert.ok(!env.timeline().some((l) => l.includes('落地页补发')), '不应写落地页补发日志');
  console.log('✓ 整页跳转：已确认时不重复补发');
}

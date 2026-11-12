import { build } from '../build.mjs';
import { createEnv, load, json } from './harness.mjs';

const code = build({ expose: true });

// 1) 关闭「补记浏览数」时应警告
{
  const env = createEnv();
  env.local.set('ldtw:settings', JSON.stringify({ trackVisit: false }));
  env.session.set('ldtw:queue', JSON.stringify([]));
  env.session.set('ldtw:run', JSON.stringify({ collected: true }));
  const api = load(env, code);
  await api.runOnce(false);
  const line = env.timeline().find((l) => l.includes('「补记浏览数」已关闭'));
  if (!line) throw new Error('缺少关闭补记的警告：' + env.timeline().join(' | '));
  console.log('✓ 关闭补记：' + line);
}

// 2) 补发未被确认时应提示话题不会增长
{
  const env = createEnv();
  env.onFetch(() => json({})); // 200，但没有 x-discourse-trackview
  const api = load(env, code);
  const info = await api.trackVisitOnce('123', { ...api.DEFAULTS, trackVisit: true });
  const line = env.timeline().find((l) => l.includes('「浏览话题」不会增长'));
  if (info.state === 'confirmed') throw new Error('意外被确认');
  if (!line) throw new Error('缺少未确认提示：' + env.timeline().join(' | '));
  console.log(`✓ 未确认（${info.state}）：` + line);
}

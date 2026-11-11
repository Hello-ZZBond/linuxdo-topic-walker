/**
 * 时序回归：iframe 迟迟不触发 load 时，点「停止」必须立刻退出。
 *
 * 真机实测（2026-11）：旧实现裸 await 一个 15 秒的 load Promise，停止标记
 * 在这段时间里没人检查 —— 17:40:43 点停止，17:40:55 才退出（12 秒）。
 * 改成 hold() 轮询后，下面这条断言会锁住「≈300ms 内退出」。
 *
 * 用法：node test/stop.mjs
 */
import assert from 'node:assert/strict';
import { build } from '../build.mjs';
import { createEnv, load } from './harness.mjs';

const code = build({ expose: true });

const env = createEnv({ realTimers: true });
const api = load(env, code);

// 这个环境里的 iframe 永远不会触发 load（El 只记录监听器，不派发）
const cfg = { ...api.DEFAULTS, dwell: 0 };
const started = Date.now();
const pending = api.framePane.open('999', cfg);
setTimeout(() => {
  api.rt.stopped = true;
}, 300);

const result = await pending;
const elapsed = Date.now() - started;

assert.equal(result.aborted, true, '停止后 open() 应返回 aborted');
assert.ok(elapsed < 1500, `停止应在约 300ms 内生效，实际 ${elapsed}ms`);
assert.ok(elapsed >= 250, `不应早于停止标记（实际 ${elapsed}ms）`);

console.log(`✓ iframe 加载期间停止：${elapsed}ms 退出（上限 1500ms）`);

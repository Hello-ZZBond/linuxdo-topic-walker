#!/usr/bin/env node
/**
 * 构建脚本：按依赖顺序拼接 src/*.js → linuxdo-topic-walker.user.js
 *
 * 为什么是「拼接」而不是打包器：
 *   - 脚本必须保持单文件（Tampermonkey 直接粘贴安装，@grant none）
 *   - 零依赖、零运行时开销：所有模块共享同一个 IIFE 作用域，和拆分前完全一致
 *   - 模块顺序 = 依赖顺序（`const` 在定义前不可用），下面的 MODULES 就是唯一清单
 *
 * 用法：
 *   node build.mjs           生成脚本
 *   node build.mjs --check   只检查产物是否与 src 同步（不写文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'linuxdo-topic-walker.user.js');

/** 依赖顺序：先常量/存储，再视图/网络/领域层，最后策略、编排、面板、启动 */
export const MODULES = [
  'constants.js',
  'store.js',
  'runtime.js',
  'view.js',
  'status.js',
  'http.js',
  'discourse.js',
  'visit.js',
  'scroll.js',
  'liker.js',
  'session.js',
  'frame-pane.js',
  'readers.js',
  'unseen-source.js',
  'runner.js',
  'panel.js',
  'handoff.js',
  'boot.js'
];

/** 测试构建要暴露的内部对象；正式产物不含这段 */
export const EXPOSE = [
  'NS', 'UNSEEN_PATH', 'KEY', 'SKEY', 'LIMIT', 'DEFAULTS', 'EMPTY_RUN',
  'store', 'config', 'rt', 'run', 'sleep', 'hold', 'syncPauseButton',
  'view', 'logBuffer', 'log', 'http', 'discourse', 'visit', 'trackVisitOnce',
  'scroll', 'framePane', 'session', 'liker', 'likeFirstPost', 'currentTopicId',
  'readers', 'unseenSource', 'runOnce', 'stopRun',
  'FIELDS', 'fieldHtml', 'rowsHtml', 'coerce', 'readFields', 'fillFields',
  'applyFold', 'buildPanel', 'bindFields', 'bindButtons', 'selfCheck',
  'resetSession', 'clearQueue', 'retryVisits', 'resumeHandoff', 'boot'
];

const read = (name) => {
  const file = path.join(SRC_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`缺少模块：src/${name}`);
  return fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
};

/** 生成完整脚本；expose=true 时附带 window.__ldtw（仅供 test/ 使用） */
export function build({ expose = false } = {}) {
  const header = read('header.js').trimEnd();
  const guard = read('guard.js').trimEnd();
  const body = MODULES.map(read).join('\n\n');

  const parts = [
    header,
    '',
    '(function () {',
    "  'use strict';",
    '',
    '  /* ⚠️ 本文件由 src/ 下各模块拼接生成（node build.mjs），不要直接改这里 */',
    '',
    guard,
    '',
    body,
    '',
    expose ? `  /* 测试构建专用：暴露内部对象 */\n  window.__ldtw = {\n    ${EXPOSE.join(', ')}\n  };` : '',
    '})();',
    ''
  ];

  const code = parts.filter((p, i) => !(p === '' && parts[i - 1] === '')).join('\n');
  // 语法自检：只解析不执行，避免把坏产物写进文件
  new vm.Script(code, { filename: OUT_FILE });
  return code;
}

/** src/ 里有但 MODULES 没列出的文件 —— 防止新增模块忘了进构建 */
export function unlistedSources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.js') && name !== 'header.js' && name !== 'guard.js')
    .filter((name) => !MODULES.includes(name));
}

function main() {
  const check = process.argv.includes('--check');
  const missing = unlistedSources();
  if (missing.length) {
    console.error(`✗ 以下模块未加入 MODULES：${missing.join(', ')}`);
    process.exit(1);
  }

  const code = build();
  const lines = code.split('\n').length;

  if (check) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== code) {
      console.error('✗ 产物与 src 不同步：请运行 node build.mjs');
      process.exit(1);
    }
    console.log(`✓ 产物已同步（${MODULES.length} 个模块，${lines} 行）`);
    return;
  }

  fs.writeFileSync(OUT_FILE, code, 'utf8');
  console.log(`✓ 已生成 ${path.basename(OUT_FILE)}：${MODULES.length} 个模块，${lines} 行`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

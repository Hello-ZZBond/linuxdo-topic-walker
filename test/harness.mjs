/**
 * 测试台：给油猴脚本造一个最小浏览器环境（DOM / storage / fetch / 定时器）。
 *
 * 设计目标：同一份场景代码既能跑重构后的 src 构建，也能跑 test/fixtures 里的
 * 旧单文件产物 —— 两边输出必须逐字一致，才谈得上「重构没改行为」。
 *
 * 定时器用微任务模拟：hold()/sleep() 里的等待会立刻返回，但依然走
 * setTimeout → await 的同一条代码路径（不会把暂停/停止逻辑短路掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── 极简 DOM ─────────────────────────────────────────────────────── */

function makeClassList(el) {
  const has = (name) => String(el.className || '').split(/\s+/).filter(Boolean).includes(name);
  return {
    add(name) {
      if (!has(name)) el.className = `${el.className || ''} ${name}`.trim();
    },
    remove(name) {
      el.className = String(el.className || '')
        .split(/\s+/)
        .filter((c) => c && c !== name)
        .join(' ');
    },
    contains: has,
    toggle(name) {
      if (has(name)) this.remove(name);
      else this.add(name);
    }
  };
}

function matches(el, selector) {
  return selector.split(',').some((raw) => {
    let sel = raw.trim();
    if (!sel) return false;

    let tag = '';
    const tagMatch = /^[a-zA-Z][\w-]*/.exec(sel);
    if (tagMatch) {
      tag = tagMatch[0].toLowerCase();
      sel = sel.slice(tag.length);
    }
    if (tag && String(el.tagName || '').toLowerCase() !== tag) return false;

    let rest = sel;
    for (;;) {
      const idMatch = /^#([\w-]+)/.exec(rest);
      if (idMatch) {
        if (el.id !== idMatch[1]) return false;
        rest = rest.slice(idMatch[0].length);
        continue;
      }
      const classMatch = /^\.([\w-]+)/.exec(rest);
      if (classMatch) {
        if (!makeClassList(el).contains(classMatch[1])) return false;
        rest = rest.slice(classMatch[0].length);
        continue;
      }
      const attrMatch = /^\[\s*([\w-]+)\s*(?:(\^?=)\s*"([^"]*)"\s*)?\]/.exec(rest);
      if (attrMatch) {
        const [, name, op, value] = attrMatch;
        const actual = el.getAttribute(name);
        if (actual === null || actual === undefined) return false;
        if (op === '=' && String(actual) !== value) return false;
        if (op === '^=' && !String(actual).startsWith(value)) return false;
        rest = rest.slice(attrMatch[0].length);
        continue;
      }
      break;
    }
    return rest.trim() === '';
  });
}

class El {
  constructor(doc, tag = 'div') {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this._id = '';
    this.className = '';
    this.style = { cssText: '' };
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this._html = '';
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.contentDocument = null;
    this.contentWindow = null;
    this.classList = makeClassList(this);
  }

  get id() {
    return this._id;
  }

  set id(value) {
    this._id = String(value);
    this.ownerDocument.register(this);
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(html) {
    this._html = String(html);
    for (const m of this._html.matchAll(/id="([^"]+)"/g)) {
      const child = this.ownerDocument.createElement('div');
      child.id = m[1];
      child.parent = this;
      this.children.push(child);
    }
  }

  getAttribute(name) {
    if (name === 'id' && this._id) return this._id;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'id') this.id = value;
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    this.ownerDocument.register(child);
    return child;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }

  dispatch(type) {
    for (const fn of this.listeners.get(type) || []) fn({ type, target: this });
  }

  click() {
    this.dispatch('click');
  }

  scrollIntoView() {}

  allDescendants(out = []) {
    for (const child of this.children) {
      out.push(child);
      child.allDescendants(out);
    }
    return out;
  }

  querySelectorAll(selector) {
    return this.allDescendants().filter((el) => matches(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class Doc {
  constructor() {
    this.byId = new Map();
    this.posts = [];
    this.metas = new Map();
    this.readyState = 'loading';
    this.referrer = '';
    this.html = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement = this.html;
    this.scrollingElement = this.html;
    this.listeners = new Map();
  }

  createElement(tag) {
    return new El(this, tag);
  }

  register(el) {
    if (el && el.id) this.byId.set(el.id, el);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  querySelectorAll(selector) {
    const meta = /^meta\[name="([^"]+)"\]$/.exec(selector.trim());
    if (meta) {
      const value = this.metas.get(meta[1]);
      if (value === undefined) return [];
      const el = this.createElement('meta');
      el.setAttribute('name', meta[1]);
      el.content = value;
      return [el];
    }
    if (/article|topic-post/.test(selector) && this.posts.length) {
      return this.posts.filter((el) => matches(el, selector));
    }
    const pool = [
      this.html,
      this.head,
      this.body,
      ...this.byId.values(),
      ...this.html.allDescendants(),
      ...this.head.allDescendants(),
      ...this.body.allDescendants()
    ];
    return [...new Set(pool)].filter((el) => matches(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/* ── 响应与运行环境 ───────────────────────────────────────────────── */

function response({ status = 200, body = null, headers = {}, jsonThrows = false } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body;
    }
  };
}

export const json = (body, init = {}) => response({ body, ...init });

function storage(map, log) {
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
      log.push(`set ${key}`);
    },
    removeItem(key) {
      map.delete(key);
    }
  };
}

export function createEnv({ realTimers = false } = {}) {
  // 默认用微任务模拟定时器（快）；realTimers 用于测量「停止要多快生效」这类时序
  const timer = realTimers
    ? (fn, ms) => setTimeout(fn, ms)
    : (fn) => {
        queueMicrotask(fn);
        return 1;
      };
  const clearTimer = realTimers ? (id) => clearTimeout(id) : () => {};
  const doc = new Doc();
  const local = new Map();
  const session = new Map();
  const logs = [];
  const alerts = [];
  const requests = [];
  let handler = () => json({});

  const location = {
    origin: 'https://linux.do',
    href: 'https://linux.do/unseen',
    pathname: '/unseen',
    search: ''
  };

  const win = {
    innerHeight: 900,
    document: doc,
    location,
    addEventListener() {},
    setTimeout: timer,
    clearTimeout: clearTimer
  };
  win.self = win;
  win.top = win;

  const ctx = {
    window: win,
    document: doc,
    location,
    localStorage: storage(local, logs),
    sessionStorage: storage(session, logs),
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
      return Promise.resolve(handler(String(url), init));
    },
    console: { log: (...args) => logs.push(args.join(' ')) },
    crypto: { randomUUID: () => 'test-uuid' },
    alert: (msg) => alerts.push(String(msg)),
    confirm: () => true,
    setTimeout: timer,
    clearTimeout: clearTimer
  };
  vm.createContext(ctx);
  win.__logs = logs;

  return {
    ctx,
    doc,
    local,
    session,
    logs,
    alerts,
    requests,
    location,
    onFetch(fn) {
      handler = fn;
    },
    /** 归一化日志：去掉时间戳，保留内容与顺序 */
    timeline() {
      return logs
        .filter((line) => line.startsWith('[ldtw]'))
        .map((line) => line.replace(/^\[ldtw\]\s*/, '').replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, ''));
    },
    /** 等异步流程跑完（微任务定时器 + 轮询） */
    async settle(check, { rounds = 400 } = {}) {
      for (let i = 0; i < rounds; i++) {
        if (check && check()) return true;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return check ? check() : true;
    }
  };
}

export function load(env, code) {
  vm.runInContext(code, env.ctx, { filename: 'userscript.js' });
  return env.ctx.window.__ldtw;
}

/** 给旧单文件产物注入 window.__ldtw（与测试构建的暴露清单一致） */
export function instrument(code, names) {
  const marker = '\n})();';
  const at = code.lastIndexOf(marker);
  if (at < 0) throw new Error('基线产物末尾找不到 IIFE 结束标记');
  return `${code.slice(0, at)}\n  window.__ldtw = { ${names.join(', ')} };\n})();\n`;
}

export function readFixture(name) {
  return fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
}

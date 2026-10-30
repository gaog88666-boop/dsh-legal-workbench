/**
 * 客户端模块冒烟：用最小 React / Slots / window 桩跑一遍 factory 与 apply，
 * 抓装配期异常（槽位注册、tab 类型注册、模块顶层语法/引用错误）。
 *
 * 注意：这只能证明"装配不炸 + 三个槽位都注册了"，
 * 证明不了渲染结果好不好看——那需要真浏览器。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { createReporter } from './helpers.mjs'

const { check, report } = createReporter('client-smoke')

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

/** 最小 React 替身：够用来跑通 bundle 装配，不模拟真实渲染。 */
class StubComponent {
  constructor(props) {
    this.props = props ?? {}
    this.state = {}
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
  }
}

const React = {
  Component: StubComponent,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let loaded = null
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {} }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  },
  encodeURIComponent,
  decodeURIComponent,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

check('__ModuleLoader__.load 被调用', loaded !== null)
check('模块 id 正确', loaded.id === 'dsh-legal-workbench', loaded.id)

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('factory 返回 apply', typeof plugin.apply === 'function')
check('inject 声明存在', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

const registered = []
const ctx = {
  locale: {
    subscribe: () => () => {},
    getSnapshot: () => ({ locale: 'zh' }),
    getLocale: () => ({ locale: 'zh' }),
  },
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (name, callback) => {
      const dispose = callback()
      registered.push(name)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options) => {
      registered.push(options.name + ':' + (options.id ?? options.key))
      return () => {}
    },
    spec: () => ({ kind: 'keyed' }),
  },
  sessions: { scope: () => undefined },
  inject: () => {},
}

plugin.apply(ctx)

check('注册了会话头部按钮', registered.includes('conversation.session.header.actions:dsh-workbench'))
check('注册了新会话入口', registered.includes('conversation.hero.options:dsh-workbench'))
// 侧栏回归：面板崩溃曾把整条右栏带走（根因是面板里误用了录音卡的 sessionRef，已修）。
// 现在侧栏与浮层并存：能放侧栏就放侧栏，放不进就浮层，且标签类型回调都带 try/catch。
check('注册了右侧栏正文位', registered.includes('sidebar.right.pane.tab:dsh-workbench.panel'))
// ⌥W 全屏工作台走官方 shell.overlay 槽位，不依赖侧栏
check('注册了全屏浮层槽位', registered.includes('shell.overlay:dsh-workbench-full'))

assert.ok(report())

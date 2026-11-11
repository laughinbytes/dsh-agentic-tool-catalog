#!/usr/bin/env node
/** verify-presentation.mjs — 发布前检查展示身份文件（locale/icon/detail/files）。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))
const pkg = read('package.json')
const en = read('locale/en.json')
const zh = read('locale/zh.json')
const problems = []
const check = (ok, label) => { if (!ok) problems.push(label) }

check(pkg.name === 'dsh-agentic-tool-catalog', 'package name is dsh-agentic-tool-catalog')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch declared')
check(pkg.icon === './icon.svg' && existsSync(join(ROOT, 'icon.svg')), 'icon.svg present and declared')
check(typeof en.meta?.title === 'string' && en.meta.title.length > 0, 'locale/en meta.title')
check(typeof zh.meta?.title === 'string' && zh.meta.title.length > 0, 'locale/zh meta.title')
check(en.meta?.detail === 'docs/detail.md' && zh.meta?.detail === 'docs/detail.zh.md', 'bilingual detail docs')
check(existsSync(join(ROOT, 'docs', 'detail.md')) && existsSync(join(ROOT, 'docs', 'detail.zh.md')), 'detail markdown present')
check(existsSync(join(ROOT, 'docs', 'detail-hero.svg')), 'hero visual present')
check(existsSync(join(ROOT, 'README.md')) && existsSync(join(ROOT, 'README.zh.md')), 'bilingual READMEs present')
check(existsSync(join(ROOT, 'LICENSE')), 'LICENSE present')

const included = (file) => (pkg.files ?? []).some((pattern) => {
  if (pattern === file) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(file)
})
for (const file of ['icon.svg', 'locale/en.json', 'locale/zh.json', 'docs/detail.md', 'docs/detail.zh.md', 'docs/detail-hero.svg', 'docs/detail-benchmark.svg', 'docs/data-card.md']) {
  check(included(file), `files includes ${file}`)
}

if (problems.length > 0) {
  console.error('✗ presentation problems:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('presentation ok')

#!/usr/bin/env node
/**
 * verify.mjs — 能力发现 benchmark 的**独立核验**（不采信模型自述）。
 *
 * 核验对象 = run.mjs begin 创建的实验工作目录里的产出文件。
 * 与模型回答正确性分开：pass/fail 只看文件内容断言；会话日志里的"走了哪条能力路径"由 metrics.mjs 统计。
 *
 * 用法：
 *   node benchmark/discovery/verify.mjs --task <task-id> --workdir <实验目录>
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)

export function loadTasks(tasksPath = join(HERE, 'tasks.json')) {
  return JSON.parse(readFileSync(tasksPath, 'utf8'))
}

function checkFile(workdir, spec) {
  const path = resolve(workdir, spec.path)
  const checks = []
  const push = (ok, label, detail) => checks.push({ ok, label, detail })
  if (!existsSync(path)) {
    push(false, `${spec.path} 存在`, '文件不存在')
    return checks
  }
  const text = readFileSync(path, 'utf8')
  push(true, `${spec.path} 存在`)
  if (spec.regex !== undefined) {
    const ok = new RegExp(spec.regex).test(text)
    push(ok, `${spec.path} 匹配 /${spec.regex}/`, ok ? '' : `实际内容：${text.slice(0, 200)}`)
  }
  if (spec.contains !== undefined) {
    const ok = text.includes(spec.contains)
    push(ok, `${spec.path} 包含 "${spec.contains}"`)
  }
  if (spec.notContains !== undefined) {
    const ok = !text.includes(spec.notContains)
    push(ok, `${spec.path} 不包含 "${spec.notContains}"`)
  }
  if (spec.minLines !== undefined) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    push(lines.length >= spec.minLines, `${spec.path} 至少 ${spec.minLines} 行（实际 ${lines.length}）`)
  }
  return checks
}

/**
 * 核验一个任务。
 * @param task - tasks.json 任务对象。
 * @param workdir - 实验工作目录。
 * @returns {{ok: boolean, checks: Array<{ok: boolean, label: string, detail?: string}>}}
 */
export function verifyTask(task, workdir) {
  const checks = []
  for (const file of task.verify?.files ?? []) checks.push(...checkFile(workdir, file))
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks }
}

function main() {
  const argv = process.argv.slice(2)
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const taskId = get('--task')
  const workdir = get('--workdir')
  if (!taskId || !workdir) {
    console.error('用法：node benchmark/discovery/verify.mjs --task <task-id> --workdir <实验目录>')
    process.exit(2)
  }
  const db = loadTasks()
  const task = db.tasks.find((t) => t.id === taskId)
  if (!task) {
    console.error(`tasks.json 里没有任务：${taskId}`)
    process.exit(2)
  }
  const result = verifyTask(task, workdir)
  for (const c of result.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log(result.ok ? '\n核验通过' : '\n核验失败')
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('verify.mjs')) main()

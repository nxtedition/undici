'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

const script = join(__dirname, '..', 'scripts', 'check-release-branch.js')

function git (cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// A throwaway clone of a throwaway origin, with one commit on master.
function setup (t) {
  const root = mkdtempSync(join(tmpdir(), 'undici-release-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, 'init', '--quiet', '--bare', '--initial-branch=master', origin)
  git(root, 'clone', '--quiet', origin, work)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'test')
  git(work, 'config', 'commit.gpgsign', 'false')
  git(work, 'checkout', '--quiet', '-b', 'master')
  writeFileSync(join(work, 'package.json'), '{}\n')
  git(work, 'add', 'package.json')
  git(work, 'commit', '--quiet', '--no-verify', '-m', 'init')
  git(work, 'push', '--quiet', 'origin', 'master')
  return work
}

function check (cwd) {
  const { status, stderr } = spawnSync(process.execPath, [script, cwd], { encoding: 'utf8' })
  return { status, stderr }
}

test('release guard passes on a clean master that matches origin', (t) => {
  const work = setup(t)
  assert.deepEqual(check(work), { status: 0, stderr: '' })
})

test('release guard rejects another branch', (t) => {
  const work = setup(t)
  git(work, 'checkout', '--quiet', '-b', 'feature')
  const { status, stderr } = check(work)
  assert.equal(status, 1)
  assert.match(stderr, /cut from master, not feature/)
})

test('release guard rejects uncommitted changes', (t) => {
  const work = setup(t)
  writeFileSync(join(work, 'package.json'), '{"version":"1.0.0"}\n')
  const { status, stderr } = check(work)
  assert.equal(status, 1)
  assert.match(stderr, /uncommitted changes/)
})

test('release guard rejects a master that is not origin/master', (t) => {
  const work = setup(t)
  git(work, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'local only')
  const { status, stderr } = check(work)
  assert.equal(status, 1)
  assert.match(stderr, /is not origin\/master/)
})

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

function check (cwd, ...flags) {
  const { status, stderr } = spawnSync(process.execPath, [script, ...flags, cwd], { encoding: 'utf8' })
  return { status, stderr }
}

// What `npm version 1.0.1` leaves behind: a commit bumping package.json on top
// of origin/master, tagged v1.0.1, not pushed yet.
function versionCommit (work, { tag = 'v1.0.1', extraFile } = {}) {
  writeFileSync(join(work, 'package.json'), '{"version":"1.0.1"}\n')
  git(work, 'add', 'package.json')
  if (extraFile) {
    writeFileSync(join(work, extraFile), 'x\n')
    git(work, 'add', extraFile)
  }
  git(work, 'commit', '--quiet', '--no-verify', '-m', '1.0.1')
  if (tag) {
    git(work, 'tag', '-a', tag, '-m', '1.0.1')
  }
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

test('publishing accepts the tagged version commit npm version just made', (t) => {
  const work = setup(t)
  versionCommit(work)
  assert.deepEqual(check(work, '--publish'), { status: 0, stderr: '' })
})

test('versioning still requires HEAD to be origin/master', (t) => {
  const work = setup(t)
  versionCommit(work)
  const { status, stderr } = check(work)
  assert.equal(status, 1)
  assert.match(stderr, /is not origin\/master/)
})

test('publishing rejects an untagged version commit', (t) => {
  const work = setup(t)
  versionCommit(work, { tag: null })
  const { status, stderr } = check(work, '--publish')
  assert.equal(status, 1)
  assert.match(stderr, /nor a tagged version commit/)
})

test('publishing rejects a tag that does not match package.json', (t) => {
  const work = setup(t)
  versionCommit(work, { tag: 'v9.9.9' })
  assert.equal(check(work, '--publish').status, 1)
})

test('publishing rejects a version commit that changes other files', (t) => {
  const work = setup(t)
  versionCommit(work, { extraFile: 'index.js' })
  assert.equal(check(work, '--publish').status, 1)
})

test('publishing rejects a version commit that is not directly on origin/master', (t) => {
  const work = setup(t)
  git(work, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'local only')
  versionCommit(work)
  assert.equal(check(work, '--publish').status, 1)
})

'use strict'

// Run by `npm version` (preversion) and `npm publish` (prepublishOnly, with
// --publish): releases are cut and published only from a clean master that
// matches origin/master. 12.0.7 and 12.0.8 were bumped, tagged and published
// from a feature branch, so npm's `latest` missed everything merged on master.
//
// Publishing also accepts the commit `npm version` just created, so the usual
// `npm version X && npm publish && git push --follow-tags` works: its parent
// must be origin/master, it may only touch package files, and it must carry
// the v<version> tag.

const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(2)
const publishing = args.includes('--publish')
const cwd = args.find((arg) => !arg.startsWith('--')) || process.cwd()

const VERSION_COMMIT_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json'])

function git (...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * @param {string} upstream origin/master
 * @returns {boolean} whether HEAD is the version commit `npm version` makes
 */
function isVersionCommit (upstream) {
  if (git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')[1] !== upstream) {
    return false
  }

  const files = git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n')
  if (!files.includes('package.json') || !files.every((file) => VERSION_COMMIT_FILES.has(file))) {
    return false
  }

  const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  return git('tag', '--points-at', 'HEAD').split('\n').includes(`v${version}`)
}

function check () {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'master') {
    return `releases are cut from master, not ${branch}`
  }

  if (git('status', '--porcelain', '--untracked-files=no') !== '') {
    return 'the working tree has uncommitted changes'
  }

  git('fetch', '--quiet', 'origin', 'master')
  const head = git('rev-parse', 'HEAD')
  const upstream = git('rev-parse', 'origin/master')
  if (head === upstream) {
    return null
  }

  if (publishing && isVersionCommit(upstream)) {
    return null
  }

  return publishing
    ? `HEAD (${head.slice(0, 8)}) is neither origin/master (${upstream.slice(0, 8)}) nor a tagged version commit on top of it`
    : `HEAD (${head.slice(0, 8)}) is not origin/master (${upstream.slice(0, 8)}); pull or merge first`
}

const problem = check()
if (problem) {
  console.error(`release check failed: ${problem}`)
  process.exitCode = 1
}

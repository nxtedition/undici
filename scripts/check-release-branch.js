'use strict'

// Run by `npm version` (preversion) and `npm publish` (prepublishOnly):
// releases are cut and published only from a clean master that matches
// origin/master. 12.0.7 and 12.0.8 were bumped, tagged and published from a
// feature branch, so npm's `latest` missed everything merged on master.

const { execFileSync } = require('node:child_process')

const cwd = process.argv[2] || process.cwd()

function git (...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
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
  if (head !== upstream) {
    return `HEAD (${head.slice(0, 8)}) is not origin/master (${upstream.slice(0, 8)}); pull or merge first`
  }

  return null
}

const problem = check()
if (problem) {
  console.error(`release check failed: ${problem}`)
  process.exitCode = 1
}

'use strict'

// Framework integration scenarios (see test/frameworks.js), using the Node.js runtime.
// The same scenarios run using the Bun runtime through `bun test` (test/frameworks.test.js).
// Usage: node test/node-frameworks.js

const { frameworks, scenarios, knownIssue, run } = require('./frameworks')

// a hanging scenario (i.e: a request never answered) fails instead of blocking the run
const SCENARIO_TIMEOUT = 10000

const withTimeout = (promise) => {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${SCENARIO_TIMEOUT}ms`)), SCENARIO_TIMEOUT)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const main = async () => {
  if (process.versions.bun) {
    throw new Error('This script checks the Node.js runtime, run it using node (Bun runs these scenarios using bun test)')
  }

  const counts = { passed: 0, expected: 0, failed: 0 }
  for (const framework of frameworks) {
    for (const scenario of scenarios) {
      const issue = knownIssue(framework, scenario)
      const label = `${framework.name} > ${scenario.name}`
      let error = null
      try {
        await withTimeout(run(framework, scenario))
      } catch (err) {
        error = err
      }

      if (!issue && !error) {
        counts.passed++
        console.log(`  ok     ${label}`)
      } else if (issue && error) {
        // known library issue, see knownIssues in test/frameworks.js
        counts.expected++
        console.log(`  xfail  ${label}\n         ${issue}\n         ${error.message.split('\n')[0]}`)
      } else {
        counts.failed++
        console.log(`  FAIL   ${label}`)
        console.log(error || new Error(`Known issue no longer reproduces, update knownIssues: ${issue}`))
      }
    }
  }

  console.log(`Node.js ${process.version}: ${counts.passed} passed, ${counts.expected} expected failures (known issues), ${counts.failed} failed`)
  if (counts.failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

'use strict'

// Framework integration scenarios (see test/frameworks.js), using the Bun runtime.
// The same scenarios run using the Node.js runtime through test/node-frameworks.js.

const { describe, it } = require('bun:test')
const { frameworks, scenarios, knownIssue, run } = require('./frameworks')

for (const framework of frameworks) {
  describe(`framework integration: ${framework.name}`, () => {
    for (const scenario of scenarios) {
      // known library issues keep asserting the expected behavior, as expected failures
      const test = knownIssue(framework, scenario) ? it.failing : it
      test(scenario.name, () => run(framework, scenario))
    }
  })
}

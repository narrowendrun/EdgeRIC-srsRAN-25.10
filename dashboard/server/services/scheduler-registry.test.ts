import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { projectRoot } from '../config.js'
import { SCHEDULING_ALGORITHMS } from '../scheduler-registry.js'

/**
 * The muApp looks the Redis value up in its own `algorithm_mapping` and, on a miss, prints
 * "Unknown algorithm" and idles. Drift between that dictionary and our list is therefore silent
 * and only shows up as a scheduler that quietly does nothing.
 */
const muappPath = path.join(projectRoot, 'edgeric', 'muapp-scheduling', 'scheduling_muapp.py')

describe('scheduler registry', { skip: existsSync(muappPath) ? false : 'scheduling_muapp.py not found' }, () => {
  test('matches algorithm_mapping in scheduling_muapp.py exactly', () => {
    const source = readFileSync(muappPath, 'utf8')
    const block = /algorithm_mapping\s*=\s*\{([\s\S]*?)\}/.exec(source)
    assert.ok(block, 'could not find algorithm_mapping in scheduling_muapp.py')
    const names = [...block[1].matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1])
    assert.ok(names.length > 0, 'parsed no algorithm names')
    assert.deepEqual([...SCHEDULING_ALGORITHMS].sort(), names.sort(),
      'the dashboard offers a different set of algorithms than the muApp implements; ' +
      'an unrecognised value makes the muApp idle silently')
  })
})

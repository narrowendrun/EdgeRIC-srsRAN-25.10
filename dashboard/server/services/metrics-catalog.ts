import { readFileSync } from 'node:fs'
import path from 'node:path'
import { projectRoot } from '../config.js'

function fieldsFromProto(file: string) {
  const content = readFileSync(path.join(projectRoot, 'edgeric', 'protobufs', file), 'utf8')
  const messages: Array<{ name: string; fields: Array<{ name: string; type: string; repeated: boolean; description: string }> }> = []
  const matcher = /message\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let messageMatch: RegExpExecArray | null
  while ((messageMatch = matcher.exec(content))) {
    const fields = []
    for (const line of messageMatch[2].split('\n')) {
      const match = line.match(/^\s*(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+\s*;\s*(?:\/\/\s*(.*))?$/)
      if (match) fields.push({ repeated: Boolean(match[1]), type: match[2], name: match[3], description: match[4] || '' })
    }
    messages.push({ name: messageMatch[1], fields })
  }
  return messages
}

// The .proto files cannot change without a restart, so parse once.
let cached: ReturnType<typeof build> | null = null

function build() {
  return {
    published: [{
      endpoint: 'ipc:///tmp/metrics_data', transport: 'ZMQ PUB', rootMessage: 'TtiMetrics',
      note: 'The gNB publishes through a bounded, non-conflated queue; message and HARQ sequence gaps make subscriber loss observable.',
      messages: fieldsFromProto('metrics.proto').filter((message) => !message.name.includes('Legacy')),
    }],
    subscribed: [
      { endpoint: 'ipc:///tmp/control_weights', transport: 'ZMQ SUB', rootMessage: 'SchedulingWeights', messages: fieldsFromProto('control_weights.proto') },
      { endpoint: 'ipc:///tmp/control_mcs', transport: 'ZMQ SUB', rootMessage: 'McsControl', messages: fieldsFromProto('control_mcs.proto') },
    ],
  }
}

export function metricsCatalog() {
  if (!cached) cached = build()
  return cached
}

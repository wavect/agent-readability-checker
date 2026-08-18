import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHECKER_VERSION,
  GRADES,
  INPUT_KINDS,
  LIMITATIONS,
  RETRIEVAL_AGENTS,
  SCHEMA_VERSION,
  TRAINING_AGENTS,
  checkAgentReadability,
  detectInputKind,
  gradeFor,
} from '../src/agent-readability-core.js'

const ruleIds = report => report.findings.map(finding => finding.ruleId)

function checkFixture(text, options) {
  return checkAgentReadability(text, options)
}

test('input kinds are detected from shape alone', () => {
  assert.equal(detectInputKind('User-agent: *\nDisallow: /private/'), INPUT_KINDS.robots)
  assert.equal(detectInputKind('<!doctype html><html lang="en"><head></head></html>'), INPUT_KINDS.html)
  assert.equal(
    detectInputKind('# Wavect\n\n> Product engineering.\n\n## Docs\n\n- [A](https://wavect.io/a): one\n- [B](https://wavect.io/b): two\n'),
    INPUT_KINDS.llms,
  )
  assert.equal(detectInputKind('# A page\n\nProse that runs on for a while without any link bullets at all.'), INPUT_KINDS.markdown)
})

test('empty input is rejected rather than scored', () => {
  assert.throws(() => checkAgentReadability('   \n  '), error => error.code === 'empty-input')
})

test('the retrieval and training agent lists do not overlap', () => {
  const overlap = RETRIEVAL_AGENTS.filter(agent => TRAINING_AGENTS.includes(agent))
  assert.deepEqual(overlap, [], 'an agent cannot be both a retrieval fetcher and a training-only crawler')
})

test('blocking an answer-engine fetcher is critical', () => {
  const report = checkFixture('User-agent: OAI-SearchBot\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.equal(report.inputKind, INPUT_KINDS.robots)
  assert.ok(ruleIds(report).includes('AR102'))
  const blocked = report.findings.find(finding => finding.ruleId === 'AR102')
  assert.equal(blocked.severity, 'critical')
  assert.match(blocked.evidence, /oai-searchbot/i)
})

test('blocking training crawlers alone is reported as a licensing choice, never a failure', () => {
  const report = checkFixture('User-agent: GPTBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  const ids = ruleIds(report)
  assert.ok(ids.includes('AR104'), 'the training block is surfaced')
  assert.ok(!ids.includes('AR102'), 'no retrieval fetcher was blocked')
  assert.ok(!ids.includes('AR103'), 'no wildcard disallow was present')
  const training = report.findings.find(finding => finding.ruleId === 'AR104')
  assert.equal(training.severity, 'low')
  assert.equal(report.grade, GRADES.legible, 'opting out of training must not sink the grade')
})

test('a wildcard disallow is critical because retrieval fetchers inherit it', () => {
  const report = checkFixture('User-agent: *\nDisallow: /\n')
  assert.ok(ruleIds(report).includes('AR103'))
  assert.equal(report.findings.find(finding => finding.ruleId === 'AR103').severity, 'critical')
})

test('the wildcard remediation does not argue against its own severity', () => {
  // With every known fetcher explicitly allowed, "0 are blocked by inheritance"
  // would undercut the critical finding it belongs to.
  const groups = RETRIEVAL_AGENTS.map(agent => `User-agent: ${agent}\nAllow: /\n`).join('\n')
  const report = checkFixture(`${groups}\nUser-agent: *\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n`)
  const wildcard = report.findings.find(item => item.ruleId === 'AR103')
  assert.ok(wildcard, 'the wildcard block is still critical')
  assert.equal(wildcard.severity, 'critical')
  assert.ok(!/\b0 of the\b/.test(wildcard.remediation), 'must not claim zero fetchers are affected')
  assert.match(wildcard.remediation, /does not name/)

  // The common case still counts and names examples.
  const bare = checkFixture('User-agent: *\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  const counted = bare.findings.find(item => item.ruleId === 'AR103')
  assert.match(counted.remediation, new RegExp(`${RETRIEVAL_AGENTS.length} of the retrieval fetchers`))
  assert.match(counted.remediation, /oai-searchbot/)
})

test('an allow-all override cancels the blanket disallow', () => {
  const report = checkFixture('User-agent: *\nDisallow: /\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(!ruleIds(report).includes('AR103'))
})

test('consecutive user-agent lines share one rule block', () => {
  const report = checkFixture('User-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /\n')
  const blocked = report.findings.find(finding => finding.ruleId === 'AR102')
  assert.match(blocked.evidence, /oai-searchbot/i)
  assert.match(blocked.evidence, /perplexitybot/i)
})

// RFC 9309 2.2.1: when the same user-agent token appears in more than one group,
// the rules of all those groups are merged and treated as one group. Evaluating
// only the last group let a later narrow rule mask an earlier blanket disallow,
// which is a false negative on the check this tool exists to make.
test('duplicate groups for one agent are merged, not overwritten', () => {
  const report = checkFixture([
    'User-agent: OAI-SearchBot',
    'Disallow: /',
    '',
    'User-agent: OAI-SearchBot',
    'Disallow: /private',
    '',
    'Sitemap: https://example.com/sitemap.xml',
    '',
  ].join('\n'))
  const blocked = report.findings.find(finding => finding.ruleId === 'AR102')
  assert.ok(blocked, 'the earlier Disallow: / must still be seen')
  assert.equal(blocked.severity, 'critical')
})

test('merging is order independent', () => {
  const narrowFirst = checkFixture('User-agent: PerplexityBot\nDisallow: /private\n\nUser-agent: PerplexityBot\nDisallow: /\n')
  const blanketFirst = checkFixture('User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /private\n')
  assert.ok(ruleIds(narrowFirst).includes('AR102'))
  assert.ok(ruleIds(blanketFirst).includes('AR102'))
})

test('every wildcard group is merged, not just the first', () => {
  const report = checkFixture('User-agent: *\nDisallow: /admin\n\nUser-agent: *\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(ruleIds(report).includes('AR103'), 'a later wildcard Disallow: / must be seen')
})

test('an Allow in a duplicate group still cancels the blanket disallow', () => {
  const report = checkFixture('User-agent: *\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(!ruleIds(report).includes('AR103'), 'merged rules include the Allow override')
})

test('duplicate training groups merge too', () => {
  const report = checkFixture('User-agent: GPTBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /docs\n\nSitemap: https://example.com/sitemap.xml\n')
  const training = report.findings.find(finding => finding.ruleId === 'AR104')
  assert.ok(training, 'the blanket training block must still be seen')
  assert.equal(training.severity, 'low')
})

test('crawl-delay ends a group, so the next user-agent starts a new one', () => {
  // Otherwise the following agent's Disallow: / is attributed to this one, which
  // reports a retrieval fetcher as blocked when it is not.
  const report = checkFixture([
    'User-agent: OAI-SearchBot',
    'Crawl-delay: 5',
    'User-agent: SomeOtherBot',
    'Disallow: /',
    '',
    'Sitemap: https://example.com/sitemap.xml',
    '',
  ].join('\n'))
  assert.ok(!ruleIds(report).includes('AR102'), 'OAI-SearchBot is not disallowed here')
  assert.ok(ruleIds(report).includes('AR108'), 'its crawl-delay is still reported')
})

test('a crawl-delay in a duplicate group is still attributed to the agent', () => {
  const report = checkFixture('User-agent: PerplexityBot\nDisallow: /private\n\nUser-agent: PerplexityBot\nCrawl-delay: 10\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(ruleIds(report).includes('AR108'))
})

test('comments and a missing sitemap are handled', () => {
  const report = checkFixture('# a comment\nUser-agent: *\nDisallow: /admin/ # trailing comment\n')
  const ids = ruleIds(report)
  assert.ok(!ids.includes('AR103'), 'a narrow disallow is not a blanket block')
  assert.ok(ids.includes('AR105'), 'the missing sitemap is reported')
})

test('disallowing the markdown mirrors is caught', () => {
  const report = checkFixture('User-agent: *\nDisallow: /*.md\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(ruleIds(report).includes('AR107'))
  assert.equal(report.findings.find(finding => finding.ruleId === 'AR107').severity, 'high')
})

// AR107 exists to say "you published mirrors and then blocked the fetchers that
// would read them". A training-only crawler blocked from the mirrors is the same
// licensing choice AR104 scores as low, so charging a high finding for it would
// contradict the contract this tool states everywhere else.
test('a mirror block on a training-only crawler is not a visibility failure', () => {
  const report = checkFixture('User-agent: GPTBot\nDisallow: /*.md\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(!ruleIds(report).includes('AR107'), 'training-only mirror blocks must not fire AR107')
  assert.equal(report.score, 100)
  assert.equal(report.grade, GRADES.legible)
})

test('a training opt-out that also names the mirrors still grades legible', () => {
  const report = checkFixture('User-agent: GPTBot\nDisallow: /\nDisallow: /*.md\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.deepEqual(ruleIds(report), ['AR104'], 'only the licensing-choice finding')
  assert.equal(report.grade, GRADES.legible)
})

test('AR107 fires for the wildcard and for retrieval fetchers', () => {
  for (const agent of ['*', 'OAI-SearchBot', 'PerplexityBot']) {
    const report = checkFixture(`User-agent: ${agent}\nDisallow: /*.md\n\nSitemap: https://example.com/sitemap.xml\n`)
    assert.ok(ruleIds(report).includes('AR107'), `${agent} should fire AR107`)
  }
  const llms = checkFixture('User-agent: Claude-User\nDisallow: /llms.txt\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.ok(ruleIds(llms).includes('AR107'))
})

test('AR107 evidence names only the groups that matter', () => {
  const report = checkFixture([
    'User-agent: GPTBot',
    'Disallow: /*.md',
    '',
    'User-agent: *',
    'Disallow: /*.md',
    '',
    'Sitemap: https://example.com/sitemap.xml',
    '',
  ].join('\n'))
  const blocked = report.findings.find(finding => finding.ruleId === 'AR107')
  assert.ok(blocked)
  assert.match(blocked.evidence, /\*/)
  assert.ok(!/gptbot/i.test(blocked.evidence), 'the training group is not the reason this fires')
})

test('a training-only mirror block beside a permissive wildcard stays clean', () => {
  const report = checkFixture('User-agent: GPTBot\nDisallow: /*.md\n\nUser-agent: *\nDisallow: /admin\n\nSitemap: https://example.com/sitemap.xml\n')
  assert.deepEqual(ruleIds(report), [])
})

test('a well formed llms.txt passes', () => {
  const report = checkFixture([
    '# Wavect',
    '',
    '> Product engineering and fractional leadership from Austria.',
    '',
    '## Services',
    '',
    '- [Fractional CTO](https://wavect.io/services/fractional-cto-austria/): senior engineering leadership without a full-time hire',
    '- [Software development](https://wavect.io/services/software-development/): custom builds end to end',
    '',
  ].join('\n'))
  assert.equal(report.inputKind, INPUT_KINDS.llms)
  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.score, 100)
  assert.equal(report.grade, GRADES.legible)
})

test('relative links in llms.txt are a high finding', () => {
  const report = checkFixture([
    '# Wavect',
    '',
    '> Summary.',
    '',
    '## Services',
    '',
    '- [Fractional CTO](/services/fractional-cto-austria/): leadership',
    '- [Development](/services/software-development/): builds',
    '',
  ].join('\n'), { inputKind: INPUT_KINDS.llms })
  const relative = report.findings.find(finding => finding.ruleId === 'AR204')
  assert.equal(relative.severity, 'high')
  assert.match(relative.message, /2 links/)
})

test('a missing blockquote summary and missing H1 are both caught', () => {
  const report = checkFixture('## Services\n\n- [A](https://wavect.io/a): one\n- [B](https://wavect.io/b): two\n', { inputKind: INPUT_KINDS.llms })
  const ids = ruleIds(report)
  assert.ok(ids.includes('AR201'))
  assert.ok(ids.includes('AR202'))
})

test('markdown mirror rules mirror the production verifier', () => {
  const clean = checkFixture('---\ncanonical: https://wavect.io/x/\n---\n\n# One heading\n\nA sentence of real prose.\n', { inputKind: INPUT_KINDS.markdown })
  assert.deepEqual(ruleIds(clean), [])

  const twoH1s = checkFixture('# One\n\n# Two\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(twoH1s).includes('AR301'))

  const entity = checkFixture('# Title\n\nCost &amp; margin.\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(entity).includes('AR303'))

  const anchor = checkFixture('# Title\n\n<a href="/x">link</a>\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(anchor).includes('AR304'))

  const collapsed = checkFixture('# Title\n\n[one](/a)[two](/b)\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(collapsed).includes('AR305'))

  const glued = checkFixture('# Title\n\nby[Kevin](/team/)\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(glued).includes('AR306'))

  const fence = checkFixture('# Title\n\n```js\nconst a = 1\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(fence).includes('AR307'))

  const template = checkFixture('# Title\n\nValue: <no value>\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(template).includes('AR309'))
})

test('a template literal inside a fenced block is content, not a broken generator', () => {
  // Regression: sweeping this site's own mirrors flagged a JS sample in an agent
  // skill reference doc, because `${orderB.id}` looked like an unrendered value.
  const sample = [
    '# Order handling',
    '',
    '```js',
    'const id = `${orderB.id}`',
    'render(`{{ total }}`)',
    '```',
    '',
  ].join('\n')
  assert.ok(!ruleIds(checkFixture(sample, { inputKind: INPUT_KINDS.markdown })).includes('AR309'))

  // Outside a fence the same shape is still a failure.
  const leaked = checkFixture('# Title\n\nOrder ${orderB.id} shipped.\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(leaked).includes('AR309'))

  const hugo = checkFixture('# Title\n\nCall {{ .Title }} here.\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(hugo).includes('AR309'))

  // `<no value>` is never legitimate, fenced or not.
  const sentinel = checkFixture('# Title\n\n```\n<no value>\n```\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(!ruleIds(sentinel).includes('AR309'), 'fenced samples are exempt by design')
})

test('a heading inside a fenced block is code, not an H1', () => {
  const report = checkFixture('# Real heading\n\n```md\n# Not a heading\n```\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(!ruleIds(report).includes('AR301'))
})

test('table column parity is checked against the header row', () => {
  const good = checkFixture('# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(!ruleIds(good).includes('AR308'))

  const bad = checkFixture('# Title\n\n| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |\n', { inputKind: INPUT_KINDS.markdown })
  assert.ok(ruleIds(bad).includes('AR308'))
})

test('html discovery, structured data and entity rules', () => {
  const bare = checkFixture('<!doctype html><html><head><title></title></head><body><p>Hi</p></body></html>')
  const ids = ruleIds(bare)
  assert.equal(bare.inputKind, INPUT_KINDS.html)
  for (const rule of ['AR401', 'AR402', 'AR403', 'AR411', 'AR412', 'AR413', 'AR414']) {
    assert.ok(ids.includes(rule), `expected ${rule}`)
  }
  assert.equal(bare.grade, GRADES.opaque)
})

test('invalid JSON-LD scores as critical, not as present', () => {
  const report = checkFixture('<html lang="en"><head><script type="application/ld+json">{ not json }</script></head><body>text</body></html>')
  const invalid = report.findings.find(finding => finding.ruleId === 'AR404')
  assert.ok(invalid)
  assert.equal(invalid.severity, 'critical')
})

test('a complete head satisfies the discovery, structured and entity rules', () => {
  const html = [
    '<!doctype html><html lang="en"><head>',
    '<title>Agent readability</title>',
    '<meta name="description" content="A description.">',
    '<link rel="canonical" href="https://wavect.io/tools/agent-readability-checker/">',
    '<link rel="alternate" type="text/markdown" href="/tools/agent-readability-checker.md">',
    '<script type="application/ld+json">',
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': 'https://wavect.io/#organization',
      name: 'Wavect',
      sameAs: ['https://www.wikidata.org/wiki/Q139795658'],
    }),
    '</script>',
    '</head><body><h1>Agent readability</h1>',
    '<p>Enough prose in the served HTML that the client-render heuristic stays quiet, because it counts words outside script tags and wants at least fifty of them before it trusts the page.</p>',
    '</body></html>',
  ].join('\n')
  const report = checkFixture(html)
  assert.deepEqual(ruleIds(report), [])
  assert.equal(report.score, 100)
})

// HTML permits whitespace around the `=` in an attribute assignment. Compact
// output is the common case, but a hand-authored or pretty-printed page is valid
// and must not score as though the attributes were absent.
const COMPLETE_HEAD = (assign = '=') => {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': 'https://wavect.io/#organization',
    name: 'Wavect',
    sameAs: ['https://www.wikidata.org/wiki/Q139795658'],
  })
  const prose = 'Enough served prose that the client-render heuristic stays quiet, because it counts words outside script tags and wants at least fifty of them before it will trust the page at all, which this sentence comfortably provides.'
  return [
    `<!doctype html><html lang${assign}"en"><head>`,
    '<title>Agent readability</title>',
    `<meta name${assign}"description" content${assign}"A description.">`,
    `<link rel${assign}"canonical" href${assign}"https://wavect.io/x/">`,
    `<link rel${assign}"alternate" type${assign}"text/markdown" href${assign}"/x.md">`,
    `<script type${assign}"application/ld+json">${ld}</script>`,
    `</head><body><h1>Heading</h1><p>${prose}</p></body></html>`,
  ].join('\n')
}

test('whitespace around attribute assignments is accepted', () => {
  const compact = checkFixture(COMPLETE_HEAD('='))
  assert.deepEqual(ruleIds(compact), [], 'control: compact attributes are clean')

  for (const assign of [' = ', '= ', ' =', '\n  =\n  ']) {
    const report = checkFixture(COMPLETE_HEAD(assign))
    assert.deepEqual(
      ruleIds(report), [],
      `attributes written with ${JSON.stringify(assign)} must score the same as compact ones`,
    )
    assert.equal(report.score, 100)
  }
})

test('spaced assignments work for single-quoted and unquoted values', () => {
  const report = checkFixture([
    "<!doctype html><html lang = en><head>",
    '<title>T</title>',
    "<meta name = 'description' content = 'A description.'>",
    "<link rel = 'canonical' href = 'https://wavect.io/x/'>",
    "<link rel = 'alternate' type = 'text/markdown' href = '/x.md'>",
    "<script type = 'application/ld+json'>" + JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', '@id': 'x', name: 'W', sameAs: ['y'] }) + '</script>',
    '</head><body><h1>H</h1><p>Enough served prose that the client-render heuristic stays quiet, because it counts words outside script tags and wants at least fifty of them before it trusts the page, which this sentence provides.</p></body></html>',
  ].join('\n'))
  assert.deepEqual(ruleIds(report), [])
})

test('a spaced JSON-LD type is still parsed, and still validated', () => {
  const broken = checkFixture("<html lang='en'><head><title>T</title><script type = \"application/ld+json\">{ not json }</script></head><body>text</body></html>")
  const invalid = broken.findings.find(finding => finding.ruleId === 'AR404')
  assert.ok(invalid, 'a spaced type must not hide invalid JSON-LD')
  assert.equal(invalid.severity, 'critical')
  assert.ok(!ruleIds(broken).includes('AR403'), 'the block was found, so it is not reported as absent')
})

test('hreflang is not mistaken for lang', () => {
  const report = checkFixture('<!doctype html><html><head><link rel="alternate" hreflang="de" href="/de/"><title>T</title></head><body>b</body></html>')
  assert.ok(ruleIds(report).includes('AR413'), 'hreflang must not satisfy the html lang check')
})

test('nosnippet is treated as harshly as noindex', () => {
  const report = checkFixture('<html lang="en"><head><meta name="robots" content="max-snippet:0"><title>T</title></head><body>b</body></html>')
  const blocked = report.findings.find(finding => finding.ruleId === 'AR410')
  assert.equal(blocked.severity, 'critical')
})

test('a javascript shell page is flagged as a labelled heuristic', () => {
  const report = checkFixture('<html lang="en"><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>')
  const shell = report.findings.find(finding => finding.ruleId === 'AR416')
  assert.ok(shell)
  assert.equal(shell.confidence, 'heuristic')
})

test('the report is stable, ordered and self-describing', () => {
  const report = checkFixture('User-agent: *\nDisallow: /\n')
  assert.equal(report.checkerVersion, CHECKER_VERSION)
  assert.equal(report.schemaVersion, SCHEMA_VERSION)
  assert.equal(report.limitations.length, LIMITATIONS.length)
  assert.ok(report.checksRun > report.findings.length - 1)

  const order = ['critical', 'high', 'medium', 'low']
  const severities = report.findings.map(finding => order.indexOf(finding.severity))
  assert.deepEqual(severities, [...severities].sort((a, b) => a - b), 'findings are most severe first')

  for (const finding of report.findings) {
    assert.ok(finding.remediation.length > 20, `${finding.ruleId} needs an actionable remediation`)
    assert.ok(finding.message.length > 5, `${finding.ruleId} needs a message`)
    assert.ok(order.includes(finding.severity))
  }

  const repeat = checkFixture('User-agent: *\nDisallow: /\n')
  assert.deepEqual(repeat, report, 'the same input yields the same report')
})

test('scoring is bounded and monotonic', () => {
  assert.equal(gradeFor(100), GRADES.legible)
  assert.equal(gradeFor(90), GRADES.legible)
  assert.equal(gradeFor(70), GRADES.mostly)
  assert.equal(gradeFor(40), GRADES.patchy)
  assert.equal(gradeFor(0), GRADES.opaque)

  const worst = checkFixture('<html><head></head><body><div id="a"></div><script src="/a.js"></script></body></html>')
  assert.ok(worst.score >= 0)
  assert.ok(worst.score <= 100)
})

// ── browser adapter ──────────────────────────────────────────────────────────
// A tiny DOM stand-in, so the staleness guarantee is exercised rather than
// asserted by pattern match. The adapter only touches this much of the DOM.
class StubNode {
  constructor(tag = 'div') {
    this.tag = tag
    this.children = []
    this.dataset = {}
    this.textContent = ''
    this.className = ''
    this.value = ''
    this.hidden = false
    this.listeners = new Map()
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = [...nodes] }
  focus() {}
}

const STUB_UI = {
  not_run: 'Not checked',
  waiting: 'Waiting for input',
  empty: 'Paste a file',
  result_label: 'Readability score',
  finding_count: '%d findings across %c checks',
  no_findings: 'Nothing failed across %c checks',
  copy_json: 'Copy JSON',
  copied: 'Copied',
  copy_error: 'Clipboard unavailable',
  scan_error: 'The file could not be checked.',
  empty_input: 'Paste a file first.',
  heuristic: 'Heuristic',
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
  grades: { legible: 'Legible', 'mostly-legible': 'Mostly legible', patchy: 'Patchy', opaque: 'Opaque' },
  input_kinds: { 'robots-txt': 'robots.txt', 'llms-txt': 'llms.txt', markdown: 'Markdown mirror', html: 'Page HTML' },
}

const stub = (() => {
  const nodes = {
    config: new StubNode('script'),
    input: new StubNode('textarea'),
    kind: new StubNode('select'),
    inputKind: new StubNode('span'),
    empty: new StubNode('div'),
    summary: new StubNode('div'),
    summaryLabel: new StubNode('strong'),
    summaryDetail: new StubNode('p'),
    score: new StubNode('span'),
    list: new StubNode('div'),
    exportActions: new StubNode('div'),
    error: new StubNode('p'),
  }
  nodes.config.textContent = JSON.stringify(STUB_UI)
  nodes.kind.value = 'auto'
  const map = new Map([
    ['.tool-app-config', nodes.config],
    ['[data-field="input"]', nodes.input],
    ['[data-field="kind"]', nodes.kind],
    ['[data-input-kind]', nodes.inputKind],
    ['[data-findings-empty]', nodes.empty],
    ['[data-summary]', nodes.summary],
    ['[data-summary-label]', nodes.summaryLabel],
    ['[data-summary-detail]', nodes.summaryDetail],
    ['[data-score]', nodes.score],
    ['[data-finding-list]', nodes.list],
    ['[data-export-actions]', nodes.exportActions],
    ['[data-error]', nodes.error],
  ])
  const root = new StubNode('div')
  root.querySelector = selector => map.get(selector) ?? null
  return { root, nodes }
})()

let objectUrlCalls = 0
globalThis.document = {
  querySelectorAll: () => [stub.root],
  createElement: tag => new StubNode(tag),
  body: new StubNode('body'),
}
globalThis.URL.createObjectURL = () => { objectUrlCalls += 1; return 'blob:stub' }
globalThis.URL.revokeObjectURL = () => {}

// Import after the stub document exists: the adapter initializes on import.
await import('../src/browser-app.js')

const click = action => stub.root.dispatch('click', { target: { closest: () => ({ dataset: { action } }) } })
const BLOCKED = 'User-agent: OAI-SearchBot\nDisallow: /\n'

test('the adapter renders a result after a check', () => {
  stub.nodes.input.value = BLOCKED
  click('scan')
  assert.equal(stub.nodes.summary.hidden, false)
  assert.equal(stub.nodes.exportActions.hidden, false)
  assert.equal(stub.nodes.empty.hidden, true)
  assert.match(stub.nodes.score.textContent, /\/100$/)
  assert.ok(stub.nodes.list.children.length > 0, 'findings are rendered')
})

test('editing the input invalidates the previous report and its exports', () => {
  stub.nodes.input.value = BLOCKED
  click('scan')
  assert.equal(stub.nodes.exportActions.hidden, false, 'precondition: a report is on screen')

  stub.nodes.input.value = 'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n'
  stub.nodes.input.dispatch('input')

  assert.equal(stub.nodes.exportActions.hidden, true, 'exports must be withdrawn')
  assert.equal(stub.nodes.summary.hidden, true, 'the old score must be hidden')
  assert.equal(stub.nodes.summary.dataset.level, undefined, 'the old severity styling must go')
  assert.equal(stub.nodes.list.children.length, 0, 'the old findings must be cleared')
  assert.equal(stub.nodes.score.textContent, STUB_UI.not_run)
  assert.equal(stub.nodes.empty.hidden, false, 'the placeholder returns')
  assert.equal(stub.nodes.inputKind.textContent, STUB_UI.input_kinds['robots-txt'], 'the detected kind still updates')
})

test('a stale report cannot be exported after the input changes', () => {
  stub.nodes.input.value = BLOCKED
  click('scan')
  stub.nodes.input.value = '# Something else entirely\n'
  stub.nodes.input.dispatch('input')

  const before = objectUrlCalls
  click('export-json')
  click('export-markdown')
  assert.equal(objectUrlCalls, before, 'no file may be produced from a discarded report')
})

test('changing the forced file type invalidates the report too', () => {
  stub.nodes.input.value = BLOCKED
  click('scan')
  assert.equal(stub.nodes.exportActions.hidden, false)

  stub.nodes.kind.value = 'markdown'
  stub.nodes.kind.dispatch('change')
  assert.equal(stub.nodes.exportActions.hidden, true)
  assert.equal(stub.nodes.inputKind.textContent, STUB_UI.input_kinds.markdown, 'the badge follows the forced type')
  stub.nodes.kind.value = 'auto'
})

test('loading the sample invalidates the report, despite firing no input event', () => {
  stub.nodes.input.value = BLOCKED
  click('scan')
  assert.equal(stub.nodes.exportActions.hidden, false)

  click('load-sample')
  assert.equal(stub.nodes.exportActions.hidden, true)
  assert.equal(stub.nodes.summary.hidden, true)
  assert.ok(stub.nodes.input.value.includes('User-agent:'), 'the sample was loaded')
})


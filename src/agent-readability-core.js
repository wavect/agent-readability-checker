// Agent readability rules. Deterministic, offline, no network and no DOM, so the
// same catalog runs in the browser tool and in `node --test`.
//
// The Markdown mirror rules (AR3xx) are ported from scripts/verify_machine_markdown.mjs,
// which hard-fails this site's own production build. Keep the two in step: if a rule
// changes meaning there, change it here and bump CHECKER_VERSION.

export const CHECKER_VERSION = '0.1.2'
export const SCHEMA_VERSION = '1.0.0'

export const INPUT_KINDS = Object.freeze({
  robots: 'robots-txt',
  llms: 'llms-txt',
  html: 'html',
  markdown: 'markdown',
})

export const GRADES = Object.freeze({
  legible: 'legible',
  mostly: 'mostly-legible',
  patchy: 'patchy',
  opaque: 'opaque',
})

// Deduction per finding. A single critical finding cannot be outweighed by a pile
// of passes, which is the point: one `Disallow: /` decides the whole question.
const WEIGHTS = Object.freeze({ critical: 25, high: 12, medium: 6, low: 2 })

// Fetchers that retrieve a page in order to answer or cite it right now. Blocking
// one of these removes you from that assistant's answers.
export const RETRIEVAL_AGENTS = Object.freeze([
  'oai-searchbot',
  'chatgpt-user',
  'perplexitybot',
  'perplexity-user',
  'claudebot',
  'claude-user',
  'claude-searchbot',
  'duckassistbot',
  'applebot',
  'bingbot',
  'googlebot',
  'youbot',
])

// Crawlers whose documented purpose is collecting training data. Blocking these is
// a licensing decision, not a visibility defect, so they never score as a failure.
export const TRAINING_AGENTS = Object.freeze([
  'gptbot',
  'ccbot',
  'google-extended',
  'applebot-extended',
  'bytespider',
  'meta-externalagent',
  'facebookbot',
  'anthropic-ai',
  'cohere-ai',
  'ai2bot',
  'omgili',
  'timpibot',
  'diffbot',
  'amazonbot',
])

// Go's fmt and Hugo leak these when a template value is missing. They are the
// loudest possible signal that a machine-readable file was never looked at.
const UNRESOLVED_TEMPLATE = /<no value>|%!(?:[^\s(])?\([^\r\n)]*\)|\{\{[^}]*\}\}|\$\{[^}]*\}/

const HTML_ENTITY = /&[a-z][a-z0-9]+;|&#\d+;|&#x[0-9a-f]+;/i

function truncate(value, limit = 160) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

function stripFences(body) {
  return body.replace(/^(`{3,4})[^\n]*\n[\s\S]*?^\1\s*$/gm, '')
}

// `${x}` and `{{ x }}` are ordinary content inside a code sample, and a broken
// generator everywhere else. Sweeping this site's own 3,800 mirrors was what
// surfaced the difference, so the check deliberately ignores fenced blocks.
function unresolvedTemplate(text) {
  return stripFences(String(text)).match(UNRESOLVED_TEMPLATE)?.[0] ?? null
}

function splitFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  return match ? { frontMatter: match[1], body: text.slice(match[0].length) } : { frontMatter: '', body: text }
}

export function detectInputKind(text) {
  const source = String(text ?? '')
  const trimmed = source.trim()
  if (!trimmed) return INPUT_KINDS.markdown
  if (/^\s*(?:<!doctype html|<html\b)/i.test(trimmed) || /<(?:head|body|meta|script)\b/i.test(trimmed)) {
    return INPUT_KINDS.html
  }
  // robots.txt has no other plausible shape: a directive keyword at line start.
  if (/^\s*user-agent\s*:/im.test(trimmed) || /^\s*(?:disallow|allow|sitemap|crawl-delay)\s*:/im.test(trimmed)) {
    return INPUT_KINDS.robots
  }
  // An llms.txt is Markdown whose sections are nothing but link bullets.
  const bullets = (trimmed.match(/^\s*-\s*\[[^\]]+\]\([^)]+\)/gm) || []).length
  const paragraphs = trimmed.split(/\n{2,}/).length
  if (bullets >= 2 && bullets >= paragraphs - 2 && /^#\s+\S/m.test(trimmed)) return INPUT_KINDS.llms
  return INPUT_KINDS.markdown
}

function finding(ruleId, severity, category, message, evidence, remediation, confidence = 'certain') {
  return { ruleId, severity, category, message, evidence: truncate(evidence), remediation, confidence }
}

// ── robots.txt ───────────────────────────────────────────────────────────────

function parseRobots(text) {
  const groups = []
  const sitemaps = []
  let current = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (field === 'sitemap') {
      sitemaps.push(value)
      continue
    }
    if (field === 'user-agent') {
      // Consecutive user-agent lines share one rule block. Any directive ends
      // that run, crawl-delay included: without this the next user-agent line is
      // folded into this group and inherits its rules, which reports an agent as
      // blocked when only its neighbour is.
      if (current && !current.sawDirective) current.agents.push(value.toLowerCase())
      else {
        current = { agents: [value.toLowerCase()], rules: [], crawlDelay: null, sawDirective: false }
        groups.push(current)
      }
      continue
    }
    if (!current) continue
    if (field === 'disallow' || field === 'allow') {
      current.rules.push({ field, value })
      current.sawDirective = true
    }
    if (field === 'crawl-delay') {
      current.crawlDelay = value
      current.sawDirective = true
    }
  }
  return { groups, sitemaps }
}

// RFC 9309 2.2.1: if the same user-agent token appears in more than one group,
// the rules of all those groups MUST be merged and treated as a single group.
// Keeping only the last group let a later narrow rule mask an earlier
// `Disallow: /`, scoring a fully blocked site as clean.
function mergeGroups(groups) {
  const merged = new Map()
  for (const group of groups) {
    for (const agent of group.agents) {
      const existing = merged.get(agent)
      if (existing) {
        existing.rules.push(...group.rules)
        if (existing.crawlDelay === null) existing.crawlDelay = group.crawlDelay
      } else {
        merged.set(agent, { agents: [agent], rules: [...group.rules], crawlDelay: group.crawlDelay })
      }
    }
  }
  return merged
}

// A `Disallow` blocks the site root only when its path matches everything.
function blocksEverything(rules) {
  const disallowAll = rules.some(rule => rule.field === 'disallow' && (rule.value === '/' || rule.value === '/*'))
  if (!disallowAll) return false
  return !rules.some(rule => rule.field === 'allow' && (rule.value === '/' || rule.value === '/*'))
}

function checkRobots(text) {
  const { groups, sitemaps } = parseRobots(text)
  const findings = []
  const passed = []

  if (!groups.length) {
    findings.push(finding('AR101', 'high', 'access', 'No user-agent group was found.',
      truncate(text) || '(empty)',
      'A robots.txt with no user-agent group states nothing. Publish an explicit group so the file is not ambiguous to parsers that expect one.'))
    return { findings, passed }
  }

  const merged = mergeGroups(groups)
  const wildcard = merged.get('*') ?? null
  const named = new Map([...merged].filter(([agent]) => agent !== '*'))

  const blockedRetrieval = []
  for (const agent of RETRIEVAL_AGENTS) {
    const group = named.get(agent)
    if (group && blocksEverything(group.rules)) blockedRetrieval.push(agent)
  }
  if (blockedRetrieval.length) {
    findings.push(finding('AR102', 'critical', 'access',
      'An answer-engine fetcher is blocked from the whole site.',
      `User-agent: ${blockedRetrieval.join(', ')} → Disallow: /`,
      'These fetchers retrieve a page in order to answer or cite it. While they are disallowed, that assistant cannot quote you at all. Remove the blanket disallow, or narrow it to the paths you genuinely want withheld.'))
  } else {
    passed.push('AR102')
  }

  if (wildcard && blocksEverything(wildcard.rules)) {
    const uncovered = RETRIEVAL_AGENTS.filter(agent => !named.has(agent))
    findings.push(finding('AR103', 'critical', 'access',
      'The wildcard group blocks the whole site.',
      'User-agent: * → Disallow: /',
      `Every crawler without its own group falls back to the wildcard, so ${uncovered.length} of the retrieval fetchers this tool knows about are blocked by inheritance. Give the fetchers you want an explicit group, or lift the wildcard disallow.`))
  } else {
    passed.push('AR103')
  }

  const blockedTraining = TRAINING_AGENTS.filter(agent => {
    const group = named.get(agent)
    return group && blocksEverything(group.rules)
  })
  if (blockedTraining.length) {
    findings.push(finding('AR104', 'low', 'access',
      'Training crawlers are blocked. This is a licensing choice, not a visibility defect.',
      `User-agent: ${blockedTraining.join(', ')} → Disallow: /`,
      'Nothing to fix if it was deliberate. Blocking these opts you out of model training, and it does not remove you from assistant answers, because answers are served by the retrieval fetchers instead. Only act here if you blocked them believing it affected citations.'))
  }

  if (!sitemaps.length) {
    findings.push(finding('AR105', 'medium', 'discovery',
      'No Sitemap directive.',
      'robots.txt has no Sitemap: line',
      'Add a Sitemap: line with an absolute URL. It is the cheapest way for a crawler that arrived at robots.txt to enumerate the rest of the site instead of guessing from links.'))
  } else {
    passed.push('AR105')
    const relative = sitemaps.filter(url => !/^https?:\/\//i.test(url))
    if (relative.length) {
      findings.push(finding('AR106', 'medium', 'discovery',
        'A Sitemap directive uses a relative URL.',
        relative.join(', '),
        'The robots.txt specification requires an absolute URL for Sitemap. Relative values are skipped by most parsers.'))
    }
  }

  // Only groups that can actually serve an answer count here. A training-only
  // crawler kept away from the mirrors is the same licensing choice AR104 scores
  // as low, so charging a high finding for it would contradict the separation this
  // catalog makes everywhere else. The wildcard counts because any retrieval
  // fetcher without its own group, including ones this list has never heard of,
  // inherits it.
  const mirrorBlocks = []
  for (const [agent, group] of merged) {
    if (agent !== '*' && !RETRIEVAL_AGENTS.includes(agent)) continue
    for (const rule of group.rules) {
      if (rule.field !== 'disallow') continue
      if (/\.md(?:\$|$)|\*\.md|llms.*\.txt/i.test(rule.value)) {
        mirrorBlocks.push(`${agent} → Disallow: ${rule.value}`)
      }
    }
  }
  if (mirrorBlocks.length) {
    findings.push(finding('AR107', 'high', 'access',
      'The machine-readable mirrors are themselves disallowed.',
      mirrorBlocks.join(' | '),
      'Blocking .md mirrors or llms.txt defeats the reason for publishing them. These are the cheapest, cleanest copies an agent can read. Allow them explicitly for the fetchers that serve answers.'))
  } else {
    passed.push('AR107')
  }

  const delayed = [...merged].filter(([agent, group]) => group.crawlDelay && RETRIEVAL_AGENTS.includes(agent))
  if (delayed.length) {
    findings.push(finding('AR108', 'low', 'access',
      'Crawl-delay is set on an answer-engine fetcher.',
      delayed.map(([agent, group]) => `${agent} → Crawl-delay: ${group.crawlDelay}`).join(' | '),
      'Crawl-delay is unsupported by several of these fetchers and, where it is honoured, it delays the fetch that would have produced a citation. Rate-limit at the edge instead if load is the real concern.'))
  }

  return { findings, passed }
}

// ── llms.txt ─────────────────────────────────────────────────────────────────

function checkLlmsTxt(text) {
  const source = String(text)
  const findings = []
  const passed = []
  const body = stripFences(source)

  const h1s = body.match(/^#\s+\S.*$/gm) || []
  if (h1s.length !== 1) {
    findings.push(finding('AR201', 'critical', 'llmstxt',
      `Expected exactly one H1, found ${h1s.length}.`,
      h1s.slice(0, 3).join(' | ') || '(none)',
      'llms.txt opens with a single H1 naming the entity. Agents read it as the name of the thing the file describes, so zero H1s leaves the file unattributed and several make it ambiguous.'))
  } else {
    passed.push('AR201')
  }

  const afterH1 = h1s.length ? source.slice(source.indexOf(h1s[0]) + h1s[0].length) : source
  if (!/^\s*\n?>\s*\S/.test(afterH1)) {
    findings.push(finding('AR202', 'medium', 'entity',
      'No blockquote summary after the H1.',
      truncate(afterH1.split('\n').slice(0, 3).join(' ')) || '(nothing follows the H1)',
      'The blockquote directly under the H1 is the one-sentence description an agent is most likely to reuse verbatim when it introduces you. Without it, the agent writes that sentence itself.'))
  } else {
    passed.push('AR202')
  }

  const bullets = [...source.matchAll(/^\s*-\s*\[([^\]]*)\]\(([^)\s]+)\)\s*(?::\s*(\S.*))?$/gm)]
  if (!bullets.length) {
    findings.push(finding('AR203', 'high', 'llmstxt',
      'No link bullets were found.',
      '(no `- [name](url)` lines)',
      'The body of llms.txt is H2 sections containing `- [name](url): notes` bullets. Prose alone gives an agent nothing to fetch next.'))
  } else {
    passed.push('AR203')
    const relative = bullets.filter(match => !/^https?:\/\//i.test(match[2]))
    if (relative.length) {
      findings.push(finding('AR204', 'high', 'llmstxt',
        `${relative.length} link${relative.length === 1 ? '' : 's'} use a relative URL.`,
        relative.slice(0, 4).map(match => match[2]).join(', '),
        'llms.txt is fetched and passed around on its own, detached from the page it came from, so there is no base URL to resolve against. Use absolute URLs.'))
    } else {
      passed.push('AR204')
    }

    const insecure = bullets.filter(match => /^http:\/\//i.test(match[2]))
    if (insecure.length) {
      findings.push(finding('AR205', 'medium', 'llmstxt',
        `${insecure.length} link${insecure.length === 1 ? '' : 's'} use plain http.`,
        insecure.slice(0, 4).map(match => match[2]).join(', '),
        'Switch to https. Plain-http links are commonly dropped or rewritten before an agent ever fetches them.'))
    }

    const unannotated = bullets.filter(match => !match[3])
    if (unannotated.length > bullets.length / 2) {
      findings.push(finding('AR206', 'low', 'llmstxt',
        `${unannotated.length} of ${bullets.length} links have no note.`,
        unannotated.slice(0, 3).map(match => match[1] || match[2]).join(', '),
        'The `: notes` half of each bullet is how an agent decides which link to open with a limited budget. A bare list of titles makes it guess.'))
    } else {
      passed.push('AR206')
    }
  }

  const sections = source.match(/^##\s+\S.*$/gm) || []
  if (!sections.length) {
    findings.push(finding('AR207', 'medium', 'llmstxt',
      'No H2 sections.',
      '(no `## ` headings)',
      'Group links under H2 sections. The section name is the only context an agent has for why those links belong together.'))
  } else {
    passed.push('AR207')
  }

  const llmsTemplate = unresolvedTemplate(source)
  if (llmsTemplate) {
    findings.push(finding('AR208', 'high', 'llmstxt',
      'An unresolved template value is present.',
      llmsTemplate,
      'A literal `{{ }}`, `<no value>` or `%!s(MISSING)` in a published file means the generator failed and nobody read the output. Fix the template and add the check to your build.'))
  } else {
    passed.push('AR208')
  }

  return { findings, passed }
}

// ── Markdown mirror (ported from scripts/verify_machine_markdown.mjs) ────────

function checkMarkdown(text) {
  const source = String(text)
  const findings = []
  const passed = []
  const { frontMatter, body: rawBody } = splitFrontMatter(source)
  const body = rawBody.trim()
  const bodyWithoutCode = stripFences(body)

  const h1Count = (bodyWithoutCode.match(/^#\s+\S/gm) || []).length
  if (h1Count !== 1) {
    findings.push(finding('AR301', 'critical', 'mirror',
      `Expected one H1, found ${h1Count}.`,
      (bodyWithoutCode.match(/^#\s+\S.*$/gm) || []).slice(0, 3).join(' | ') || '(none)',
      'One H1 per document. Zero leaves the page untitled once the HTML chrome is gone, and several make an agent guess which one is the subject.'))
  } else {
    passed.push('AR301')
  }

  if (!body) {
    findings.push(finding('AR302', 'critical', 'mirror',
      'The Markdown body is empty.',
      '(front matter only)',
      'An empty body usually means the mirror was generated from a page whose content is injected by client-side JavaScript. Render the content server-side.'))
  } else {
    passed.push('AR302')
  }

  if (HTML_ENTITY.test(body)) {
    findings.push(finding('AR303', 'high', 'mirror',
      'An unresolved HTML entity leaked into the Markdown.',
      body.match(HTML_ENTITY)?.[0] ?? '',
      'Decode entities when converting HTML to Markdown. A literal `&amp;` or `&#39;` is read as those characters, not as `&` or an apostrophe.'))
  } else {
    passed.push('AR303')
  }

  if (/<a\b[^>]*href=/i.test(body)) {
    findings.push(finding('AR304', 'high', 'mirror',
      'A raw HTML anchor leaked into the Markdown.',
      body.match(/<a\b[^>]*>/i)?.[0] ?? '',
      'Convert anchors to `[text](url)`. Raw HTML in a Markdown mirror is the thing the mirror exists to remove.'))
  } else {
    passed.push('AR304')
  }

  if (/\]\([^)]+\)\[/.test(body)) {
    findings.push(finding('AR305', 'medium', 'mirror',
      'Adjacent links were collapsed with no separator.',
      body.match(/\]\([^)]+\)\[[^\]]*\]/)?.[0] ?? '',
      'Two links printed back to back read as one phrase. Emit the whitespace or punctuation that separated them in the HTML.'))
  } else {
    passed.push('AR305')
  }

  if (/\b(?:by|von|por)\[/i.test(body)) {
    findings.push(finding('AR306', 'low', 'mirror',
      'Attribution is glued to its link.',
      body.match(/\b(?:by|von|por)\[[^\]]*\]/i)?.[0] ?? '',
      'A missing space turns "by [Author]" into "by[Author]". Harmless to render, but it corrupts the author string an agent extracts.'))
  } else {
    passed.push('AR306')
  }

  const fences = (body.match(/^`{3,4}[^\n]*$/gm) || []).length
  if (fences % 2 !== 0) {
    findings.push(finding('AR307', 'high', 'mirror',
      `Unbalanced fenced code block (${fences} fence lines).`,
      `${fences} fence lines`,
      'An unclosed fence swallows the rest of the document. Every heading after it stops being a heading.'))
  } else {
    passed.push('AR307')
  }

  const tableIssues = []
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[index])) continue
    const header = lines[index - 1]
    if (!header || !header.includes('|')) continue
    const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
    if (cells(header) !== cells(lines[index])) {
      tableIssues.push(`row ${index + 1}: header ${cells(header)} columns, delimiter ${cells(lines[index])}`)
    }
  }
  if (tableIssues.length) {
    findings.push(finding('AR308', 'medium', 'mirror',
      'A table header and its delimiter row disagree on column count.',
      tableIssues.slice(0, 3).join(' | '),
      'A mismatched delimiter row stops the block being parsed as a table, so every cell collapses into one paragraph and the row-to-column relationship is lost.'))
  } else {
    passed.push('AR308')
  }

  const mirrorTemplate = unresolvedTemplate(source)
  if (mirrorTemplate) {
    findings.push(finding('AR309', 'high', 'mirror',
      'An unresolved template value is present.',
      mirrorTemplate,
      'Fail the build on `<no value>`, `%!s(MISSING)` and stray `{{ }}` in generated output. This site does exactly that, which is the only reason it stays clean.'))
  } else {
    passed.push('AR309')
  }

  if (frontMatter && !/^canonical:\s*\S/m.test(frontMatter)) {
    findings.push(finding('AR310', 'low', 'discovery',
      'The front matter has no canonical URL.',
      truncate(frontMatter),
      'Carry `canonical:` into the mirror. A Markdown file passed around without its canonical URL cannot be cited back to a page.'))
  } else if (frontMatter) {
    passed.push('AR310')
  }

  return { findings, passed }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function checkHtml(text) {
  const source = String(text)
  const findings = []
  const passed = []

  const linkTags = source.match(/<link\b[^>]*>/gi) || []
  const relOf = tag => attribute(tag, 'rel').toLowerCase()

  const canonical = linkTags.find(tag => relOf(tag).split(/\s+/).includes('canonical'))
  if (!canonical) {
    findings.push(finding('AR401', 'critical', 'discovery',
      'No canonical link.',
      '(no <link rel="canonical">)',
      'Without a canonical URL an agent that reached this page through a redirect, a tracking parameter or a mirror has no single address to cite. This is the most common reason a citation points somewhere you did not expect.'))
  } else {
    passed.push('AR401')
  }

  const markdownAlternate = linkTags.find(tag => (
    relOf(tag).split(/\s+/).includes('alternate') && /text\/markdown/i.test(attribute(tag, 'type'))
  ))
  if (!markdownAlternate) {
    findings.push(finding('AR402', 'high', 'discovery',
      'No Markdown alternate is advertised.',
      '(no <link rel="alternate" type="text/markdown">)',
      'Publish a Markdown mirror and point to it with `<link rel="alternate" type="text/markdown" href="...">`. It is the difference between an agent parsing your rendered chrome and reading clean prose.'))
  } else {
    passed.push('AR402')
  }

  const jsonLdBlocks = [...source.matchAll(/<script\b[^>]*\btype=(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)]
  if (!jsonLdBlocks.length) {
    findings.push(finding('AR403', 'critical', 'structured',
      'No JSON-LD.',
      '(no application/ld+json script)',
      'JSON-LD is the only part of a page an answer engine does not have to infer. Without it, every fact about you is guessed from prose.'))
  } else {
    passed.push('AR403')
  }

  const parsed = []
  for (const block of jsonLdBlocks) {
    try {
      parsed.push(JSON.parse(block[1]))
    } catch (error) {
      findings.push(finding('AR404', 'critical', 'structured',
        'A JSON-LD block is not valid JSON.',
        `${error.message}: ${truncate(block[1], 80)}`,
        'Invalid JSON-LD is discarded silently, so the page scores as if it had no structured data at all. Validate it in your build.'))
    }
  }

  const nodes = []
  const collect = value => {
    if (Array.isArray(value)) return value.forEach(collect)
    if (!value || typeof value !== 'object') return
    nodes.push(value)
    for (const key of Object.keys(value)) if (key !== '@context') collect(value[key])
  }
  parsed.forEach(collect)

  if (parsed.length) {
    const contexts = parsed.filter(node => !Array.isArray(node) && typeof node === 'object' && node['@context'])
    if (contexts.length !== parsed.length) {
      findings.push(finding('AR405', 'high', 'structured',
        'A JSON-LD block has no @context.',
        `${parsed.length - contexts.length} of ${parsed.length} blocks`,
        'Set `"@context": "https://schema.org"`. Without it the block is untyped data and consumers drop it.'))
    } else {
      passed.push('AR405')
    }

    const types = new Set(nodes.flatMap(node => [].concat(node['@type'] ?? [])).filter(Boolean).map(String))
    if (!types.size) {
      findings.push(finding('AR406', 'high', 'structured',
        'No @type anywhere in the JSON-LD.',
        '(no @type)',
        'Every node needs an @type. Untyped nodes describe nothing a consumer can act on.'))
    } else {
      passed.push('AR406')
    }

    const entityTypes = ['Organization', 'Corporation', 'LocalBusiness', 'Person', 'WebSite', 'Product', 'SoftwareApplication']
    if (![...types].some(type => entityTypes.includes(type))) {
      findings.push(finding('AR407', 'medium', 'entity',
        'No entity node identifies who publishes this page.',
        `types found: ${[...types].slice(0, 8).join(', ') || 'none'}`,
        'Add an Organization, LocalBusiness or Person node. Page-level types alone tell an engine what the page is, never who stands behind it, and "who" is what it needs before it will cite you by name.'))
    } else {
      passed.push('AR407')
    }

    if (!nodes.some(node => node.sameAs)) {
      findings.push(finding('AR408', 'medium', 'entity',
        'No sameAs links.',
        '(no sameAs)',
        'List your Wikidata, LinkedIn and registry URLs in `sameAs`. This is how an engine decides that your Organization node and the entity it already knows are the same company, rather than two similarly named ones.'))
    } else {
      passed.push('AR408')
    }

    if (!nodes.some(node => node['@id'])) {
      findings.push(finding('AR409', 'low', 'entity',
        'No @id on any node.',
        '(no @id)',
        'Give your recurring entities a stable `@id` so nodes across pages resolve to one thing instead of a fresh entity per page.'))
    } else {
      passed.push('AR409')
    }
  }

  const metaTags = source.match(/<meta\b[^>]*>/gi) || []
  const robotsMeta = metaTags.filter(tag => /^robots$/i.test(attribute(tag, 'name')) || /bot$/i.test(attribute(tag, 'name')))
  const blocking = robotsMeta.filter(tag => /noindex|nosnippet|noarchive|max-snippet\s*:\s*0/i.test(attribute(tag, 'content')))
  if (blocking.length) {
    findings.push(finding('AR410', 'critical', 'access',
      'A robots meta tag suppresses indexing or snippets.',
      blocking.map(tag => attribute(tag, 'content')).join(' | '),
      '`noindex` removes the page. `nosnippet` and `max-snippet:0` keep the page but forbid the quotation, which is the exact thing an answer engine needs in order to cite you.'))
  } else {
    passed.push('AR410')
  }

  const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  if (!title || !title[1].trim()) {
    findings.push(finding('AR411', 'high', 'discovery',
      'No page title.',
      '(no non-empty <title>)',
      'The title is the label a citation carries. Without it an agent invents one from the first heading it finds.'))
  } else {
    passed.push('AR411')
  }

  const description = metaTags.find(tag => /^description$/i.test(attribute(tag, 'name')))
  if (!description || !attribute(description, 'content').trim()) {
    findings.push(finding('AR412', 'medium', 'discovery',
      'No meta description.',
      '(no non-empty meta description)',
      'Write the one-sentence summary yourself instead of letting it be extracted from whatever prose happens to sit near the top.'))
  } else {
    passed.push('AR412')
  }

  const htmlTag = source.match(/<html\b[^>]*>/i)
  if (htmlTag && !attribute(htmlTag[0], 'lang')) {
    findings.push(finding('AR413', 'medium', 'entity',
      'The html element has no lang attribute.',
      htmlTag[0],
      'Set `lang`. On a multi-language site it is what stops an engine treating the German and English versions as duplicates of one page.'))
  } else if (htmlTag) {
    passed.push('AR413')
  }

  const headings = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
  if (headings.length !== 1) {
    findings.push(finding('AR414', headings.length ? 'low' : 'high', 'discovery',
      `Expected one H1, found ${headings.length}.`,
      headings.slice(0, 3).map(match => truncate(match[1].replace(/<[^>]*>/g, ' '), 50)).join(' | ') || '(none)',
      'One H1 states the subject of the page. Several split it, and none leaves the subject to be inferred from the title tag.'))
  } else {
    passed.push('AR414')
  }

  const tables = (source.match(/<table\b/gi) || []).length
  const headerCells = (source.match(/<th\b/gi) || []).length
  if (tables && !headerCells) {
    findings.push(finding('AR415', 'medium', 'structured',
      `${tables} table${tables === 1 ? '' : 's'} with no header cells.`,
      `${tables} <table>, 0 <th>`,
      'Use `<th>`. Without header cells a table flattens into a list of values and every number loses the column that gave it meaning.'))
  } else if (tables) {
    passed.push('AR415')
  }

  // Heuristic, and labelled as one: a shell page whose text lives in JavaScript.
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)
  if (bodyMatch) {
    const withoutScripts = bodyMatch[1].replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ')
    const words = withoutScripts.split(/\s+/).filter(Boolean).length
    const scripts = (bodyMatch[1].match(/<script\b/gi) || []).length
    if (words < 50 && scripts > 0) {
      findings.push(finding('AR416', 'high', 'access',
        `The body holds ${words} words of text outside script tags.`,
        `${words} words, ${scripts} script tags`,
        'Several fetchers take the HTML as served and never run JavaScript. If the text arrives client-side, those fetchers see this near-empty shell. Server-render the content, or publish a Markdown mirror that contains it.',
        'heuristic'))
    } else {
      passed.push('AR416')
    }
  }

  return { findings, passed }
}

// ── report ───────────────────────────────────────────────────────────────────

const CHECKERS = {
  [INPUT_KINDS.robots]: checkRobots,
  [INPUT_KINDS.llms]: checkLlmsTxt,
  [INPUT_KINDS.markdown]: checkMarkdown,
  [INPUT_KINDS.html]: checkHtml,
}

export const LIMITATIONS = Object.freeze([
  'This reads one pasted file. It does not fetch your site, follow links or compare pages against each other.',
  'A clean result means nothing blocks an agent from reading this input. It does not predict that any assistant will cite you.',
  'robots.txt is a request. Well-behaved fetchers honour it and others ignore it, so a permissive file is not a guarantee either way.',
  'Findings marked heuristic are inferred from shape rather than proven, and are worth confirming by hand.',
])

export function gradeFor(score) {
  if (score >= 90) return GRADES.legible
  if (score >= 70) return GRADES.mostly
  if (score >= 40) return GRADES.patchy
  return GRADES.opaque
}

export function checkAgentReadability(text, options = {}) {
  const source = String(text ?? '')
  if (!source.trim()) {
    const error = new Error('empty-input')
    error.code = 'empty-input'
    throw error
  }
  const inputKind = options.inputKind && CHECKERS[options.inputKind] ? options.inputKind : detectInputKind(source)
  const { findings, passed } = CHECKERS[inputKind](source)

  const severityOrder = ['critical', 'high', 'medium', 'low']
  findings.sort((left, right) => (
    severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity)
    || left.ruleId.localeCompare(right.ruleId)
  ))

  const deduction = findings.reduce((total, item) => total + (WEIGHTS[item.severity] ?? 0), 0)
  const score = Math.max(0, Math.min(100, 100 - deduction))
  const counts = severityOrder.reduce((accumulator, severity) => {
    accumulator[severity] = findings.filter(item => item.severity === severity).length
    return accumulator
  }, {})

  return {
    checkerVersion: CHECKER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    inputKind,
    score,
    grade: gradeFor(score),
    counts,
    checksRun: findings.length + passed.length,
    passedRuleIds: passed,
    findings,
    limitations: [...LIMITATIONS],
  }
}

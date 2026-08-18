# Agent Readability Checker

The open-source core behind Wavect's browser-local [Agent Readability Checker](https://wavect.io/tools/agent-readability-checker/).

It answers one narrow, mechanical question: can an AI agent fetch this file, parse it, and attribute it to you. Paste a `robots.txt`, an `llms.txt`, a Markdown mirror, or the HTML of one page, and it returns a score, the evidence line behind every finding, and the fix.

The `AR3xx` Markdown-mirror rules are ported from the verifier that hard-fails the production build of [wavect.io](https://wavect.io), so they are rules we already have to pass rather than best practice we read about. Porting them was validated by sweeping every generated mirror and built page on that site, which is also what surfaced the one false positive the catalog started with.

## What it checks

42 deterministic rules. Rule IDs are grouped by the input they apply to, and each
rule also carries one of six categories (`access`, `discovery`, `mirror`,
`structured`, `entity`, `llmstxt`) so a report can be read by concern:

| Prefix | Input | Covers |
| --- | --- | --- |
| `AR1xx` | `robots.txt` | user-agent groups, blanket disallows, sitemap directives, mirror-blocking rules, crawl delay |
| `AR2xx` | `llms.txt` | single H1, blockquote summary, absolute URLs, sections, link notes, unresolved template values |
| `AR3xx` | Markdown mirror | H1 count, empty body, undecoded entities, raw anchors, collapsed links, fences, table column parity, canonical |
| `AR4xx` | Page HTML | canonical, Markdown alternate, title, description, H1, JSON-LD validity and typing, publisher entity, `sameAs`, `@id`, `lang`, robots meta, client-render heuristic |

### Retrieval is not training

The catalog separates crawlers that collect training data from fetchers that retrieve a page in order to answer and cite it, because most `robots.txt` files conflate the two. Blocking `GPTBot` is a licensing decision and scores as a low informational finding. Blocking `OAI-SearchBot` removes you from answers and scores as critical.

## Usage

```js
import { checkAgentReadability } from '@wavect/agent-readability-checker'

const report = checkAgentReadability(fileContents)
// { checkerVersion, schemaVersion, inputKind, score, grade, counts,
//   checksRun, passedRuleIds, findings, limitations }
```

The input kind is detected from shape and can be forced:

```js
checkAgentReadability(text, { inputKind: 'llms-txt' })
```

Every finding carries `ruleId`, `severity`, `category`, `message`, `evidence`, `remediation`, and `confidence`. Findings inferred from shape rather than proven are marked `confidence: 'heuristic'`.

## Honest limits

- It reads one input. It does not crawl a site, follow links, or compare pages against each other.
- A clean result means nothing blocks an agent from reading that input. It does not predict that any assistant will cite you.
- `robots.txt` is a request. Well-behaved fetchers honour it and others ignore it, so a permissive file is not a guarantee either.
- Crawler names change. The agent lists are accurate as of the version shown and need updating over time.

## Repository layout

- `src/agent-readability-core.js`: environment-independent rule catalog, scoring, and report shape. No network and no DOM.
- `src/browser-app.js`: Wavect's DOM adapter, export handlers, and localized label wiring.
- `test/agent-readability-core.test.mjs`: rule regression tests, including the fenced-code false positive.

The browser adapter expects the markup and localized configuration rendered by the hosted Wavect page. The core module can be imported independently.

## Development

```bash
npm ci
npm test
```

Nothing is fetched and nothing is uploaded. The hosted version never requests a URL, which keeps staging hosts and internal paths out of everyone's logs, including ours. That is why the tool is paste-based rather than URL-based.

## License

GPL-3.0-only. See [LICENSE](LICENSE).

import { checkAgentReadability, detectInputKind, GRADES } from './agent-readability-core.js'

// A robots.txt that looks careful and is not: the training crawlers are blocked,
// which is a licensing choice, but the wildcard disallow underneath takes the
// answer-engine fetchers down with it.
const SAMPLE = `User-agent: GPTBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: *
Disallow: /
`

const LEVELS = {
  [GRADES.legible]: 'clear',
  [GRADES.mostly]: 'clear',
  [GRADES.patchy]: 'review',
  [GRADES.opaque]: 'stop',
}

function saveFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function reportMarkdown(report, ui) {
  const findings = report.findings.length
    ? report.findings.map((item) => [
      `## ${item.ruleId}: ${item.message}`,
      '',
      `- ${ui.severity_label}: ${ui[item.severity] || item.severity}`,
      `- ${ui.category_label}: ${ui.categories?.[item.category] || item.category}`,
      `- ${ui.evidence_label}: \`${String(item.evidence).replaceAll('`', '\\`')}\``,
      `- ${ui.review_step_label}: ${item.remediation}`,
      item.confidence === 'heuristic' ? `- ${ui.confidence_label}: ${ui.heuristic}` : null,
    ].filter(line => line !== null).join('\n')).join('\n\n')
    : ui.no_findings_export

  return [
    `# ${ui.report_title}`,
    '',
    `- ${ui.checker_label}: ${report.checkerVersion}`,
    `- ${ui.schema_label}: ${report.schemaVersion}`,
    `- ${ui.input_kind_label}: ${ui.input_kinds?.[report.inputKind] || report.inputKind}`,
    `- ${ui.score_label}: ${report.score}/100 (${ui.grades?.[report.grade] || report.grade})`,
    `- ${ui.checks_label}: ${report.checksRun}`,
    '',
    findings,
    '',
    `## ${ui.limitations_label}`,
    '',
    report.limitations.map((item) => `- ${item}`).join('\n'),
    '',
  ].join('\n')
}

function initialize(root) {
  const ui = JSON.parse(root.querySelector('.tool-app-config').textContent)
  const input = root.querySelector('[data-field="input"]')
  const kindSelect = root.querySelector('[data-field="kind"]')
  const inputKind = root.querySelector('[data-input-kind]')
  const empty = root.querySelector('[data-findings-empty]')
  const summary = root.querySelector('[data-summary]')
  const summaryLabel = root.querySelector('[data-summary-label]')
  const summaryDetail = root.querySelector('[data-summary-detail]')
  const score = root.querySelector('[data-score]')
  const list = root.querySelector('[data-finding-list]')
  const exportActions = root.querySelector('[data-export-actions]')
  const errorNode = root.querySelector('[data-error]')
  let report = null

  function showError(message) {
    errorNode.textContent = message
    errorNode.hidden = false
  }

  function describeKind(kind) {
    return ui.input_kinds?.[kind] || kind
  }

  // A report describes the exact text it was run against. The moment that text or
  // the forced file type changes, the score, findings and exports on screen belong
  // to something else, so they are torn down rather than left to look current.
  // Without this a visitor could paste file B and export a report for file A.
  function invalidate() {
    report = null
    exportActions.hidden = true
    errorNode.hidden = true
    summary.hidden = true
    delete summary.dataset.level
    summaryLabel.textContent = ''
    summaryDetail.textContent = ''
    list.replaceChildren()
    score.textContent = ui.not_run
    empty.hidden = false
  }

  function showDetectedKind() {
    if (kindSelect.value !== 'auto') {
      inputKind.textContent = describeKind(kindSelect.value)
      return
    }
    inputKind.textContent = input.value.trim() ? describeKind(detectInputKind(input.value)) : ui.waiting
  }

  function findingNode(item) {
    const article = document.createElement('article')
    article.className = 'tool-risk-finding'
    article.dataset.severity = item.severity
    const head = document.createElement('div')
    const heading = document.createElement('h4')
    heading.textContent = `${item.ruleId} · ${item.message}`
    const badge = document.createElement('span')
    badge.textContent = ui[item.severity] || item.severity
    head.append(heading, badge)
    const evidence = document.createElement('code')
    evidence.textContent = item.evidence
    const remediation = document.createElement('p')
    remediation.textContent = item.confidence === 'heuristic'
      ? `${ui.heuristic}: ${item.remediation}`
      : item.remediation
    article.append(head, evidence, remediation)
    return article
  }

  function run() {
    errorNode.hidden = true
    try {
      const requested = kindSelect.value
      report = checkAgentReadability(input.value, requested === 'auto' ? {} : { inputKind: requested })
      const grade = ui.grades?.[report.grade] || report.grade
      empty.hidden = true
      summary.hidden = false
      summary.dataset.level = LEVELS[report.grade] || 'review'
      summaryLabel.textContent = `${report.score}/100 · ${grade}`
      summaryDetail.textContent = report.findings.length
        ? ui.finding_count.replace('%d', report.findings.length).replace('%c', report.checksRun)
        : ui.no_findings.replace('%c', report.checksRun)
      score.textContent = `${report.score}/100`
      inputKind.textContent = describeKind(report.inputKind)
      list.replaceChildren(...report.findings.map(findingNode))
      exportActions.hidden = false
    } catch (error) {
      report = null
      exportActions.hidden = true
      showError(error.code === 'empty-input' ? ui.empty_input : (error.message || ui.scan_error))
    }
  }

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    if (button.dataset.action === 'load-sample') {
      input.value = SAMPLE
      kindSelect.value = 'auto'
      // Setting value in code fires no input event, so invalidate explicitly.
      invalidate()
      showDetectedKind()
      input.focus()
    } else if (button.dataset.action === 'scan') {
      run()
    } else if (button.dataset.action === 'copy-json' && report) {
      try {
        await navigator.clipboard.writeText(`${JSON.stringify(report, null, 2)}\n`)
        button.textContent = ui.copied
        setTimeout(() => { button.textContent = ui.copy_json }, 1200)
      } catch {
        showError(ui.copy_error)
      }
    } else if (button.dataset.action === 'export-json' && report) {
      saveFile('agent-readability-report.json', `${JSON.stringify(report, null, 2)}\n`, 'application/json')
    } else if (button.dataset.action === 'export-markdown' && report) {
      saveFile('agent-readability-report.md', reportMarkdown(report, ui), 'text/markdown')
    }
  })

  input.addEventListener('input', () => {
    invalidate()
    showDetectedKind()
  })

  kindSelect.addEventListener('change', () => {
    invalidate()
    showDetectedKind()
  })

  input.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run()
  })
}

document.querySelectorAll('[data-tool-app="agent-readability-checker"]').forEach(initialize)

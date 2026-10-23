// Formal verification for UI layout: the visualizer.
//
// Reads data/index.json and every data/<check>.json that probe.ts writes. A
// version's circuit runs here with a copy of check.ts's evaluateCompact, in
// FP32, so the preview and the live check are the prover's own numbers. Every
// number in a scene, an overlay or a claim is a wire: an index into the values
// that evaluateCompact returns, whose first entries are the knobs.
'use strict'

// ---------------------------------------------------------------------------
// The circuit

// A copy of check.ts's evaluateCompact; keep it bit for bit the same.
function evaluateCompact(sourceSize, operations, source) {
  const values = new Float32Array(sourceSize + operations.length)
  for (let cell = 0; cell < sourceSize; cell++) values[cell] = Math.fround(source[cell])
  const sum = (terms, bias) => {
    let value = Math.fround(bias)
    for (let i = 0; i < terms.length; i += 2) value = Math.fround(value + Math.fround(Math.fround(terms[i + 1]) * values[terms[i]]))
    return value
  }
  for (let index = 0; index < operations.length; index++) {
    const [kind, left, leftBias, gate, gateBias, relation] = operations[index]
    let value
    if (kind === 'select') value = values[left[0]] === 1 ? values[left[4]] : values[left[2]]
    else if (kind === 'product') value = Math.fround(values[left[0]] * values[left[2]])
    else if (kind === 'divide') value = Math.fround(sum(left, leftBias) / sum(gate, gateBias))
    else if (kind === 'compare') {
      const a = values[left[0]]
      const b = left.length > 2 ? values[left[2]] : -leftBias
      value = (relation === '<' ? a < b : relation === '<=' ? a <= b : relation === '>' ? a > b : relation === '>=' ? a >= b
        : relation === '==' ? a === b : !Number.isNaN(a)) ? 1 : 0
    } else value = sum(left, leftBias)
    values[sourceSize + index] = value
  }
  return values
}

// JSON writes NaN and ±Infinity as null. In an operation, the only such
// numbers are constants, and Yoga's undefined (NaN) is the one a layout
// circuit holds, so a null becomes NaN.
function decodeOperations(operations) {
  const number = value => value === null ? NaN : value
  return operations.map(([kind, left, leftBias, gate, gateBias, relation]) => {
    const op = [kind, left.map(number), number(leftBias), gate.map(number), number(gateBias)]
    if (relation !== undefined) op.push(relation)
    return op
  })
}

if (typeof module !== 'undefined') module.exports = {evaluateCompact, decodeOperations}

// ---------------------------------------------------------------------------
// Numbers in words

function fmt(value) {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? '—' : value > 0 ? '∞' : '−∞'
  const abs = Math.abs(value)
  const text = abs !== 0 && abs < 0.01 ? String(Number(value.toPrecision(2))) : String(Math.round(value * 100) / 100)
  return text.replace('-', '−')
}

const superscript = digits => String(digits).replace(/[0-9-]/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(d)] ?? '⁻')

// How many inputs a version covers: every knob's grid points, multiplied.
function combinations(knobs) {
  let log = 0
  for (const knob of knobs) log += Math.log10(Math.round((knob.high - knob.low) / knob.grid) + 1)
  if (log < 6) return Math.round(10 ** log).toLocaleString('en-US')
  let exponent = Math.floor(log)
  let mantissa = Math.round(10 ** (log - exponent) * 10) / 10
  if (mantissa >= 10) { mantissa = 1; exponent++ }
  return `${mantissa.toFixed(1)} × 10<sup>${exponent}</sup>`
}
const combinationsText = knobs => combinations(knobs).replace(/<sup>(\d+)<\/sup>/, (_, d) => superscript(d))

// The grid the inputs move on, e.g. "1/64 px".
function steps(knobs) {
  const grids = [...new Set(knobs.map(knob => knob.grid))]
  if (grids.length !== 1) return ''
  const inverse = 1 / grids[0]
  const grid = grids[0] < 1 && Number.isInteger(inverse) ? `1/${inverse}` : fmt(grids[0])
  return ` Every input moves in steps of ${grid} px.`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c])
}

// A seeded random source, so the same version always wanders the same way.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

const ease = t => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

// ---------------------------------------------------------------------------
// Preparing a version for drawing

function prepare(check, example, version) {
  const ops = decodeOperations(version.operations)
  const boxes = []
  version.scenes.forEach((scene, si) => {
    const visit = (node, parent, depth) => {
      const index = boxes.length
      const inButton = parent >= 0 && (boxes[parent].role === 'button' || boxes[parent].inButton)
      const wordings = node.text === undefined ? [] : Array.isArray(node.text) ? node.text : [node.text]
      boxes.push({scene: si, node, parent, depth, name: node.name, role: node.role || 'container', text: wordings[wordings.length - 1], wordings, inButton})
      for (const child of node.children || []) visit(child, index, depth + 1)
    }
    visit(scene.root, -1, 0)
  })
  const claims = version.claims.map((claim, index) => ({
    ...claim, index,
    min: claim.minimum === null || claim.minimum === undefined ? -Infinity : claim.minimum,
    max: claim.maximum === null || claim.maximum === undefined ? Infinity : claim.maximum,
    targets: targetsOf(claim, version.scenes, boxes),
  }))
  const prep = {key: `${check.id}/${example.id}/${version.id}`, check, example, version, ops, boxes, claims, knobs: version.knobs}
  const base = version.knobs.map(knob => knob.base)
  prep.frames = framesOf(version, evaluate(prep, base))
  const counts = {proven: 0, refuted: 0, unknown: 0, none: 0}
  for (const claim of claims) counts[claim.status in counts ? claim.status : 'none']++
  prep.counts = counts
  prep.kind = counts.refuted > 0 ? 'breaks' : counts.none === claims.length ? 'none' : counts.proven === claims.length ? 'fits' : 'open'
  prep.refuted = claims.find(claim => claim.status === 'refuted' && Array.isArray(claim.source))
  return prep
}

function evaluate(prep, values) {
  return evaluateCompact(prep.version.sourceSize, prep.ops, values)
}

function holds(claim, wires) {
  const value = wires[claim.wire]
  return value >= claim.min && value <= claim.max
}
function allHold(prep, wires) {
  for (const claim of prep.claims) if (!holds(claim, wires)) return false
  return true
}

// Which boxes a claim is about: its targets, as scene/box, when the data
// has them. A claim about boxes at fixed places has none, since their
// numbers are constants that many boxes share, and older data has none at
// all; then this reads the box names in the claim's name, e.g. "title in
// toolbar: right <= width": the first box named is the one that breaks, the
// others are its neighbours. A scene's name in the claim's name keeps the
// match to that scene.
function targetsOf(claim, scenes, boxes) {
  if (Array.isArray(claim.targets) && claim.targets.length > 0) {
    return claim.targets.flatMap((target, i) => {
      const [sceneName, boxName] = target.includes('/') ? target.split('/') : [null, target]
      return boxes.map((box, index) => ({box, index}))
        .filter(({box}) => box.name === boxName && (sceneName === null || scenes[box.scene].name === sceneName))
        .map(({index}) => ({box: index, primary: i === 0}))
    })
  }
  const tokens = String(claim.name).split(/[^A-Za-z0-9_-]+/).filter(Boolean)
  const sceneNames = scenes.map(scene => scene.name)
  let inScenes = new Set(scenes.map((_, si) => si))
  if (scenes.length > 1) {
    const named = new Set(sceneNames.flatMap((name, si) => tokens.includes(name) ? [si] : []))
    if (named.size > 0) inScenes = named
  }
  const targets = []
  let first = null
  for (const token of tokens) {
    if (scenes.length > 1 && sceneNames.includes(token)) continue
    const matched = boxes.flatMap((box, index) => box.name === token && inScenes.has(box.scene) ? [index] : [])
    if (matched.length === 0) continue
    if (first === null) first = token
    for (const index of matched) if (!targets.some(t => t.box === index)) targets.push({box: index, primary: token === first})
  }
  return targets
}

const rectOf = (rect, wires) => rect.map(wire => wires[wire])

// Scenes that name a frame share that frame's device. Otherwise scenes that
// overlap on the screen are states of one screen, e.g. loading and loaded:
// each gets its own device; scenes that don't overlap share one.
function framesOf(version, wires) {
  if (version.scenes.some(scene => typeof scene.frame === 'string')) {
    const groups = []
    version.scenes.forEach((scene, si) => {
      const key = scene.frame ?? `scene:${scene.name}`
      const group = groups.find(g => g.key === key)
      if (group) group.scenes.push(si)
      else groups.push({key, scenes: [si]})
    })
    return groups.map(({scenes}) => {
      const labels = scenes.map(si => version.scenes[si].label).filter(label => label && label !== 'Screen')
      return {scenes, label: labels.length > 0 ? labels.join(' · ') : 'Screen', overlays: overlaysFor(version, scenes)}
    })
  }
  const rects = version.scenes.map(scene => rectOf([scene.x, scene.y, scene.width, scene.height], wires))
  let overlap = false
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [ax, ay, aw, ah] = rects[i], [bx, by, bw, bh] = rects[j]
    if (Math.min(ax + aw, bx + bw) > Math.max(ax, bx) && Math.min(ay + ah, by + bh) > Math.max(ay, by)) overlap = true
  }
  if (overlap) return version.scenes.map((scene, si) => ({scenes: [si], label: scene.label ?? scene.name, overlays: overlaysFor(version, [si])}))
  const all = version.scenes.map((_, si) => si)
  const labels = version.scenes.map(scene => scene.label).filter(Boolean)
  return [{scenes: all, label: labels.length > 0 ? labels.join(' · ') : 'Screen', overlays: overlaysFor(version, all)}]
}

const overlaysFor = (version, sceneIndexes) => version.overlays.flatMap((overlay, oi) => {
  if (typeof overlay.scene !== 'string') return [oi]
  return sceneIndexes.some(si => version.scenes[si].name === overlay.scene) ? [oi] : []
})

// Every box's place on the screen.
function placeBoxes(prep, wires) {
  const places = new Float64Array(prep.boxes.length * 4)
  prep.boxes.forEach((box, i) => {
    let x, y
    if (box.parent < 0) {
      const scene = prep.version.scenes[box.scene]
      x = wires[scene.x] + wires[box.node.left]
      y = wires[scene.y] + wires[box.node.top]
    } else {
      x = places[box.parent * 4] + wires[box.node.left]
      y = places[box.parent * 4 + 1] + wires[box.node.top]
    }
    places[i * 4] = x
    places[i * 4 + 1] = y
    places[i * 4 + 2] = wires[box.node.width]
    places[i * 4 + 3] = wires[box.node.height]
  })
  return places
}

// ---------------------------------------------------------------------------
// State

const S = {
  index: [], data: {}, errors: {},
  route: {check: null, example: null, version: null},
  prep: null, values: [], wires: null, status: [],
  remembered: {}, // example -> knob name -> last value, kept across its versions
  anim: null, every: false, hover: -1, onlyBroken: false, actual: false,
  colors: {}, ui: null, drawQueued: false,
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const $ = (selector, root = document) => root.querySelector(selector)

function readColors() {
  const style = getComputedStyle(document.documentElement)
  for (const name of ['ink', 'muted', 'faint', 'green', 'red', 'red-soft', 'green-soft', 'focus', 'pv-stage', 'pv-bezel', 'pv-screen', 'pv-surface', 'pv-button', 'pv-button-ink', 'pv-text', 'pv-tint', 'pv-faint', 'pv-overlay', 'pv-guide']) {
    S.colors[name] = style.getPropertyValue(`--${name}`).trim()
  }
}

// ---------------------------------------------------------------------------
// Loading and navigation

async function load() {
  const status = $('#status')
  try {
    const response = await fetch('data/index.json', {cache: 'no-cache'})
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    S.index = await response.json()
  } catch (error) {
    status.textContent = `Couldn't load data/index.json (${error.message}). Run bun yoga/probe.ts first, and serve this folder over HTTP.`
    return
  }
  renderNav()
  await Promise.all(S.index.map(async entry => {
    try {
      const response = await fetch(`data/${entry.file}`, {cache: 'no-cache'})
      if (!response.ok) throw new Error(`${response.status}`)
      S.data[entry.id] = await response.json()
    } catch (error) {
      S.errors[entry.id] = error.message
    }
    if (entry.id === currentRoute().check) route()
  }))
  route()
}

// A view's link: #check.example.version, e.g. #keyboard.sign-in.whole-screen.
// Ids are letters, digits, - and _, so the dots are plain to split on; an
// older link with slashes still works.
function currentRoute() {
  const [check, example, version] = decodeURIComponent(location.hash.slice(1)).split(/[./]/)
  const ids = S.index.map(entry => entry.id)
  return {check: ids.includes(check) ? check : ids[0], example, version}
}

function go(check, example, version) {
  setHash([check, example, version])
  route()
}

function setHash(ids) {
  const hash = '#' + ids.filter(Boolean).join('.')
  if (location.hash !== hash) history.replaceState(null, '', hash)
}

// The link to share this view: the page's published address, which the
// published copy names in a meta tag, since inside its frame the page can't
// see it, or else its own address.
function shareLink() {
  const base = document.querySelector('meta[name="share-base"]')?.content || location.href.split('#')[0]
  return `${base}${location.hash}`
}

async function copyLink(button) {
  const link = shareLink()
  const shown = button.closest('.share').querySelector('.link-text')
  try {
    await navigator.clipboard.writeText(link)
    button.textContent = 'Link copied'
    shown.hidden = true
  } catch {
    // No clipboard here: the link, selected, to copy by hand.
    shown.hidden = false
    shown.value = link
    shown.select()
    button.textContent = 'Copy the link'
  }
  clearTimeout(button.timer)
  button.timer = setTimeout(() => { button.textContent = 'Copy link' }, 1800)
}

function renderNav() {
  $('#checks-count').textContent = S.index.length
  const list = $('#checks-list')
  list.innerHTML = S.index.map(entry => `<li><a href="#${encodeURIComponent(entry.id)}" data-check="${escapeHtml(entry.id)}">
    <span class="t">${escapeHtml(entry.title)}</span><span class="q">${escapeHtml(entry.question)}</span></a></li>`).join('')
  list.addEventListener('click', event => {
    const link = event.target.closest('a[data-check]')
    if (!link) return
    event.preventDefault()
    go(link.dataset.check)
    if (window.matchMedia('(max-width: 860px)').matches) $('#checks-details').open = false
    $('#main').scrollIntoView({block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth'})
  })
  if (window.matchMedia('(max-width: 860px)').matches) $('#checks-details').open = false
}

function route() {
  const wanted = currentRoute()
  for (const link of document.querySelectorAll('#checks-list a')) link.setAttribute('aria-current', String(link.dataset.check === wanted.check))
  const main = $('#main')
  const check = S.data[wanted.check]
  if (!check) {
    stopAnimation()
    S.prep = null
    S.route = {check: wanted.check}
    main.innerHTML = `<p class="loading">${S.errors[wanted.check] ? `Couldn't load this check (${escapeHtml(S.errors[wanted.check])}).` : 'Loading…'}</p>`
    return
  }
  const example = check.examples.find(e => e.id === wanted.example) ?? check.examples[0]
  if (!example) {
    main.innerHTML = '<p class="loading">This check has no examples yet.</p>'
    return
  }
  const version = example.versions.find(v => v.id === wanted.version) ?? example.versions[0]
  const same = S.route.check === check.id && S.route.example === example.id && S.route.version === version.id && S.prep
  if (same) return
  const sameCheck = S.route.check === check.id && $('.check-head', main)
  S.route = {check: check.id, example: example.id, version: version.id}
  setHash([check.id, example.id, version.id])
  if (!sameCheck) renderCheck(check)
  renderExample(check, example)
  enterVersion(check, example, version)
}

// ---------------------------------------------------------------------------
// The check's page

function renderCheck(check) {
  $('#main').innerHTML = `
    <div class="check-head">
      <div><h2>${escapeHtml(check.title)}</h2>
        <p class="question">${escapeHtml(check.question)}</p></div>
      <div class="share"><button type="button" class="link">Copy link</button>
        <input class="link-text" type="text" readonly aria-label="Link to this example" hidden></div>
    </div>
    <div class="tabs" role="tablist" aria-label="Examples"></div>
    <div class="versions" role="group" aria-label="Versions"></div>
    <div class="bench">
      <section class="preview" aria-label="Preview">
        <div class="preview-bar"><span class="verdict" aria-live="polite"></span><span class="caption" aria-live="polite"></span>
          <button type="button" class="zoom" aria-pressed="false">Actual size</button></div>
        <div class="frames"></div>
      </section>
      <section class="mixer" aria-label="Inputs">
        <h3>Inputs</h3>
        <div class="knobs"></div>
        <p class="mixer-note"></p>
        <div class="mixer-actions"><button type="button" class="primary find">Find a case that breaks</button></div>
      </section>
    </div>
    <div class="below">
      <section class="panel" aria-label="At these sizes">
        <div class="panel-head"><h3>At these sizes</h3>
          <label class="filter"><input type="checkbox" class="only-broken"> only what doesn't fit</label></div>
        <p class="summary"></p>
        <ol class="rules"></ol>
      </section>
      <section class="panel answer" aria-label="For every size in range">
        <h3>For every size in range</h3>
        <div class="answer-body"></div>
      </section>
    </div>`
  const main = $('#main')
  $('.link', main).addEventListener('click', event => copyLink(event.currentTarget))
  $('.find', main).addEventListener('click', () => search())
  const zoom = $('.zoom', main)
  const showZoom = () => {
    zoom.setAttribute('aria-pressed', String(S.actual))
    zoom.textContent = S.actual ? 'Fit to view' : 'Actual size'
    $('.preview', main).classList.toggle('actual', S.actual)
  }
  showZoom()
  zoom.addEventListener('click', () => {
    S.actual = !S.actual
    showZoom()
    for (const f of S.ui?.frames ?? []) f.focusPending = S.actual
    update()
  })
  $('.only-broken', main).checked = S.onlyBroken
  $('.only-broken', main).addEventListener('change', event => {
    S.onlyBroken = event.target.checked
    update()
  })
  $('.rules', main).addEventListener('click', event => {
    const badge = event.target.closest('button.badge.refuted')
    if (!badge) return
    const claim = S.prep.claims[Number(badge.closest('li').dataset.i)]
    jumpTo(claim.source, `Breaks here: ${claim.says}`)
  })
  $('.rules', main).addEventListener('mouseover', event => {
    const li = event.target.closest('li')
    const i = li ? Number(li.dataset.i) : -1
    if (i !== S.hover) { S.hover = i; requestDraw() }
  })
  $('.rules', main).addEventListener('mouseleave', () => { S.hover = -1; requestDraw() })
}

function renderExample(check, example) {
  const main = $('#main')
  const tabs = $('.tabs', main)
  tabs.innerHTML = check.examples.map(e => `<button role="tab" type="button" data-example="${escapeHtml(e.id)}" aria-selected="${e.id === example.id}">${escapeHtml(e.title)}</button>`).join('')
  tabs.onclick = event => {
    const button = event.target.closest('button[data-example]')
    if (button) go(check.id, button.dataset.example)
  }
  const versions = $('.versions', main)
  versions.innerHTML = example.versions.map(v => {
    const kind = versionKind(v)
    const title = kind === 'fits' ? 'Fits at every size' : kind === 'breaks' ? 'Breaks for some sizes' : 'Not fully decided'
    return `<button type="button" data-version="${escapeHtml(v.id)}" title="${title}"><span class="dot ${kind}" aria-hidden="true"></span>${escapeHtml(v.label)}<span class="sr">, ${title.toLowerCase()}</span></button>`
  }).join('')
  versions.onclick = event => {
    const button = event.target.closest('button[data-version]')
    if (button) go(check.id, example.id, button.dataset.version)
  }
}

function versionKind(version) {
  const statuses = version.claims.map(claim => claim.status)
  if (statuses.includes('refuted')) return 'breaks'
  if (statuses.length > 0 && statuses.every(s => s === 'proven')) return 'fits'
  return 'open'
}

function enterVersion(check, example, version) {
  stopAnimation()
  const main = $('#main')
  for (const button of document.querySelectorAll('.versions button')) button.setAttribute('aria-pressed', String(button.dataset.version === version.id))
  const prep = prepare(check, example, version)
  S.prep = prep
  S.every = false
  S.hover = -1
  const remembered = S.remembered[`${check.id}/${example.id}`] ??= {}
  S.values = prep.knobs.map(knob => {
    const kept = remembered[knob.name]
    return kept === undefined ? knob.base : Math.min(knob.high, Math.max(knob.low, kept))
  })
  const ui = {frames: [], knobs: [], rules: []}
  S.ui = ui

  // Devices
  const frames = $('.frames', main)
  frames.classList.toggle('many', prep.frames.length > 1)
  frames.innerHTML = prep.frames.map((frame, fi) => `<figure class="frame" data-f="${fi}"><div class="viewport"><canvas role="img"></canvas></div>
    <figcaption><b>${escapeHtml(frame.label)}</b><span class="mono size"></span></figcaption></figure>`).join('')
  for (const figure of frames.querySelectorAll('.frame')) {
    const canvas = $('canvas', figure)
    ui.frames.push({canvas, ctx: canvas.getContext('2d'), viewport: $('.viewport', figure), size: $('.size', figure), frame: prep.frames[Number(figure.dataset.f)], focusPending: S.actual})
  }
  S.resize?.disconnect()
  S.resize = new ResizeObserver(() => requestDraw())
  S.resize.observe(frames)

  // Knobs
  const knobs = $('.knobs', main)
  const mixer = $('.mixer', main)
  mixer.classList.remove('every')
  knobs.innerHTML = prep.knobs.map((knob, i) => `<div class="knob">
      <span class="knob-label" id="knob-${i}">${escapeHtml(knob.label ?? knob.name)}</span>
      <input class="knob-value" type="text" inputmode="decimal" aria-label="${escapeHtml(knob.label ?? knob.name)} in px" spellcheck="false">
      <span class="range-end">${fmt(knob.high)}</span>
      <div class="fader" role="slider" tabindex="0" aria-labelledby="knob-${i}" aria-valuemin="${knob.low}" aria-valuemax="${knob.high}">
        <div class="track"><div class="fill"></div><div class="all"></div></div>
        <div class="tick base"></div><div class="tick break"></div><div class="thumb"></div>
      </div>
      <span class="range-end">${fmt(knob.low)}</span>
    </div>`).join('')
  knobs.querySelectorAll('.knob').forEach((el, i) => {
    const k = {el, input: $('.knob-value', el), fader: $('.fader', el), fill: $('.fill', el), thumb: $('.thumb', el), base: $('.tick.base', el), brk: $('.tick.break', el)}
    ui.knobs.push(k)
    bindKnob(i, k)
  })
  const placeTick = (tick, i, value) => {
    const knob = prep.knobs[i]
    tick.style.bottom = `calc(8px + (100% - 16px) * ${(value - knob.low) / (knob.high - knob.low)})`
  }
  ui.knobs.forEach((k, i) => {
    placeTick(k.base, i, prep.knobs[i].base)
    if (prep.refuted) {
      k.fader.classList.add('has-break')
      placeTick(k.brk, i, prep.refuted.source[i])
    }
  })
  $('.mixer-note', main).innerHTML = [
    '<span class="legend"><span class="sw" style="background:var(--faint)"></span>starting value</span>',
    prep.refuted ? '<span class="legend"><span class="sw" style="background:var(--red)"></span>a case that breaks</span>' : '',
    prep.kind === 'fits' || prep.kind === 'open' ? '<span class="legend every-legend" hidden><span class="sw" style="background:var(--green)"></span>checked, every value</span>' : '',
  ].join('')

  // Rules
  const rules = $('.rules', main)
  rules.innerHTML = prep.claims.map((claim, i) => {
    const badge = claim.status === 'proven' ? '<span class="badge proven">fits at every size</span>'
      : claim.status === 'refuted' ? `<button type="button" class="badge refuted" title="Set the inputs to this case">breaks: show</button>`
      : claim.status === 'unknown' ? '<span class="badge" title="The checker ran out of time on this one">not decided</span>' : ''
    return `<li data-i="${i}"><span class="mark" aria-hidden="true"></span><span class="says">${escapeHtml(claim.says ?? claim.name)}</span>${badge}<span class="now"></span></li>`
  }).join('')
  rules.querySelectorAll('li').forEach(li => ui.rules.push({li, mark: $('.mark', li), now: $('.now', li)}))

  renderAnswer(prep)
  ui.verdict = $('.verdict', main)
  ui.caption = $('.caption', main)
  ui.summary = $('.summary', main)
  ui.mixer = mixer
  setCaption('')
  update()
}

function renderAnswer(prep) {
  const body = $('.answer-body')
  const {counts, claims, knobs} = prep
  const total = claims.length
  const ranges = `<dl>${knobs.map(knob => `<dt>${escapeHtml(knob.label ?? knob.name)}</dt><dd>${fmt(knob.low)} – ${fmt(knob.high)} px</dd>`).join('')}</dl>`
  const seconds = claims.reduce((sum, claim) => sum + (claim.milliseconds ?? 0), 0) / 1000
  const time = counts.none < total ? `<p class="foot-note">The checker spent ${seconds < 0.05 ? 'under 0.1' : fmt(Math.round(seconds * 10) / 10)} s on these ${total} rules${counts.unknown ? `, and gave up on ${counts.unknown} when its time ran out` : ''}.${steps(knobs)}</p>` : ''
  let html
  if (prep.kind === 'breaks') {
    const claim = prep.refuted
    const confirmed = claim?.confirmed === true ? '<p class="muted">The real Yoga engine lays out this case the same way, so it breaks in the app too.</p>'
      : claim?.confirmed === false ? '<p class="muted">Careful: the real Yoga engine lays out this case differently from the copy here.</p>' : ''
    html = `<h4 class="breaks">Breaks for some sizes</h4>
      <p>${counts.refuted} of ${total} rules break somewhere in range${counts.unknown ? `, and ${counts.unknown} could not be decided in the time given` : ''}.</p>
      ${claim ? `<p>For example, “${escapeHtml(claim.says)}” breaks at:</p>
      <dl>${knobs.map((knob, i) => `<dt>${escapeHtml(knob.label ?? knob.name)}</dt><dd>${fmt(claim.source[i])} px</dd>`).join('')}</dl>${confirmed}
      <div class="actions"><button type="button" class="jump">Show this case</button></div>` : ''}`
  } else if (prep.kind === 'fits' || prep.kind === 'open') {
    const all = prep.kind === 'fits'
    html = `<h4 class="${all ? 'fits' : ''}">${all ? 'Checked for every size: fits' : 'No size found that breaks it'}</h4>
      <p>${all ? `All ${total} rules hold for every combination of these inputs:` : `${counts.proven} of ${total} rules hold for every combination of these inputs; ${counts.unknown} could not be decided in the time given.`}</p>
      ${ranges}
      <p class="count-line off" aria-live="polite">${all ? 'Fits' : `${counts.proven} of ${total} rules hold`} at every one of ${combinations(knobs)} combinations.</p>`
  } else {
    html = '<h4>Not checked yet</h4><p class="muted">Run <code>bun yoga/probe.ts</code> to check this layout for every size in range.</p>'
  }
  body.innerHTML = html + time
  $('.jump', body)?.addEventListener('click', () => jumpTo(prep.refuted.source, `Breaks here: ${prep.refuted.says}`))
}

// ---------------------------------------------------------------------------
// Knobs

function snap(knob, value, coarse) {
  const clamped = Math.min(knob.high, Math.max(knob.low, value))
  const step = coarse && knob.grid < 1 ? 1 : knob.grid
  const snapped = knob.low + Math.round((clamped - knob.low) / step) * step
  return Math.min(knob.high, Math.max(knob.low, snapped))
}

// The viewer moved a knob: an animation stops, and a caption about a case
// that breaks no longer describes what is shown.
function userChange() {
  stopAnimation()
  if (S.ui?.caption.classList.contains('breaks')) setCaption('')
}

function setKnob(i, value) {
  S.values[i] = value
  S.remembered[`${S.prep.check.id}/${S.prep.example.id}`][S.prep.knobs[i].name] = value
}

function bindKnob(i, k) {
  const knob = () => S.prep.knobs[i]
  let grab = null
  const valueAt = clientY => {
    const rect = k.fader.getBoundingClientRect()
    const top = rect.top + 8, height = rect.height - 16
    const fraction = 1 - (clientY - top - (grab ?? 0)) / height
    return knob().low + fraction * (knob().high - knob().low)
  }
  k.fader.addEventListener('pointerdown', event => {
    event.preventDefault()
    userChange()
    k.fader.focus()
    k.fader.setPointerCapture(event.pointerId)
    const thumb = k.thumb.getBoundingClientRect()
    const centre = thumb.top + thumb.height / 2
    grab = Math.abs(event.clientY - centre) < 14 ? event.clientY - centre : 0
    setKnob(i, snap(knob(), valueAt(event.clientY), true))
    requestDraw()
  })
  k.fader.addEventListener('pointermove', event => {
    if (grab === null) return
    setKnob(i, snap(knob(), valueAt(event.clientY), true))
    requestDraw()
  })
  const release = () => { grab = null }
  k.fader.addEventListener('pointerup', release)
  k.fader.addEventListener('pointercancel', release)
  k.fader.addEventListener('keydown', event => {
    const {low, high, grid} = knob()
    const step = Math.max(grid, 1) * (event.shiftKey ? 10 : 1)
    const value = S.values[i]
    const next = {ArrowUp: value + step, ArrowRight: value + step, ArrowDown: value - step, ArrowLeft: value - step,
      PageUp: value + (high - low) / 10, PageDown: value - (high - low) / 10, Home: low, End: high}[event.key]
    if (next === undefined) return
    event.preventDefault()
    userChange()
    setKnob(i, snap(knob(), next, false))
    requestDraw()
  })
  const commit = () => {
    const value = Number.parseFloat(k.input.value.replace('−', '-').replace(',', '.'))
    if (Number.isFinite(value)) {
      userChange()
      setKnob(i, snap(knob(), value, false))
    }
    update()
  }
  k.input.addEventListener('change', commit)
  k.input.addEventListener('keydown', event => { if (event.key === 'Enter') { commit(); k.input.select() } })
}

// ---------------------------------------------------------------------------
// Live update

function requestDraw() {
  if (S.drawQueued) return
  S.drawQueued = true
  requestAnimationFrame(() => {
    S.drawQueued = false
    if (S.anim === null) update()
  })
}

function update() {
  const prep = S.prep
  const ui = S.ui
  if (!prep || !ui) return
  const wires = evaluate(prep, S.values)
  S.wires = wires
  let broken = 0
  S.status = prep.claims.map(claim => {
    const value = wires[claim.wire]
    const ok = value >= claim.min && value <= claim.max
    if (!ok) broken++
    const excess = Number.isNaN(value) ? NaN : value < claim.min ? claim.min - value : value - claim.max
    const spare = Math.min(value - claim.min, claim.max - value)
    return {value, ok, excess, spare}
  })

  ui.knobs.forEach((k, i) => {
    const knob = prep.knobs[i]
    const value = S.values[i]
    const fraction = (value - knob.low) / (knob.high - knob.low)
    k.fill.style.height = `${fraction * 100}%`
    k.thumb.style.bottom = `calc(8px + (100% - 16px) * ${fraction})`
    if (document.activeElement !== k.input) k.input.value = fmt(value)
    k.fader.setAttribute('aria-valuenow', String(value))
    k.fader.setAttribute('aria-valuetext', `${fmt(value)} px`)
  })

  const total = prep.claims.length
  ui.rules.forEach((row, i) => {
    const status = S.status[i]
    row.li.classList.toggle('ok', status.ok)
    row.li.classList.toggle('bad', !status.ok)
    row.li.classList.toggle('hidden', S.onlyBroken && status.ok)
    row.li.classList.toggle('hover', S.hover === i)
    row.li.style.order = status.ok ? String(i + total) : String(i)
    row.mark.textContent = status.ok ? '✓' : '✗'
    row.now.textContent = status.ok
      ? !Number.isFinite(status.spare) ? 'fits' : status.spare < 0.002 ? 'right at the edge' : `${fmt(status.spare)} px to spare`
      : Number.isFinite(status.excess) ? `off by ${fmt(status.excess)} px` : 'not a number here'
  })
  if (total === 0) {
    ui.summary.className = 'summary'
    ui.summary.textContent = 'This version has no rules.'
  } else if (broken === 0) {
    ui.summary.className = 'summary fits'
    ui.summary.textContent = `Fits: all ${total} rules hold.`
  } else {
    ui.summary.className = 'summary breaks'
    ui.summary.textContent = `Doesn't fit: ${broken} of ${total} rules ${broken === 1 ? 'is' : 'are'} broken.`
  }
  ui.verdict.className = `verdict ${broken === 0 ? 'fits' : 'breaks'}`
  ui.verdict.textContent = broken === 0 ? '✓ Fits at these sizes' : `✗ Doesn't fit: ${broken} ${broken === 1 ? 'rule' : 'rules'} broken`

  ui.frames.forEach(f => drawFrame(f, prep, wires))
}

function setCaption(text, kind = '') {
  if (!S.ui) return
  S.ui.caption.textContent = text
  S.ui.caption.className = `caption ${kind}`
}

// ---------------------------------------------------------------------------
// Drawing

const SANS = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace"

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

// The text cut with an ellipsis to fit a width.
function fitText(ctx, text, width) {
  if (width <= 0) return ''
  if (ctx.measureText(text).width <= width) return text
  if (ctx.measureText('…').width > width) return ''
  let low = 0, high = text.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (ctx.measureText(text.slice(0, mid).trimEnd() + '…').width <= width) low = mid
    else high = mid - 1
  }
  return text.slice(0, low).trimEnd() + '…'
}

function drawFrame(f, prep, wires) {
  const {canvas, ctx, frame} = f
  const C = S.colors
  // The screen: every scene and overlay of this device, from the top left.
  const version = prep.version
  let sw = 0, sh = 0
  for (const si of frame.scenes) {
    const scene = version.scenes[si]
    sw = Math.max(sw, wires[scene.x] + wires[scene.width])
    sh = Math.max(sh, wires[scene.y] + wires[scene.height])
  }
  for (const oi of frame.overlays) {
    const overlay = version.overlays[oi]
    if (overlay.role === 'guide') continue
    const [x, y, w, h] = rectOf(overlay.rect, wires)
    if (Number.isFinite(x + w)) sw = Math.max(sw, x + w)
    if (Number.isFinite(y + h)) sh = Math.max(sh, y + h)
  }
  if (!(sw > 0) || !(sh > 0)) return

  // What sticks out of the screen is shown too, faded, up to half a screen.
  const places = placeBoxes(prep, wires)
  const inFrame = prep.boxes.map(box => frame.scenes.includes(box.scene))
  let x0 = 0, y0 = 0, x1 = sw, y1 = sh
  prep.boxes.forEach((box, i) => {
    if (!inFrame[i] || box.role === 'hidden') return
    const [x, y, w, h] = places.subarray(i * 4, i * 4 + 4)
    if (!Number.isFinite(x + y + w + h)) return
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h)
  })
  x0 = Math.max(x0, -sw * 0.5); y0 = Math.max(y0, -sh * 0.5); x1 = Math.min(x1, sw * 1.5); y1 = Math.min(y1, sh * 1.5)
  const bezel = 7, pad = 12
  // Fit: the device scaled to the canvas. Actual size: 1 px is 1 px, and the
  // canvas scrolls inside its frame.
  if (S.actual) {
    canvas.style.width = `${Math.max(f.viewport.clientWidth, Math.ceil(x1 - x0 + 2 * (pad + bezel)))}px`
    canvas.style.height = `${Math.ceil(y1 - y0 + 2 * (pad + bezel))}px`
  } else {
    // Fit: as tall as the device needs at this width, up to the stylesheet's
    // height. The shape is taken once per version, so the page below doesn't
    // move while a knob is dragged.
    if (canvas.style.width) canvas.style.width = ''
    f.aspect ??= (y1 - y0) / (x1 - x0)
    const most = window.innerWidth <= 520 ? 300 : Math.min(Math.max(window.innerHeight * (S.ui.frames.length > 1 ? 0.44 : 0.52), 240), S.ui.frames.length > 1 ? 420 : 480)
    const width = f.viewport.clientWidth
    canvas.style.height = `${Math.round(Math.min(most, Math.max(180, (width - 2 * (pad + bezel)) * f.aspect + 2 * (pad + bezel))))}px`
  }
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight
  if (cssW === 0 || cssH === 0) return
  // At most about 16 million pixels, however large the screen.
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (cssW * cssH)))
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  const scale = S.actual ? 1 : Math.min((cssW - 2 * (pad + bezel)) / (x1 - x0), (cssH - 2 * (pad + bezel)) / (y1 - y0))
  const ox = (cssW - (x1 - x0) * scale) / 2 - x0 * scale
  const oy = (cssH - (y1 - y0) * scale) / 2 - y0 * scale
  const X = x => ox + x * scale, Y = y => oy + y * scale
  f.size.textContent = `${fmt(sw)} × ${fmt(sh)} px · ${scale >= 0.995 ? '100' : Math.max(1, Math.round(scale * 100))}%`

  // Device
  ctx.fillStyle = C['pv-bezel']
  roundRect(ctx, X(0) - bezel, Y(0) - bezel, sw * scale + 2 * bezel, sh * scale + 2 * bezel, 14)
  ctx.fill()
  ctx.fillStyle = C['pv-screen']
  roundRect(ctx, X(0), Y(0), sw * scale, sh * scale, 7)
  ctx.fill()

  const drawBoxes = () => {
    prep.boxes.forEach((box, i) => {
      if (!inFrame[i]) return
      const [x, y, w, h] = places.subarray(i * 4, i * 4 + 4)
      if (!Number.isFinite(x + y + w + h) || w < 0 || h < 0) return
      drawBox(ctx, box, X(x), Y(y), w * scale, h * scale, scale, wires)
    })
  }
  // Outside the screen, faded.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, cssW, cssH)
  ctx.rect(X(0), Y(0), sw * scale, sh * scale)
  ctx.clip('evenodd')
  ctx.globalAlpha = 0.32
  drawBoxes()
  ctx.restore()
  // On the screen.
  ctx.save()
  roundRect(ctx, X(0), Y(0), sw * scale, sh * scale, 7)
  ctx.clip()
  drawBoxes()
  for (const oi of frame.overlays) {
    const overlay = version.overlays[oi]
    if (overlay.role === 'keyboard' || overlay.role === 'inset') drawOverlay(ctx, overlay, rectOf(overlay.rect, wires), X, Y, scale)
  }
  ctx.restore()
  for (const oi of frame.overlays) {
    const overlay = version.overlays[oi]
    if (overlay.role !== 'keyboard' && overlay.role !== 'inset') drawOverlay(ctx, overlay, rectOf(overlay.rect, wires), X, Y, scale)
  }

  // What doesn't fit, marked, with by how much.
  const worst = new Map()
  const secondary = new Set()
  prep.claims.forEach((claim, ci) => {
    const status = S.status[ci]
    if (status.ok) return
    for (const target of claim.targets) {
      if (!inFrame[target.box]) continue
      if (target.primary) worst.set(target.box, Math.max(worst.get(target.box) ?? -Infinity, Number.isFinite(status.excess) ? status.excess : -Infinity))
      else secondary.add(target.box)
    }
  })
  const rectAt = i => {
    const [x, y, w, h] = places.subarray(i * 4, i * 4 + 4)
    return [X(x), Y(y), Math.max(w * scale, 1), Math.max(h * scale, 1)]
  }
  ctx.save()
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = C.red
  for (const i of secondary) {
    if (worst.has(i)) continue
    const [x, y, w, h] = rectAt(i)
    if (Number.isFinite(x + y + w + h)) ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
  ctx.restore()
  const tags = []
  for (const [i, excess] of worst) {
    const [x, y, w, h] = rectAt(i)
    if (!Number.isFinite(x + y + w + h)) continue
    ctx.fillStyle = C['red-soft']
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = C.red
    ctx.lineWidth = 2
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2)
    if (Number.isFinite(excess)) tags.push({x: x + w, y, text: `${fmt(excess)} px`})
  }
  ctx.font = `500 11px ${MONO}`
  ctx.textBaseline = 'middle'
  const placed = []
  for (const tag of tags) {
    const width = ctx.measureText(tag.text).width + 10
    let tx = Math.min(Math.max(tag.x - width, 2), cssW - width - 2)
    let ty = Math.max(tag.y - 20, 2)
    while (placed.some(p => Math.abs(p.y - ty) < 18 && tx < p.x + p.w && p.x < tx + width)) ty += 19
    ty = Math.min(ty, cssH - 20)
    placed.push({x: tx, y: ty, w: width})
    tag.x = tx
    tag.y = ty
    tag.w = width
    ctx.fillStyle = C.red
    roundRect(ctx, tx, ty, width, 17, 4)
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(tag.text, tx + 5, ty + 9)
  }

  // The rule under the pointer: what it is about.
  if (S.hover >= 0 && prep.claims[S.hover]) {
    ctx.save()
    ctx.strokeStyle = C.focus
    ctx.lineWidth = 2
    for (const target of prep.claims[S.hover].targets) {
      if (!inFrame[target.box]) continue
      const [x, y, w, h] = rectAt(target.box)
      if (!target.primary) ctx.setLineDash([5, 3])
      else ctx.setLineDash([])
      if (Number.isFinite(x + y + w + h)) ctx.strokeRect(x - 2, y - 2, w + 4, h + 4)
    }
    ctx.restore()
  }

  const failing = [...worst.keys()].length
  if (S.actual && f.focusPending) {
    f.focusPending = false
    const tag = tags[0]
    if (tag) {
      f.viewport.scrollLeft = tag.x + tag.w / 2 - f.viewport.clientWidth / 2
      f.viewport.scrollTop = tag.y - f.viewport.clientHeight / 3
    }
  }
  canvas.setAttribute('aria-label', `${frame.label}: ${fmt(sw)} by ${fmt(sh)} px screen, ${failing === 0 && S.status.every(s => s.ok) ? 'everything fits' : "something doesn't fit"}`)
}

function drawText(ctx, text, x, y, w, h, scale, color, {size, weight = 400, align = 'left', paragraph = false}) {
  const px = size * scale
  if (px < 4) {
    // Too small to read: a line where the text is.
    ctx.fillStyle = color
    ctx.globalAlpha *= 0.35
    const lineH = Math.max(1, px * 0.7)
    const lineW = align === 'center' ? w * 0.7 : w
    ctx.fillRect(align === 'center' ? x + (w - lineW) / 2 : x, y + (h - lineH) / 2, lineW, lineH)
    ctx.globalAlpha /= 0.35
    return
  }
  ctx.font = `${weight} ${px}px ${SANS}`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.textAlign = align
  if (paragraph) {
    const lineH = px * 1.4
    const lines = Math.max(1, Math.floor(h / lineH))
    const words = text.split(/\s+/)
    let line = '', row = 0
    const out = []
    for (let wi = 0; wi < words.length; wi++) {
      const next = line ? `${line} ${words[wi]}` : words[wi]
      if (ctx.measureText(next).width <= w || !line) line = next
      else { out.push(line); line = words[wi] }
      if (out.length === lines) break
    }
    if (out.length < lines && line) out.push(line)
    const consumed = out.join(' ').split(/\s+/).length
    if (consumed < words.length && out.length > 0) out[out.length - 1] = fitText(ctx, out[out.length - 1] + ' ' + words.slice(consumed).join(' '), w)
    for (const l of out) {
      const shown = fitText(ctx, l, w)
      ctx.fillText(shown, align === 'center' ? x + w / 2 : x, y + lineH * (row + 0.5))
      row++
    }
  } else {
    ctx.fillText(fitText(ctx, text, w), align === 'center' ? x + w / 2 : x, y + h / 2)
  }
  ctx.textAlign = 'left'
}

// A text as long as the layout says it is: of the box's wordings, from
// shortest to longest, the longest whose width fits, at the font size its
// line height gives, spaced out a little to the exact width; the shortest,
// pressed together, when none fits. The result is what the measured leaf
// stands for, so it shows cut off only where the box is narrower than it.
const fitted = new Map()
const canSpace = typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype
function textOfWidth(ctx, wordings, width, size, weight) {
  const key = `${wordings.join('\n')}|${weight}|${size.toFixed(2)}|${width.toFixed(2)}`
  const known = fitted.get(key)
  if (known) return known
  ctx.font = `${weight} ${size}px ${SANS}`
  if (canSpace) ctx.letterSpacing = '0px'
  const widths = wordings.map(text => ctx.measureText(text).width)
  let pick = 0
  widths.forEach((w, i) => { if (w <= width) pick = i })
  const text = wordings[pick], natural = widths[pick]
  let spacing = 0, squeeze = 1
  if (natural > width) squeeze = width / natural
  else if (canSpace && text.length > 1) spacing = Math.min((width - natural) / (text.length - 1), 0.5 * size)
  const result = {text, spacing, squeeze}
  if (fitted.size > 4000) fitted.clear()
  fitted.set(key, result)
  return result
}

// A measured leaf's text, in its box: its own width and line height from
// the layout's numbers, inside its padding, cut with an ellipsis where the
// box is narrower and clipped where it is shorter.
function drawMeasuredText(ctx, box, x, y, w, h, scale, wires, {color, weight = 'auto', align = 'left'}) {
  const [cw, ch] = box.node.content.map(wire => wires[wire])
  const [pt, pr, pb, pl] = box.node.padding ?? [0, 0, 0, 0]
  const ix = x + pl * scale, iy = y + pt * scale
  const iw = w - (pl + pr) * scale, ih = h - (pt + pb) * scale
  const wordings = box.wordings
  if (!(cw > 0) || !(ch > 0) || wordings.length === 0 || !(iw > 0) || !(ih > 0)) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  // A paragraph: several lines, which the port can't wrap, stand for it as
  // one line far wider than its box; its lines fill the box.
  if (ch >= 44 && cw > 1.5 * iw / scale) {
    drawText(ctx, wordings[wordings.length - 1], ix, iy, iw, ih, scale, color, {size: 14, paragraph: true})
    ctx.restore()
    return
  }
  const size = Math.max(4, ch * 0.74)
  // A heading's line is tall: its text is bold.
  if (weight === 'auto') weight = size >= 17 ? 600 : 400
  const px = size * scale
  if (px < 4) {
    ctx.fillStyle = color
    ctx.globalAlpha *= 0.35
    const lineW = Math.min(cw * scale, iw)
    ctx.fillRect(align === 'center' ? ix + (iw - lineW) / 2 : ix, iy + ih / 2 - Math.max(0.5, px * 0.35), lineW, Math.max(1, px * 0.7))
    ctx.restore()
    return
  }
  const {text, spacing, squeeze} = textOfWidth(ctx, wordings, cw, size, weight)
  ctx.font = `${weight} ${px}px ${SANS}`
  if (canSpace) ctx.letterSpacing = `${spacing * scale}px`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  // Narrower than the text: cut, as a measured leaf would be.
  const fits = iw >= cw * scale - 0.5
  const shown = fits ? text : fitText(ctx, text, iw / squeeze)
  const shownWidth = ctx.measureText(shown).width * squeeze
  const left = align === 'center' ? ix + (iw - shownWidth) / 2 : ix
  ctx.translate(left, iy + ih / 2)
  ctx.scale(squeeze, 1)
  ctx.fillText(shown, 0, 0)
  if (canSpace) ctx.letterSpacing = '0px'
  ctx.restore()
}

function drawBox(ctx, box, x, y, w, h, scale, wires) {
  const C = S.colors
  const text = box.text ?? ''
  const measured = Array.isArray(box.node.content)
  switch (box.role) {
    case 'screen':
      if (box.parent >= 0) {
        ctx.fillStyle = C['pv-screen']
        ctx.fillRect(x, y, w, h)
      }
      break
    case 'surface':
      ctx.fillStyle = C['pv-surface']
      roundRect(ctx, x, y, w, h, Math.min(12 * scale, h / 4))
      ctx.fill()
      if (text) drawText(ctx, text, x + 12 * scale, y, w - 24 * scale, h, scale, C['pv-text'], {size: Math.min(15, h * 0.4)})
      break
    case 'button': {
      ctx.fillStyle = C['pv-button']
      roundRect(ctx, x, y, w, h, h / 2)
      ctx.fill()
      const inset = Math.min(12 * scale, h / 2)
      if (measured) drawMeasuredText(ctx, box, x, y, w, h, scale, wires, {color: C['pv-button-ink'], weight: 500, align: 'center'})
      else if (text) drawText(ctx, text, x + inset, y, w - 2 * inset, h, scale, C['pv-button-ink'], {size: Math.max(8, Math.min(16, h / scale * 0.44)), weight: 500, align: 'center'})
      break
    }
    case 'text': {
      const color = box.inButton ? C['pv-button-ink'] : C['pv-text']
      if (!box.inButton) {
        ctx.fillStyle = C['pv-tint']
        roundRect(ctx, x, y, w, h, 3 * scale)
        ctx.fill()
      }
      if (measured) {
        drawMeasuredText(ctx, box, x, y, w, h, scale, wires, {color, weight: box.inButton ? 500 : 'auto', align: box.inButton ? 'center' : 'left'})
        break
      }
      const hh = h / scale
      const paragraph = hh >= 44
      const size = paragraph ? 14 : Math.max(8, Math.min(22, hh * 0.72))
      if (text) drawText(ctx, text, x, y, w, h, scale, color, {size, weight: !paragraph && size >= 17 ? 600 : 400, paragraph})
      break
    }
    case 'icon': {
      ctx.strokeStyle = C['pv-faint']
      ctx.lineWidth = Math.max(1, 1.5 * scale)
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Math.min(6 * scale, w / 4))
      ctx.stroke()
      const r = Math.min(w, h) * 0.22
      ctx.beginPath()
      ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2)
      ctx.fillStyle = C['pv-faint']
      ctx.fill()
      break
    }
    case 'image': {
      ctx.save()
      roundRect(ctx, x, y, w, h, 4 * scale)
      ctx.fillStyle = C['pv-surface']
      ctx.fill()
      ctx.clip()
      ctx.strokeStyle = C['pv-faint']
      ctx.globalAlpha *= 0.5
      ctx.lineWidth = 1
      for (let d = -h; d < w; d += 7) {
        ctx.beginPath()
        ctx.moveTo(x + d, y + h)
        ctx.lineTo(x + d + h, y)
        ctx.stroke()
      }
      ctx.globalAlpha /= 0.5
      // A small mountain and sun.
      ctx.fillStyle = C['pv-faint']
      ctx.beginPath()
      ctx.moveTo(x + w * 0.15, y + h * 0.8)
      ctx.lineTo(x + w * 0.42, y + h * 0.42)
      ctx.lineTo(x + w * 0.6, y + h * 0.65)
      ctx.lineTo(x + w * 0.7, y + h * 0.55)
      ctx.lineTo(x + w * 0.88, y + h * 0.8)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.arc(x + w * 0.75, y + h * 0.28, Math.min(w, h) * 0.08, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
      break
    }
    case 'field': {
      ctx.fillStyle = C['pv-screen']
      roundRect(ctx, x, y, w, h, Math.min(8 * scale, h / 2))
      ctx.fill()
      ctx.strokeStyle = C['pv-faint']
      ctx.lineWidth = Math.max(1, 1.25 * scale)
      ctx.stroke()
      if (measured) drawMeasuredText(ctx, box, x, y, w, h, scale, wires, {color: C['pv-text'], weight: 400})
      else if (text) drawText(ctx, text, x + 10 * scale, y, w - 20 * scale, h, scale, C['pv-faint'], {size: Math.max(8, Math.min(15, h / scale * 0.42))})
      break
    }
    default:
      break
  }
}

function drawOverlay(ctx, overlay, rect, X, Y, scale) {
  const C = S.colors
  const [rx, ry, rw, rh] = rect
  if (!Number.isFinite(rx + ry + rw + rh)) return
  const x = X(rx), y = Y(ry), w = rw * scale, h = rh * scale
  const label = overlay.label ?? overlay.name
  ctx.save()
  ctx.font = `500 9.5px ${MONO}`
  ctx.textBaseline = 'middle'
  // A small label on a patch of the screen's color, so it reads over anything.
  const tagAt = (text, tx, ty, color) => {
    const tw = ctx.measureText(text).width
    ctx.globalAlpha = 0.85
    ctx.fillStyle = C['pv-screen']
    ctx.fillRect(tx - 2, ty - 6.5, tw + 4, 13)
    ctx.globalAlpha = 1
    ctx.fillStyle = color
    ctx.fillText(text, tx, ty)
  }
  if (overlay.role === 'keyboard') {
    ctx.fillStyle = C['pv-overlay']
    ctx.fillRect(x, y, w, h)
    ctx.fillRect(x, y, w, Math.max(1, scale))
    // Faint keys.
    const rows = 4, cols = 10
    const gap = Math.max(1, 5 * scale)
    const top = y + Math.max(14, h * 0.14)
    const keyH = (y + h - top - gap * (rows + 1)) / rows
    const keyW = (w - gap * (cols + 1)) / cols
    if (keyH > 2 && keyW > 2) {
      ctx.fillStyle = C['pv-overlay']
      for (let r = 0; r < rows; r++) {
        const n = r === 3 ? 1 : cols - (r === 2 ? 1 : 0)
        const width = r === 3 ? keyW * 5 + gap * 4 : keyW
        const start = x + (w - (n * width + (n - 1) * gap)) / 2
        for (let c = 0; c < n; c++) {
          roundRect(ctx, start + c * (width + gap), top + gap + r * (keyH + gap), width, keyH, Math.min(4 * scale, keyH / 3))
          ctx.fill()
        }
      }
    }
    ctx.fillStyle = C.muted
    ctx.textAlign = 'center'
    ctx.fillText(label, x + w / 2, y + Math.max(8, h * 0.07))
  } else if (overlay.role === 'inset') {
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.fillStyle = C['pv-overlay']
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = C['pv-faint']
    ctx.lineWidth = 1
    for (let d = -h; d < w; d += 6) {
      ctx.beginPath()
      ctx.moveTo(x + d, y + h)
      ctx.lineTo(x + d + h, y)
      ctx.stroke()
    }
    if (h >= 10 && w >= 40) tagAt(label, x + 6, y + h / 2, C.muted)
  } else if (overlay.role === 'native') {
    ctx.strokeStyle = C.muted
    ctx.lineWidth = 1.25
    ctx.setLineDash([5, 4])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])
    tagAt(label, x + 2, y + h + 8, C.muted)
  } else {
    ctx.strokeStyle = C['pv-guide']
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    if (rw === 0) { ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + h) } else if (rh === 0) { ctx.moveTo(x, y + 0.5); ctx.lineTo(x + w, y + 0.5) } else ctx.rect(x, y, w, h)
    ctx.stroke()
    ctx.setLineDash([])
    tagAt(label, x + 4, y + h - 8, C['pv-guide'])
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Animations

function stopAnimation() {
  if (S.anim) {
    S.anim = null
    setCaption('')
  }
}

function play(anim) {
  S.anim = anim
  const start = performance.now()
  const tick = now => {
    if (S.anim !== anim) return
    const t = (now - start) / 1000
    if (t >= anim.duration) {
      S.anim = null
      anim.end()
      return
    }
    anim.step(t)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function focusFailing() {
  for (const f of S.ui?.frames ?? []) f.focusPending = true
}

function jumpTo(source, caption) {
  stopAnimation()
  source.forEach((value, i) => setKnob(i, value))
  focusFailing()
  update()
  setCaption(caption, 'breaks')
}

// Catmull-Rom through points spaced evenly over [0, span].
function spline(points, span, t) {
  const n = points.length - 1
  const u = Math.min(Math.max(t / span, 0), 1) * n
  const k = Math.min(Math.floor(u), n - 1)
  const s = u - k
  const p0 = points[Math.max(k - 1, 0)], p1 = points[k], p2 = points[k + 1], p3 = points[Math.min(k + 2, n)]
  return 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s)
}

// Knobs wander, seeded, then each eases to the breaking case. The wander is
// chosen so that nothing breaks before the landing: every frame is evaluated
// while planning, and a wander that breaks early is drawn again.
function planBreak(prep, from, target) {
  const knobs = prep.knobs
  const n = knobs.length
  const breaks = values => !allHold(prep, evaluate(prep, values))
  let start = from
  if (breaks(start)) start = knobs.map(knob => knob.base)
  const canWander = !breaks(start)
  const stagger = 0.12, land = 1.4
  const landing = wander => {
    const landStart = i => wander + i * stagger
    return {landStart, total: wander + (n - 1) * stagger + land}
  }
  const makePath = (points, wander) => {
    const {landStart, total} = landing(wander)
    const span = wander + (n - 1) * stagger
    const at = t => knobs.map((knob, i) => {
      const clamp = v => Math.min(knob.high, Math.max(knob.low, v))
      const wandered = u => points ? clamp(spline(points[i], span, u)) : start[i]
      const ls = landStart(i)
      if (t < ls) return wandered(t)
      const from = wandered(ls)
      return from + (target[i] - from) * ease(Math.min(1, (t - ls) / land))
    })
    return {at, total}
  }
  const firstBreak = (path, until) => {
    for (let t = 0; t <= until; t += 1 / 24) if (breaks(path.at(t))) return t
    return Infinity
  }
  if (!canWander) return makePath(null, 0)
  const wander = 3.2
  const seed = hash(prep.key)
  let loose = null
  for (let attempt = 0; attempt < 48; attempt++) {
    const random = mulberry32(seed + attempt * 0x9E3779B1)
    const spread = 0.3 * (1 - attempt / 48) + 0.03
    const points = knobs.map((knob, i) => {
      const range = knob.high - knob.low
      const list = [start[i]]
      for (let k = 0; k < 4; k++) {
        // Reflected at the ends of the range, so a knob doesn't sit at one.
        let v = start[i] + (random() * 2 - 1) * spread * range
        if (v < knob.low) v = 2 * knob.low - v
        if (v > knob.high) v = 2 * knob.high - v
        list.push(Math.min(knob.high, Math.max(knob.low, v)))
      }
      return list
    })
    const path = makePath(points, wander)
    const broke = firstBreak(path, path.total - land * 0.12)
    if (broke === Infinity) return path
    if (loose === null && broke >= wander) loose = path
  }
  return loose ?? makePath(null, 0)
}

function findBreak() {
  const prep = S.prep
  if (!prep?.refuted) return
  stopAnimation()
  const target = prep.refuted.source
  const says = prep.refuted.says
  if (reducedMotion()) {
    jumpTo(target, `Breaks here: ${says}`)
    return
  }
  const path = planBreak(prep, S.values.slice(), target)
  const landAt = path.total - 1.4 - (prep.knobs.length - 1) * 0.12
  setCaption('Trying sizes…')
  play({
    duration: path.total,
    step(t) {
      path.at(t).forEach((value, i) => setKnob(i, value))
      update()
      if (t >= landAt && S.ui.caption.textContent === 'Trying sizes…') setCaption('Going to a case that breaks…')
    },
    end() {
      target.forEach((value, i) => setKnob(i, value))
      focusFailing()
      update()
      setCaption(`Breaks here: ${says}`, 'breaks')
    },
  })
}

// The button under the knobs: a version that breaks wanders to its case; one
// that doesn't is shaken across its whole ranges, every frame laid out and
// checked, and then shown to hold for every size.
function search() {
  if (S.prep?.refuted) findBreak()
  else fuzz()
}

function fuzz() {
  const prep = S.prep
  if (!prep) return
  stopAnimation()
  if (reducedMotion() || prep.knobs.length === 0) {
    everySize()
    return
  }
  const random = mulberry32(hash(prep.key) ^ (S.fuzzed = (S.fuzzed ?? 0) + 1))
  const duration = 4.5
  const points = prep.knobs.map((knob, i) => {
    const list = [S.values[i]]
    for (let k = 0; k < 6; k++) list.push(knob.low + random() * (knob.high - knob.low))
    list.push(S.values[i])
    return list
  })
  let tried = 0
  setCaption('Trying sizes…')
  play({
    duration,
    step(t) {
      prep.knobs.forEach((knob, i) => setKnob(i, snap(knob, spline(points[i], duration, t), false)))
      update()
      tried++
      // Can't happen for a version checked for every size; for one whose
      // check gave up on some rules, a case it couldn't decide.
      if (S.status.some(status => !status.ok)) {
        S.anim = null
        setCaption('Breaks here', 'breaks')
      }
    },
    end() {
      update()
      if (prep.kind === 'fits') everySize()
      else setCaption(`No case found that breaks it in ${tried} tries`)
    },
  })
}

function everySize() {
  const prep = S.prep
  const ui = S.ui
  if (!prep || !ui) return
  stopAnimation()
  const line = $('.count-line')
  const legend = $('.every-legend')
  ui.mixer.classList.remove('every')
  line?.classList.add('off')
  void ui.mixer.offsetWidth
  ui.mixer.classList.add('every')
  if (legend) legend.hidden = false
  S.every = true
  const all = prep.kind === 'fits'
  const text = `${all ? 'Fits' : `${prep.counts.proven} of ${prep.claims.length} rules hold`} at every one of ${combinationsText(prep.knobs)} combinations`
  setCaption(text, 'fits')
  const show = () => {
    if (S.prep === prep) line?.classList.remove('off')
  }
  if (reducedMotion()) show()
  else setTimeout(show, 1200)
}

// ---------------------------------------------------------------------------
// Theme

function setupTheme() {
  const button = $('#theme')
  const label = () => {
    const theme = document.documentElement.dataset.theme
    button.textContent = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'Auto'
    button.setAttribute('aria-label', `Color theme: ${button.textContent}`)
  }
  label()
  button.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme
    const next = theme === undefined ? 'light' : theme === 'light' ? 'dark' : undefined
    if (next === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    try {
      if (next === undefined) localStorage.removeItem('viz-theme')
      else localStorage.setItem('viz-theme', next)
    } catch {}
    label()
    readColors()
    update()
  })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    readColors()
    update()
  })
}

// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  readColors()
  setupTheme()
  window.addEventListener('hashchange', route)
  document.fonts?.ready.then(() => update())
  load()
}

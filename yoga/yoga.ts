// Yoga 3.2.1's layout algorithm (yoga/algorithm/CalculateLayout.cpp), ported
// for a subset of its style, over values that are FP32 constants or wires of a
// LayoutCircuit. With every input a constant, this computes Yoga's layout;
// with inputs as wires, it builds the circuit that computes it for every
// input. Each function follows the C++ one of the same name, statement by
// statement, so that each float operation happens in the same order: a branch
// on the style or on whether a value is defined stays a branch, and a branch
// on a computed value, e.g. remainingFreeSpace < 0, computes both sides and
// selects.
//
// The subset: left-to-right, flexDirection row or column, no wrap, justify and
// align without baseline, alignSelf, sizes, min and max sizes and flex basis in
// points, padding, margin and gap in points, flexGrow and flexShrink, aspect
// ratio, and leaf nodes measured by a function of the available size, e.g.
// text. Not: percent sizes, absolute positioning, auto margins, borders, display
// none, overflow scroll, reversed directions and pixel rounding, which the
// oracle turns off with a point scale factor of 0.
//
// Yoga's measurement cache changes results, so it is modeled too: a node
// measured again for an available size within 0.0001 of an earlier one, or one
// that its earlier result still fits, returns the earlier result, which can
// differ from measuring again in the last bits.
import {
  add, and, compare, divide, isDefined, isUndefined, maxOrDefined, minOrDefined, multiply, not, or, select, subtract,
  type LayoutCircuit, type Num,
} from './circuit.ts'

export type Justify = 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly'
export type Align = 'stretch' | 'flex-start' | 'center' | 'flex-end'
export type Edges = number | {top?: number, right?: number, bottom?: number, left?: number}

export type Style = {
  flexDirection?: 'row' | 'column'
  justifyContent?: Justify
  alignItems?: Align
  alignSelf?: 'auto' | Align
  width?: number | 'auto'
  height?: number | 'auto'
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  flexGrow?: number
  flexShrink?: number
  flexBasis?: number | 'auto'
  margin?: Edges
  padding?: Edges
  gap?: number
  columnGap?: number
  rowGap?: number
  // Width over height, positive and finite.
  aspectRatio?: number
}

// A content size: a number, an input by name, or the FP32 product of two,
// e.g. a label's width times the font scale.
export type Amount = number | string | {times: [Amount, Amount]}

// A node of the tree to lay out. A leaf with `measure` reports, for an
// available width and height, the size its content takes: the amount for
// width and height when unconstrained, the available size when exact, and the
// smaller of the two when at most, like a line of text that doesn't wrap.
export type Spec = {
  name: string
  style?: Style
  children?: Spec[]
  measure?: {width: Amount, height: Amount}
}

// An amount's value: a constant, an input's wire, or their product.
export function amountOf(c: LayoutCircuit, amount: Amount): Num {
  if (typeof amount === 'number') return Math.fround(amount)
  if (typeof amount === 'string') return c.input(amount)
  return multiply(c, amountOf(c, amount.times[0]), amountOf(c, amount.times[1]))
}

export type Layout = {name: string, left: Num, top: Num, width: Num, height: Num, children: Layout[]}

type Axis = 'row' | 'column'
type Mode = 'stretch-fit' | 'fit-content' | 'max-content'
type Dimension = 'width' | 'height'
type Edge = 'left' | 'top' | 'right' | 'bottom'

const dimensionOf = (axis: Axis): Dimension => axis === 'row' ? 'width' : 'height'
const startEdge = (axis: Axis): Edge => axis === 'row' ? 'left' : 'top'
const endEdge = (axis: Axis): Edge => axis === 'row' ? 'right' : 'bottom'
const crossOf = (axis: Axis): Axis => axis === 'row' ? 'column' : 'row'
const FLT_MAX = 3.4028234663852886e38

type Node = {
  spec: Spec
  parent: Node | null
  children: Node[]
  // Style as Yoga stores it: floats, with its defaults.
  direction: Axis
  justify: Justify
  alignItems: Align
  alignSelf: 'auto' | Align
  dimension: Record<Dimension, number>
  minDimension: Record<Dimension, number>
  maxDimension: Record<Dimension, number>
  flexGrow: number
  flexShrink: number
  flexBasis: number
  margin: Record<Edge, number>
  padding: Record<Edge, number>
  gap: Record<Axis, number>
  aspectRatio: number
  measure: {width: Num, height: Num} | undefined
  // Layout results, rewritten by each pass.
  measured: Record<Dimension, Num>
  size: Record<Dimension, Num>
  // Yoga's cache: the layout entry and the measurement slots, each as the
  // entries it may hold with a bit for each saying whether it does, and the
  // next slot to write.
  cachedLayout: Held[]
  cachedMeasurements: Held[][]
  nextCachedMeasurementsIndex: Num
  position: Record<Edge, Num>
  computedFlexBasis: Num
}

const f = Math.fround

type CacheEntry = {
  availableWidth: Num
  availableHeight: Num
  widthMode: Mode
  heightMode: Mode
  computedWidth: Num
  computedHeight: Num
}
type Held = {entry: CacheEntry, holds: Num}
// Yoga's LayoutResults::MaxCachedMeasurements; more would wrap around.
const maxCachedMeasurements = 8

function createNode(c: LayoutCircuit, spec: Spec, parent: Node | null): Node {
  const style = spec.style ?? {}
  const supported = new Set(['flexDirection', 'justifyContent', 'alignItems', 'alignSelf', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'flexGrow', 'flexShrink', 'flexBasis', 'margin', 'padding', 'gap', 'columnGap', 'rowGap', 'aspectRatio'])
  for (const key of Object.keys(style)) if (!supported.has(key)) throw new Error(`${spec.name}: unsupported style ${key}`)
  const points = (value: number | 'auto' | undefined) => value === undefined || value === 'auto' ? Number.NaN : f(value)
  const edges = (value: Edges | undefined): Record<Edge, number> => {
    const all = typeof value === 'number' ? value : 0
    const each = typeof value === 'object' ? value : {}
    return {left: f(each.left ?? all), top: f(each.top ?? all), right: f(each.right ?? all), bottom: f(each.bottom ?? all)}
  }
  const margin = edges(style.margin)
  const padding = edges(style.padding)
  for (const value of [...Object.values(margin), ...Object.values(padding), style.gap ?? 0, style.columnGap ?? 0, style.rowGap ?? 0]) {
    if (!(value >= 0)) throw new Error(`${spec.name}: negative margins, padding and gaps are not supported`)
  }
  if (style.aspectRatio !== undefined && !(style.aspectRatio > 0 && Number.isFinite(style.aspectRatio) && Number.isFinite(f(style.aspectRatio)))) {
    throw new Error(`${spec.name}: an aspect ratio is positive and finite`)
  }
  const node: Node = {
    spec, parent, children: [],
    direction: style.flexDirection ?? 'column',
    justify: style.justifyContent ?? 'flex-start',
    alignItems: style.alignItems ?? 'stretch',
    alignSelf: style.alignSelf ?? 'auto',
    dimension: {width: points(style.width), height: points(style.height)},
    minDimension: {width: points(style.minWidth), height: points(style.minHeight)},
    maxDimension: {width: points(style.maxWidth), height: points(style.maxHeight)},
    flexGrow: f(style.flexGrow ?? 0),
    flexShrink: f(style.flexShrink ?? 0),
    flexBasis: points(style.flexBasis),
    margin, padding,
    gap: {row: f(style.columnGap ?? style.gap ?? 0), column: f(style.rowGap ?? style.gap ?? 0)},
    aspectRatio: points(style.aspectRatio),
    measure: spec.measure === undefined ? undefined : {width: amountOf(c, spec.measure.width), height: amountOf(c, spec.measure.height)},
    measured: {width: Number.NaN, height: Number.NaN},
    size: {width: Number.NaN, height: Number.NaN},
    cachedLayout: [],
    cachedMeasurements: Array.from({length: maxCachedMeasurements}, () => []),
    nextCachedMeasurementsIndex: 0,
    position: {left: 0, top: 0, right: 0, bottom: 0},
    computedFlexBasis: Number.NaN,
  }
  if (spec.measure !== undefined && (spec.children ?? []).length > 0) throw new Error(`${spec.name}: a measured node has no children`)
  node.children = (spec.children ?? []).map(child => createNode(c, child, node))
  return node
}

// Lays out the tree for an owner of the given size, Yoga's calculateLayout
// with the root's direction left-to-right.
export function layout(c: LayoutCircuit, spec: Spec, ownerWidth: Num, ownerHeight: Num): Layout {
  const root = createNode(c, spec, null)
  // Whether the code running now runs in Yoga: 1, or a bit when it is a
  // branch that the circuit computes but Yoga may skip, e.g. laying out the
  // children of a node whose size turns out fixed. What such a branch leaves
  // behind for later, a cache entry or a flex basis, takes effect only when
  // the bit is 1.
  let active: Num = 1
  const setFlexBasis = (child: Node, value: Num) => {
    child.computedFlexBasis = select(c, active, child.computedFlexBasis, value)
  }

  // Style helpers, all constants: margins, padding and gaps are points.
  const marginForAxis = (node: Node, axis: Axis) => f(node.margin[startEdge(axis)] + node.margin[endEdge(axis)])
  const paddingAndBorderForAxis = (node: Node, axis: Axis) => f(f(node.padding[startEdge(axis)] + 0) + f(node.padding[endEdge(axis)] + 0))
  const leadingPaddingAndBorder = (node: Node, axis: Axis) => f(node.padding[startEdge(axis)] + 0)
  const trailingPaddingAndBorder = (node: Node, axis: Axis) => f(node.padding[endEdge(axis)] + 0)
  const gapForAxis = (node: Node, axis: Axis) => node.gap[axis] < 0 ? 0 : node.gap[axis]
  // processDimensions: a max equal to the min is the size.
  const processedDimension = (node: Node, dimension: Dimension) => {
    const max = node.maxDimension[dimension]
    const min = node.minDimension[dimension]
    return !Number.isNaN(max) && !Number.isNaN(min) && Math.abs(f(max - min)) < f(0.0001) ? max : node.dimension[dimension]
  }
  const hasDefiniteLength = (node: Node, dimension: Dimension) => {
    const used = processedDimension(node, dimension)
    return !Number.isNaN(used) && used >= 0
  }
  const resolveFlexGrow = (node: Node) => node.parent === null ? 0 : node.flexGrow
  const resolveFlexShrink = (node: Node) => node.parent === null ? 0 : node.flexShrink
  const isNodeFlexible = (node: Node) => resolveFlexGrow(node) !== 0 || resolveFlexShrink(node) !== 0
  const resolveChildAlignment = (node: Node, child: Node): Align => child.alignSelf === 'auto' ? node.alignItems : child.alignSelf
  const dimensionWithMargin = (node: Node, axis: Axis) => add(c, node.measured[dimensionOf(axis)], marginForAxis(node, axis))
  const fallbackJustify = (justify: Justify): Justify =>
    justify === 'space-between' || justify === 'space-around' || justify === 'space-evenly' ? 'flex-start' : justify

  const lessThan = (a: Num, b: Num) => compare(c, a, '<', b)
  const greaterThan = (a: Num, b: Num) => compare(c, a, '>', b)
  const notEqual = (a: Num, b: Num) => not(c, compare(c, a, '==', b))
  const defined = (a: Num): Num => compare(c, a, 'number', 0)

  // boundAxisWithinMinAndMax: a value above a max is the max, else one below a
  // min is the min.
  const boundAxisWithinMinAndMax = (node: Node, axis: Axis, value: Num): Num => {
    const dimension = dimensionOf(axis)
    const min = node.minDimension[dimension]
    const max = node.maxDimension[dimension]
    let bounded = value
    if (!Number.isNaN(min) && min >= 0) bounded = select(c, lessThan(value, min), value, min)
    if (!Number.isNaN(max) && max >= 0) bounded = select(c, greaterThan(value, max), bounded, max)
    return bounded
  }
  const boundAxis = (node: Node, axis: Axis, value: Num) =>
    maxOrDefined(c, boundAxisWithinMinAndMax(node, axis, value), paddingAndBorderForAxis(node, axis))

  const constrainMaxSizeForMode = (node: Node, axis: Axis, mode: Mode, size: Num): [Mode, Num] => {
    const max = node.maxDimension[dimensionOf(axis)]
    const maxSize = Number.isNaN(max) ? Number.NaN : f(max + marginForAxis(node, axis))
    if (mode === 'max-content') return Number.isNaN(maxSize) ? [mode, size] : ['fit-content', maxSize]
    if (Number.isNaN(maxSize)) return [mode, size]
    if (isUndefined(size)) return [mode, maxSize]
    return [mode, select(c, lessThan(size, maxSize), maxSize, size)]
  }

  // yoga::inexactEquals: within 0.0001, or both undefined.
  const inexactEquals = (a: Num, b: Num): Num => {
    if (isUndefined(a) || isUndefined(b)) return isUndefined(a) && isUndefined(b) ? 1 : not(c, defined(isUndefined(a) ? b : a))
    const difference = subtract(c, a, b)
    const close = and(c, lessThan(difference, f(0.0001)), greaterThan(difference, f(-0.0001)))
    return or(c, close, and(c, not(c, defined(a)), not(c, defined(b))))
  }
  const whenModes = (holds: boolean, bit: () => Num): Num => holds ? bit() : 0

  // canUseCachedMeasurement, for a node with a measure function.
  const canUseCachedMeasurement = (node: Node, entry: CacheEntry, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode): Num => {
    const negative = (computed: Num) => and(c, defined(computed), lessThan(computed, 0))
    const usable = not(c, or(c, negative(entry.computedHeight), negative(entry.computedWidth)))
    const compatible = (mode: Mode, available: Num, lastMode: Mode, lastAvailable: Num, lastComputed: Num, margin: number): Num => {
      const size = subtract(c, available, margin)
      const sameSpec = whenModes(lastMode === mode, () => inexactEquals(lastAvailable, available))
      const exactMatchesOld = whenModes(mode === 'stretch-fit', () => inexactEquals(size, lastComputed))
      const oldStillFits = whenModes(mode === 'fit-content' && lastMode === 'max-content',
        () => or(c, compare(c, size, '>=', lastComputed), inexactEquals(size, lastComputed)))
      const stricterStillValid = whenModes(lastMode === 'fit-content' && mode === 'fit-content', () =>
        and(c, and(c, and(c, defined(lastAvailable), defined(size)), defined(lastComputed)),
          and(c, greaterThan(lastAvailable, size), or(c, compare(c, lastComputed, '<=', size), inexactEquals(size, lastComputed)))))
      return or(c, or(c, sameSpec, exactMatchesOld), or(c, oldStillFits, stricterStillValid))
    }
    return and(c, usable, and(c,
      compatible(widthMode, availableWidth, entry.widthMode, entry.availableWidth, entry.computedWidth, marginForAxis(node, 'row')),
      compatible(heightMode, availableHeight, entry.heightMode, entry.availableHeight, entry.computedHeight, marginForAxis(node, 'column'))))
  }

  // The node's measured width and height for the available size, and with
  // performLayout, its size and the positions of its descendants. Yoga looks
  // in this layout's cache first: for a measured node, the layout entry, then
  // the measurement slots below the next index in order; for any other node,
  // the entry of the same pass with the same modes and available sizes within
  // 0.0001. The first that fits is the result. A result measured anew goes to
  // the layout entry, or to the next slot, which starts over at 0 after the
  // last.
  function calculateLayoutInternal(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode, ownerWidth: Num, ownerHeight: Num, performLayout: boolean) {
    const sameSpec = (entry: CacheEntry) => entry.widthMode === widthMode && entry.heightMode === heightMode
      ? and(c, inexactEquals(entry.availableWidth, availableWidth), inexactEquals(entry.availableHeight, availableHeight))
      : 0
    const fits = (entry: CacheEntry) => node.measure !== undefined
      ? canUseCachedMeasurement(node, entry, availableWidth, availableHeight, widthMode, heightMode)
      : sameSpec(entry)
    // Each place to look as [fits, entry it holds], in Yoga's order.
    const places: [Num, Held[]][] = []
    if (node.measure !== undefined || performLayout) places.push([1, node.cachedLayout])
    if (node.measure !== undefined || !performLayout) {
      node.cachedMeasurements.forEach((slot, index) => places.push([lessThan(index, node.nextCachedMeasurementsIndex), slot]))
    }
    const candidates: [Num, CacheEntry][] = places.flatMap(([visible, held]) =>
      held.map(({entry, holds}) => [and(c, visible, and(c, holds, fits(entry))), entry] as [Num, CacheEntry]))
    const hit = candidates.reduce<Num>((any, [fit]) => or(c, any, fit), 0)
    if (hit !== 1) {
      if (performLayout && hit !== 0 && node.measure === undefined) throw new Error(`${node.spec.name}: a layout that may come from the cache`)
      calculateLayoutImpl(node, availableWidth, availableHeight, widthMode, heightMode, ownerWidth, ownerHeight, performLayout)
      const entry: CacheEntry = {availableWidth, availableHeight, widthMode, heightMode, computedWidth: node.measured.width, computedHeight: node.measured.height}
      const stored = and(c, active, not(c, hit))
      const overwrite = (held: Held[], write: Num) => {
        const kept = held.map(({entry, holds}) => ({entry, holds: and(c, holds, not(c, write))})).filter(({holds}) => holds !== 0)
        return write === 0 ? kept : [...kept, {entry, holds: write}]
      }
      if (performLayout) {
        node.cachedLayout = overwrite(node.cachedLayout, stored)
      } else {
        const index = select(c, compare(c, node.nextCachedMeasurementsIndex, '==', maxCachedMeasurements), node.nextCachedMeasurementsIndex, 0)
        node.cachedMeasurements = node.cachedMeasurements.map((slot, slotIndex) => overwrite(slot, and(c, stored, compare(c, index, '==', slotIndex))))
        node.nextCachedMeasurementsIndex = select(c, stored, node.nextCachedMeasurementsIndex, add(c, index, 1))
      }
    }
    // The first entry that fits, else what was just measured.
    let width: Num = node.measured.width
    let height: Num = node.measured.height
    for (const [fit, entry] of [...candidates].reverse()) {
      width = select(c, fit, width, entry.computedWidth)
      height = select(c, fit, height, entry.computedHeight)
    }
    node.measured = {width, height}
    if (performLayout) node.size = {...node.measured}
  }

  function measureNodeWithMeasureFunc(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode) {
    if (widthMode === 'max-content') availableWidth = Number.NaN
    if (heightMode === 'max-content') availableHeight = Number.NaN
    const paddingAndBorderRow = paddingAndBorderForAxis(node, 'row')
    const paddingAndBorderColumn = paddingAndBorderForAxis(node, 'column')
    const innerWidth = isUndefined(availableWidth) ? availableWidth : maxOrDefined(c, 0, subtract(c, availableWidth, paddingAndBorderRow))
    const innerHeight = isUndefined(availableHeight) ? availableHeight : maxOrDefined(c, 0, subtract(c, availableHeight, paddingAndBorderColumn))
    if (widthMode === 'stretch-fit' && heightMode === 'stretch-fit') {
      node.measured = {width: boundAxis(node, 'row', availableWidth), height: boundAxis(node, 'column', availableHeight)}
      return
    }
    // The measure function: exact takes the available size, at most the
    // smaller, as (available < content) ? available : content.
    const measure = (content: Num, available: Num, mode: Mode) =>
      mode === 'stretch-fit' ? available : mode === 'fit-content' ? select(c, lessThan(available, content), content, available) : content
    const measuredWidth = measure(node.measure!.width, innerWidth, widthMode)
    const measuredHeight = measure(node.measure!.height, innerHeight, heightMode)
    node.measured = {
      width: boundAxis(node, 'row', widthMode === 'max-content' || widthMode === 'fit-content' ? add(c, measuredWidth, paddingAndBorderRow) : availableWidth),
      height: boundAxis(node, 'column', heightMode === 'max-content' || heightMode === 'fit-content' ? add(c, measuredHeight, paddingAndBorderColumn) : availableHeight),
    }
  }

  function measureNodeWithoutChildren(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode) {
    const width = widthMode === 'max-content' || widthMode === 'fit-content' ? paddingAndBorderForAxis(node, 'row') : availableWidth
    const height = heightMode === 'max-content' || heightMode === 'fit-content' ? paddingAndBorderForAxis(node, 'column') : availableHeight
    node.measured = {width: boundAxis(node, 'row', width), height: boundAxis(node, 'column', height)}
  }

  // measureNodeWithFixedSize: whether the size is known without laying out
  // the children, as a bit, and that size.
  function measureNodeWithFixedSize(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode) {
    const atMostNothing = (available: Num, mode: Mode) =>
      isDefined(available) && mode === 'fit-content' ? compare(c, available, '<=', 0) : 0
    const fixed = or(c, or(c, atMostNothing(availableWidth, widthMode), atMostNothing(availableHeight, heightMode)), widthMode === 'stretch-fit' && heightMode === 'stretch-fit' ? 1 : 0)
    const size = (available: Num, mode: Mode) =>
      isUndefined(available) ? 0 : mode === 'fit-content' ? select(c, lessThan(available, 0), available, 0) : available
    return {fixed, width: boundAxis(node, 'row', size(availableWidth, widthMode)), height: boundAxis(node, 'column', size(availableHeight, heightMode))}
  }

  function calculateAvailableInnerDimension(node: Node, dimension: Dimension, availableDim: Num, paddingAndBorder: number): Num {
    let availableInnerDim = subtract(c, availableDim, paddingAndBorder)
    if (isDefined(availableInnerDim)) {
      const min = node.minDimension[dimension]
      const max = node.maxDimension[dimension]
      const minInnerDim = Number.isNaN(min) ? 0 : f(min - paddingAndBorder)
      const maxInnerDim = Number.isNaN(max) ? FLT_MAX : f(max - paddingAndBorder)
      availableInnerDim = maxOrDefined(c, minOrDefined(c, availableInnerDim, maxInnerDim), minInnerDim)
    }
    return availableInnerDim
  }

  function setPosition(node: Node) {
    // Position relative, with no insets: the margins, plus -0.
    const main = node.direction
    const cross = crossOf(main)
    node.position[startEdge(main)] = f(node.margin[startEdge(main)] + -0)
    node.position[endEdge(main)] = f(node.margin[endEdge(main)] + -0)
    node.position[startEdge(cross)] = f(node.margin[startEdge(cross)] + -0)
    node.position[endEdge(cross)] = f(node.margin[endEdge(cross)] + -0)
  }

  function computeFlexBasisForChild(node: Node, child: Node, width: Num, widthMode: Mode, height: Num, ownerWidth: Num, ownerHeight: Num, heightMode: Mode) {
    const mainAxis = node.direction
    const isMainAxisRow = mainAxis === 'row'
    const mainAxisSize = isMainAxisRow ? width : height
    const resolvedFlexBasis = child.flexBasis
    const isRowStyleDimDefined = hasDefiniteLength(child, 'width')
    const isColumnStyleDimDefined = hasDefiniteLength(child, 'height')
    if (!Number.isNaN(resolvedFlexBasis) && isDefined(mainAxisSize)) {
      // Set once: a basis an earlier pass set stays.
      const unset = not(c, defined(child.computedFlexBasis))
      const outer = active
      active = and(c, active, unset)
      if (active !== 0) setFlexBasis(child, maxOrDefined(c, resolvedFlexBasis, paddingAndBorderForAxis(child, mainAxis)))
      active = outer
    } else if (isMainAxisRow && isRowStyleDimDefined) {
      setFlexBasis(child, maxOrDefined(c, processedDimension(child, 'width'), paddingAndBorderForAxis(child, 'row')))
    } else if (!isMainAxisRow && isColumnStyleDimDefined) {
      setFlexBasis(child, maxOrDefined(c, processedDimension(child, 'height'), paddingAndBorderForAxis(child, 'column')))
    } else {
      let childWidth: Num = Number.NaN
      let childHeight: Num = Number.NaN
      let childWidthMode: Mode = 'max-content'
      let childHeightMode: Mode = 'max-content'
      const marginRow = marginForAxis(child, 'row')
      const marginColumn = marginForAxis(child, 'column')
      if (isRowStyleDimDefined) {
        childWidth = f(processedDimension(child, 'width') + marginRow)
        childWidthMode = 'stretch-fit'
      }
      if (isColumnStyleDimDefined) {
        childHeight = f(processedDimension(child, 'height') + marginColumn)
        childHeightMode = 'stretch-fit'
      }
      if (isUndefined(childWidth) && isDefined(width)) {
        childWidth = width
        childWidthMode = 'fit-content'
      }
      if (isUndefined(childHeight) && isDefined(height)) {
        childHeight = height
        childHeightMode = 'fit-content'
      }
      const aspectRatio = child.aspectRatio
      if (!Number.isNaN(aspectRatio)) {
        if (!isMainAxisRow && childWidthMode === 'stretch-fit') {
          childHeight = add(c, marginColumn, divide(c, subtract(c, childWidth, marginRow), aspectRatio))
          childHeightMode = 'stretch-fit'
        } else if (isMainAxisRow && childHeightMode === 'stretch-fit') {
          childWidth = add(c, marginRow, multiply(c, subtract(c, childHeight, marginColumn), aspectRatio))
          childWidthMode = 'stretch-fit'
        }
      }
      const hasExactWidth = isDefined(width) && widthMode === 'stretch-fit'
      const childWidthStretch = resolveChildAlignment(node, child) === 'stretch' && childWidthMode !== 'stretch-fit'
      if (!isMainAxisRow && !isRowStyleDimDefined && hasExactWidth && childWidthStretch) {
        childWidth = width
        childWidthMode = 'stretch-fit'
        // Without the column margin, as Yoga does.
        if (!Number.isNaN(aspectRatio)) {
          childHeight = divide(c, subtract(c, childWidth, marginRow), aspectRatio)
          childHeightMode = 'stretch-fit'
        }
      }
      const hasExactHeight = isDefined(height) && heightMode === 'stretch-fit'
      const childHeightStretch = resolveChildAlignment(node, child) === 'stretch' && childHeightMode !== 'stretch-fit'
      if (isMainAxisRow && !isColumnStyleDimDefined && hasExactHeight && childHeightStretch) {
        childHeight = height
        childHeightMode = 'stretch-fit'
        if (!Number.isNaN(aspectRatio)) {
          childWidth = multiply(c, subtract(c, childHeight, marginColumn), aspectRatio)
          childWidthMode = 'stretch-fit'
        }
      }
      ;[childWidthMode, childWidth] = constrainMaxSizeForMode(child, 'row', childWidthMode, childWidth)
      ;[childHeightMode, childHeight] = constrainMaxSizeForMode(child, 'column', childHeightMode, childHeight)
      calculateLayoutInternal(child, childWidth, childHeight, childWidthMode, childHeightMode, ownerWidth, ownerHeight, false)
      setFlexBasis(child, maxOrDefined(c, child.measured[dimensionOf(mainAxis)], paddingAndBorderForAxis(child, mainAxis)))
    }
  }

  function computeFlexBasisForChildren(node: Node, availableInnerWidth: Num, availableInnerHeight: Num, widthMode: Mode, heightMode: Mode, performLayout: boolean): Num {
    let totalOuterFlexBasis: Num = 0
    let singleFlexChild: Node | null = null
    const mainAxis = node.direction
    const sizingModeMainDim = mainAxis === 'row' ? widthMode : heightMode
    if (sizingModeMainDim === 'stretch-fit') {
      for (const child of node.children) {
        if (!isNodeFlexible(child)) continue
        if (singleFlexChild !== null || Math.abs(resolveFlexGrow(child)) < f(0.0001) || Math.abs(resolveFlexShrink(child)) < f(0.0001)) {
          singleFlexChild = null
          break
        }
        singleFlexChild = child
      }
    }
    for (const child of node.children) {
      if (performLayout) setPosition(child)
      if (child === singleFlexChild) setFlexBasis(child, 0)
      else computeFlexBasisForChild(node, child, availableInnerWidth, widthMode, availableInnerHeight, availableInnerWidth, availableInnerHeight, heightMode)
      totalOuterFlexBasis = add(c, totalOuterFlexBasis, add(c, child.computedFlexBasis, marginForAxis(child, mainAxis)))
    }
    return totalOuterFlexBasis
  }

  type FlexLine = {
    items: Node[]
    sizeConsumed: Num
    totalFlexGrowFactors: Num
    totalFlexShrinkScaledFactors: Num
    remainingFreeSpace: Num
    mainDim: Num
    crossDim: Num
  }

  function calculateFlexLine(node: Node, availableInnerMainDim: Num): FlexLine {
    const mainAxis = node.direction
    const gap = gapForAxis(node, mainAxis)
    let sizeConsumed: Num = 0
    let totalFlexGrowFactors: Num = 0
    let totalFlexShrinkScaledFactors: Num = 0
    node.children.forEach((child, index) => {
      const childMarginMainAxis = marginForAxis(child, mainAxis)
      const childLeadingGapMainAxis = index === 0 ? 0 : gap
      const flexBasisWithMinAndMaxConstraints = boundAxisWithinMinAndMax(child, mainAxis, child.computedFlexBasis)
      sizeConsumed = add(c, sizeConsumed, add(c, add(c, flexBasisWithMinAndMaxConstraints, childMarginMainAxis), childLeadingGapMainAxis))
      if (isNodeFlexible(child)) {
        totalFlexGrowFactors = add(c, totalFlexGrowFactors, resolveFlexGrow(child))
        totalFlexShrinkScaledFactors = add(c, totalFlexShrinkScaledFactors, multiply(c, -resolveFlexShrink(child), child.computedFlexBasis))
      }
    })
    void availableInnerMainDim
    // Totals between 0 and 1 floor to 1.
    const floored = (total: Num) => select(c, and(c, greaterThan(total, 0), lessThan(total, 1)), total, 1)
    return {
      items: node.children, sizeConsumed,
      totalFlexGrowFactors: floored(totalFlexGrowFactors),
      totalFlexShrinkScaledFactors: floored(totalFlexShrinkScaledFactors),
      remainingFreeSpace: 0, mainDim: 0, crossDim: 0,
    }
  }

  function distributeFreeSpaceFirstPass(line: FlexLine, mainAxis: Axis) {
    let deltaFreeSpace: Num = 0
    for (const child of line.items) {
      const childFlexBasis = boundAxisWithinMinAndMax(child, mainAxis, child.computedFlexBasis)
      const shrinks = lessThan(line.remainingFreeSpace, 0)
      const grows = and(c, not(c, shrinks), greaterThan(line.remainingFreeSpace, 0))
      // Shrinking: by the share of the shrink factor scaled by the basis.
      const flexShrinkScaledFactor = multiply(c, -resolveFlexShrink(child), childFlexBasis)
      const canShrink = and(c, shrinks, and(c, defined(flexShrinkScaledFactor), notEqual(flexShrinkScaledFactor, 0)))
      if (canShrink !== 0) {
        const baseMainSize = add(c, childFlexBasis, multiply(c, divide(c, line.remainingFreeSpace, line.totalFlexShrinkScaledFactors), flexShrinkScaledFactor))
        const boundMainSize = boundAxis(child, mainAxis, baseMainSize)
        const violates = and(c, canShrink, and(c, and(c, defined(baseMainSize), defined(boundMainSize)), notEqual(baseMainSize, boundMainSize)))
        deltaFreeSpace = select(c, violates, deltaFreeSpace, add(c, deltaFreeSpace, subtract(c, boundMainSize, childFlexBasis)))
        line.totalFlexShrinkScaledFactors = select(c, violates, line.totalFlexShrinkScaledFactors,
          subtract(c, line.totalFlexShrinkScaledFactors, multiply(c, -resolveFlexShrink(child), child.computedFlexBasis)))
      }
      // Growing: by the share of the grow factor.
      const flexGrowFactor = resolveFlexGrow(child)
      if (flexGrowFactor !== 0 && grows !== 0) {
        const baseMainSize = add(c, childFlexBasis, multiply(c, divide(c, line.remainingFreeSpace, line.totalFlexGrowFactors), flexGrowFactor))
        const boundMainSize = boundAxis(child, mainAxis, baseMainSize)
        const violates = and(c, grows, and(c, and(c, defined(baseMainSize), defined(boundMainSize)), notEqual(baseMainSize, boundMainSize)))
        deltaFreeSpace = select(c, violates, deltaFreeSpace, add(c, deltaFreeSpace, subtract(c, boundMainSize, childFlexBasis)))
        line.totalFlexGrowFactors = select(c, violates, line.totalFlexGrowFactors, subtract(c, line.totalFlexGrowFactors, flexGrowFactor))
      }
    }
    line.remainingFreeSpace = subtract(c, line.remainingFreeSpace, deltaFreeSpace)
  }

  function distributeFreeSpaceSecondPass(node: Node, line: FlexLine, mainAxis: Axis, availableInnerMainDim: Num, availableInnerCrossDim: Num, availableInnerWidth: Num, availableInnerHeight: Num, sizingModeCrossDim: Mode, performLayout: boolean): Num {
    const crossAxis = crossOf(mainAxis)
    const isMainAxisRow = mainAxis === 'row'
    let deltaFreeSpace: Num = 0
    void availableInnerMainDim
    for (const child of line.items) {
      const childFlexBasis = boundAxisWithinMinAndMax(child, mainAxis, child.computedFlexBasis)
      let updatedMainSize: Num = childFlexBasis
      const shrinks = and(c, defined(line.remainingFreeSpace), lessThan(line.remainingFreeSpace, 0))
      const grows = and(c, not(c, shrinks), and(c, defined(line.remainingFreeSpace), greaterThan(line.remainingFreeSpace, 0)))
      const flexShrinkScaledFactor = multiply(c, -resolveFlexShrink(child), childFlexBasis)
      const canShrink = and(c, shrinks, notEqual(flexShrinkScaledFactor, 0))
      if (canShrink !== 0) {
        const totalIsZero = and(c, defined(line.totalFlexShrinkScaledFactors), compare(c, line.totalFlexShrinkScaledFactors, '==', 0))
        const childSize = select(c, totalIsZero,
          add(c, childFlexBasis, multiply(c, divide(c, line.remainingFreeSpace, line.totalFlexShrinkScaledFactors), flexShrinkScaledFactor)),
          add(c, childFlexBasis, flexShrinkScaledFactor))
        updatedMainSize = select(c, canShrink, updatedMainSize, boundAxis(child, mainAxis, childSize))
      }
      const flexGrowFactor = resolveFlexGrow(child)
      if (flexGrowFactor !== 0 && grows !== 0) {
        const grown = boundAxis(child, mainAxis, add(c, childFlexBasis, multiply(c, divide(c, line.remainingFreeSpace, line.totalFlexGrowFactors), flexGrowFactor)))
        updatedMainSize = select(c, grows, updatedMainSize, grown)
      }
      deltaFreeSpace = add(c, deltaFreeSpace, subtract(c, updatedMainSize, childFlexBasis))

      const marginMain = marginForAxis(child, mainAxis)
      const marginCross = marginForAxis(child, crossAxis)
      let childCrossSize: Num
      let childCrossMode: Mode
      let childMainSize = add(c, updatedMainSize, marginMain)
      let childMainMode: Mode = 'stretch-fit'
      const crossDimension = dimensionOf(crossAxis)
      if (!Number.isNaN(child.aspectRatio)) {
        const mainSize = subtract(c, childMainSize, marginMain)
        childCrossSize = isMainAxisRow ? divide(c, mainSize, child.aspectRatio) : multiply(c, mainSize, child.aspectRatio)
        childCrossMode = 'stretch-fit'
        childCrossSize = add(c, childCrossSize, marginCross)
      } else if (isDefined(availableInnerCrossDim) && !hasDefiniteLength(child, crossDimension) && sizingModeCrossDim === 'stretch-fit' && resolveChildAlignment(node, child) === 'stretch') {
        childCrossSize = availableInnerCrossDim
        childCrossMode = 'stretch-fit'
      } else if (!hasDefiniteLength(child, crossDimension)) {
        childCrossSize = availableInnerCrossDim
        childCrossMode = isUndefined(childCrossSize) ? 'max-content' : 'fit-content'
      } else {
        childCrossSize = f(processedDimension(child, crossDimension) + marginCross)
        childCrossMode = Number.isNaN(childCrossSize) ? 'max-content' : 'stretch-fit'
      }
      ;[childMainMode, childMainSize] = constrainMaxSizeForMode(child, mainAxis, childMainMode, childMainSize)
      ;[childCrossMode, childCrossSize] = constrainMaxSizeForMode(child, crossAxis, childCrossMode, childCrossSize)
      const requiresStretchLayout = !hasDefiniteLength(child, crossDimension) && resolveChildAlignment(node, child) === 'stretch'
      const childWidth = isMainAxisRow ? childMainSize : childCrossSize
      const childHeight = !isMainAxisRow ? childMainSize : childCrossSize
      const childWidthMode = isMainAxisRow ? childMainMode : childCrossMode
      const childHeightMode = !isMainAxisRow ? childMainMode : childCrossMode
      calculateLayoutInternal(child, childWidth, childHeight, childWidthMode, childHeightMode, availableInnerWidth, availableInnerHeight, performLayout && !requiresStretchLayout)
    }
    return deltaFreeSpace
  }

  function justifyMainAxis(node: Node, line: FlexLine, mainAxis: Axis, sizingModeMainDim: Mode, sizingModeCrossDim: Mode, availableInnerMainDim: Num, availableInnerCrossDim: Num, performLayout: boolean) {
    const crossAxis = crossOf(mainAxis)
    const leadingPaddingAndBorderMain = leadingPaddingAndBorder(node, mainAxis)
    const trailingPaddingAndBorderMain = trailingPaddingAndBorder(node, mainAxis)
    const gap = gapForAxis(node, mainAxis)
    if (sizingModeMainDim === 'fit-content') {
      const positive = greaterThan(line.remainingFreeSpace, 0)
      let atMost: Num = 0
      const min = node.minDimension[dimensionOf(mainAxis)]
      if (!Number.isNaN(min)) {
        const minAvailableMainDim = f(f(min - leadingPaddingAndBorderMain) - trailingPaddingAndBorderMain)
        const occupiedSpaceByChildNodes = subtract(c, availableInnerMainDim, line.remainingFreeSpace)
        atMost = maxOrDefined(c, 0, subtract(c, minAvailableMainDim, occupiedSpaceByChildNodes))
      }
      line.remainingFreeSpace = select(c, positive, line.remainingFreeSpace, atMost)
    }
    const count = line.items.length
    // The leading space and the space between items for a justification.
    const spacing = (justify: Justify): [Num, Num] => {
      const remaining = line.remainingFreeSpace
      switch (justify) {
        case 'center': return [divide(c, remaining, 2), gap]
        case 'flex-end': return [remaining, gap]
        case 'space-between': return [0, count > 1 ? add(c, gap, divide(c, remaining, f(count - 1))) : gap]
        case 'space-evenly': {
          const leading = divide(c, remaining, f(count + 1))
          return [leading, add(c, gap, leading)]
        }
        case 'space-around': {
          const leading = divide(c, multiply(c, 0.5, remaining), f(count))
          return [leading, add(c, gap, multiply(c, leading, 2))]
        }
        case 'flex-start': return [0, gap]
      }
    }
    const [leadingIfFits, betweenIfFits] = spacing(node.justify)
    const [leadingIfOverflows, betweenIfOverflows] = spacing(fallbackJustify(node.justify))
    const fits = compare(c, line.remainingFreeSpace, '>=', 0)
    const leadingMainDim = select(c, fits, leadingIfOverflows, leadingIfFits)
    const betweenMainDim = select(c, fits, betweenIfOverflows, betweenIfFits)

    line.mainDim = add(c, leadingPaddingAndBorderMain, leadingMainDim)
    line.crossDim = 0
    line.items.forEach((child, index) => {
      if (performLayout) child.position[startEdge(mainAxis)] = add(c, child.position[startEdge(mainAxis)], line.mainDim)
      if (index !== count - 1) line.mainDim = add(c, line.mainDim, betweenMainDim)
      const canSkipFlex = !performLayout && sizingModeCrossDim === 'stretch-fit'
      if (canSkipFlex) {
        line.mainDim = add(c, line.mainDim, add(c, marginForAxis(child, mainAxis), child.computedFlexBasis))
        line.crossDim = availableInnerCrossDim
      } else {
        line.mainDim = add(c, line.mainDim, dimensionWithMargin(child, mainAxis))
        line.crossDim = maxOrDefined(c, line.crossDim, dimensionWithMargin(child, crossAxis))
      }
    })
    line.mainDim = add(c, line.mainDim, trailingPaddingAndBorderMain)
  }

  function calculateLayoutImpl(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode, ownerWidth: Num, ownerHeight: Num, performLayout: boolean) {
    const marginAxisRow = marginForAxis(node, 'row')
    const marginAxisColumn = marginForAxis(node, 'column')
    if (node.measure !== undefined) {
      measureNodeWithMeasureFunc(node, subtract(c, availableWidth, marginAxisRow), subtract(c, availableHeight, marginAxisColumn), widthMode, heightMode)
      return
    }
    if (node.children.length === 0) {
      measureNodeWithoutChildren(node, subtract(c, availableWidth, marginAxisRow), subtract(c, availableHeight, marginAxisColumn), widthMode, heightMode)
      return
    }
    // When only measuring, a size known without the children skips them. The
    // test can depend on the inputs, so both sides are computed.
    let fixed: ReturnType<typeof measureNodeWithFixedSize> | undefined
    if (!performLayout) {
      fixed = measureNodeWithFixedSize(node, subtract(c, availableWidth, marginAxisRow), subtract(c, availableHeight, marginAxisColumn), widthMode, heightMode)
      if (fixed.fixed === 1) {
        node.measured = {width: fixed.width, height: fixed.height}
        return
      }
    }
    const outer = active
    if (fixed !== undefined) active = and(c, active, not(c, fixed.fixed))
    layoutChildren(node, availableWidth, availableHeight, widthMode, heightMode, ownerWidth, ownerHeight, performLayout, marginAxisRow, marginAxisColumn)
    active = outer
    if (fixed !== undefined && fixed.fixed !== 0) {
      node.measured = {
        width: select(c, fixed.fixed, node.measured.width, fixed.width),
        height: select(c, fixed.fixed, node.measured.height, fixed.height),
      }
    }
  }

  function layoutChildren(node: Node, availableWidth: Num, availableHeight: Num, widthMode: Mode, heightMode: Mode, ownerWidth: Num, ownerHeight: Num, performLayout: boolean, marginAxisRow: number, marginAxisColumn: number) {
    // STEP 1
    const mainAxis = node.direction
    const crossAxis = crossOf(mainAxis)
    const isMainAxisRow = mainAxis === 'row'
    const paddingAndBorderAxisMain = paddingAndBorderForAxis(node, mainAxis)
    const paddingAndBorderAxisCross = paddingAndBorderForAxis(node, crossAxis)
    const leadingPaddingAndBorderCross = leadingPaddingAndBorder(node, crossAxis)
    const sizingModeMainDim = isMainAxisRow ? widthMode : heightMode
    const sizingModeCrossDim = isMainAxisRow ? heightMode : widthMode
    const paddingAndBorderAxisRow = isMainAxisRow ? paddingAndBorderAxisMain : paddingAndBorderAxisCross
    const paddingAndBorderAxisColumn = isMainAxisRow ? paddingAndBorderAxisCross : paddingAndBorderAxisMain

    // STEP 2
    const availableInnerWidth = calculateAvailableInnerDimension(node, 'width', subtract(c, availableWidth, marginAxisRow), paddingAndBorderAxisRow)
    const availableInnerHeight = calculateAvailableInnerDimension(node, 'height', subtract(c, availableHeight, marginAxisColumn), paddingAndBorderAxisColumn)
    let availableInnerMainDim = isMainAxisRow ? availableInnerWidth : availableInnerHeight
    const availableInnerCrossDim = isMainAxisRow ? availableInnerHeight : availableInnerWidth

    // STEP 3. The total only tells whether a wrapping line overflows.
    computeFlexBasisForChildren(node, availableInnerWidth, availableInnerHeight, widthMode, heightMode, performLayout)

    // STEP 4: one line, since nothing wraps.
    const line = calculateFlexLine(node, availableInnerMainDim)
    const canSkipFlex = !performLayout && sizingModeCrossDim === 'stretch-fit'

    // STEP 5
    let sizeBasedOnContent: Num = 0
    if (sizingModeMainDim !== 'stretch-fit') {
      const mainDimension = dimensionOf(mainAxis)
      const minInnerMainDim = f(node.minDimension[mainDimension] - paddingAndBorderAxisMain)
      const maxInnerMainDim = f(node.maxDimension[mainDimension] - paddingAndBorderAxisMain)
      const belowMin = Number.isNaN(minInnerMainDim) ? 0 : lessThan(line.sizeConsumed, minInnerMainDim)
      const aboveMax = and(c, not(c, belowMin), Number.isNaN(maxInnerMainDim) ? 0 : greaterThan(line.sizeConsumed, maxInnerMainDim))
      const within = and(c, not(c, belowMin), not(c, aboveMax))
      const noGrowth = or(c, and(c, defined(line.totalFlexGrowFactors), compare(c, line.totalFlexGrowFactors, '==', 0)), resolveFlexGrow(node) === 0 ? 1 : 0)
      const fromContent = and(c, within, noGrowth)
      let main = availableInnerMainDim
      if (!Number.isNaN(maxInnerMainDim)) main = select(c, aboveMax, main, maxInnerMainDim)
      if (!Number.isNaN(minInnerMainDim)) main = select(c, belowMin, main, minInnerMainDim)
      availableInnerMainDim = select(c, fromContent, main, line.sizeConsumed)
      sizeBasedOnContent = within
    }
    // remainingFreeSpace: the space left, or for content sizing, what makes a
    // negative total 0.
    const fromAvailable = and(c, not(c, sizeBasedOnContent), defined(availableInnerMainDim))
    const negativeConsumed = select(c, lessThan(line.sizeConsumed, 0), line.remainingFreeSpace, negate(line.sizeConsumed))
    line.remainingFreeSpace = select(c, fromAvailable, negativeConsumed, isDefined(availableInnerMainDim) ? subtract(c, availableInnerMainDim, line.sizeConsumed) : 0)

    if (!canSkipFlex) {
      const originalFreeSpace = line.remainingFreeSpace
      distributeFreeSpaceFirstPass(line, mainAxis)
      const distributedFreeSpace = distributeFreeSpaceSecondPass(node, line, mainAxis, availableInnerMainDim, availableInnerCrossDim, availableInnerWidth, availableInnerHeight, sizingModeCrossDim, performLayout)
      line.remainingFreeSpace = subtract(c, originalFreeSpace, distributedFreeSpace)
    }

    // STEP 6
    justifyMainAxis(node, line, mainAxis, sizingModeMainDim, sizingModeCrossDim, availableInnerMainDim, availableInnerCrossDim, performLayout)
    let containerCrossAxis = availableInnerCrossDim
    if (sizingModeCrossDim === 'max-content' || sizingModeCrossDim === 'fit-content') {
      containerCrossAxis = subtract(c, boundAxis(node, crossAxis, add(c, line.crossDim, paddingAndBorderAxisCross)), paddingAndBorderAxisCross)
    }
    if (sizingModeCrossDim === 'stretch-fit') line.crossDim = availableInnerCrossDim
    line.crossDim = subtract(c, boundAxis(node, crossAxis, add(c, line.crossDim, paddingAndBorderAxisCross)), paddingAndBorderAxisCross)

    // STEP 7
    if (performLayout) {
      for (const child of line.items) {
        let leadingCrossDim: Num = leadingPaddingAndBorderCross
        const alignItem = resolveChildAlignment(node, child)
        if (alignItem === 'stretch') {
          if (!hasDefiniteLength(child, dimensionOf(crossAxis))) {
            let childMainSize = child.measured[dimensionOf(mainAxis)]
            let childCrossSize = !Number.isNaN(child.aspectRatio)
              ? add(c, marginForAxis(child, crossAxis), isMainAxisRow ? divide(c, childMainSize, child.aspectRatio) : multiply(c, childMainSize, child.aspectRatio))
              : line.crossDim
            childMainSize = add(c, childMainSize, marginForAxis(child, mainAxis))
            let childMainMode: Mode = 'stretch-fit'
            let childCrossMode: Mode = 'stretch-fit'
            ;[childMainMode, childMainSize] = constrainMaxSizeForMode(child, mainAxis, childMainMode, childMainSize)
            ;[childCrossMode, childCrossSize] = constrainMaxSizeForMode(child, crossAxis, childCrossMode, childCrossSize)
            void childMainMode
            void childCrossMode
            const childWidth = isMainAxisRow ? childMainSize : childCrossSize
            const childHeight = !isMainAxisRow ? childMainSize : childCrossSize
            calculateLayoutInternal(child, childWidth, childHeight,
              isUndefined(childWidth) ? 'max-content' : 'stretch-fit', isUndefined(childHeight) ? 'max-content' : 'stretch-fit',
              availableInnerWidth, availableInnerHeight, true)
          }
        } else {
          const remainingCrossDim = subtract(c, containerCrossAxis, dimensionWithMargin(child, crossAxis))
          if (alignItem === 'center') leadingCrossDim = add(c, leadingCrossDim, divide(c, remainingCrossDim, 2))
          else if (alignItem === 'flex-end') leadingCrossDim = add(c, leadingCrossDim, remainingCrossDim)
        }
        const edge = startEdge(crossAxis)
        child.position[edge] = add(c, add(c, child.position[edge], 0), leadingCrossDim)
      }
    }
    const totalLineCrossDim = add(c, 0, add(c, line.crossDim, 0))
    const maxLineMainDim = maxOrDefined(c, 0, line.mainDim)

    // STEP 9
    node.measured = {
      width: boundAxis(node, 'row', subtract(c, availableWidth, marginAxisRow)),
      height: boundAxis(node, 'column', subtract(c, availableHeight, marginAxisColumn)),
    }
    if (sizingModeMainDim === 'max-content' || sizingModeMainDim === 'fit-content') {
      node.measured[dimensionOf(mainAxis)] = boundAxis(node, mainAxis, maxLineMainDim)
    }
    if (sizingModeCrossDim === 'max-content' || sizingModeCrossDim === 'fit-content') {
      node.measured[dimensionOf(crossAxis)] = boundAxis(node, crossAxis, add(c, totalLineCrossDim, paddingAndBorderAxisCross))
    }
    void ownerWidth
    void ownerHeight
  }

  const negate = (value: Num) => multiply(c, -1, value)

  // calculateLayout: the root's own size, or the owner's.
  const rootWidthDefinite = hasDefiniteLength(root, 'width')
  const rootHeightDefinite = hasDefiniteLength(root, 'height')
  const rootMaxWidth = root.maxDimension.width
  const rootMaxHeight = root.maxDimension.height
  const [width, widthMode]: [Num, Mode] = rootWidthDefinite ? [f(processedDimension(root, 'width') + marginForAxis(root, 'row')), 'stretch-fit']
    : !Number.isNaN(rootMaxWidth) ? [rootMaxWidth, 'fit-content'] : [ownerWidth, isUndefined(ownerWidth) ? 'max-content' : 'stretch-fit']
  const [height, heightMode]: [Num, Mode] = rootHeightDefinite ? [f(processedDimension(root, 'height') + marginForAxis(root, 'column')), 'stretch-fit']
    : !Number.isNaN(rootMaxHeight) ? [rootMaxHeight, 'fit-content'] : [ownerHeight, isUndefined(ownerHeight) ? 'max-content' : 'stretch-fit']
  calculateLayoutInternal(root, width, height, widthMode, heightMode, ownerWidth, ownerHeight, true)
  setPosition(root)

  const result = (node: Node): Layout => ({
    name: node.spec.name, left: node.position.left, top: node.position.top, width: node.size.width, height: node.size.height,
    children: node.children.map(result),
  })
  return result(root)
}

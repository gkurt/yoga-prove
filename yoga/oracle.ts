// The real Yoga (yoga-layout 3.2.1, its WebAssembly build) laying out a Spec
// for given input values, with pixel rounding off, as the reference for the
// port and its circuits.
import Yoga, {Align, Direction, Edge, FlexDirection, Gutter, Justify, MeasureMode, type Node as YogaNode} from 'yoga-layout'
import type {Amount, Edges, Spec} from './yoga.ts'

export type Box = {name: string, left: number, top: number, width: number, height: number, children: Box[]}

const justify = {
  'flex-start': Justify.FlexStart, 'center': Justify.Center, 'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween, 'space-around': Justify.SpaceAround, 'space-evenly': Justify.SpaceEvenly,
} as const
const align = {'stretch': Align.Stretch, 'flex-start': Align.FlexStart, 'center': Align.Center, 'flex-end': Align.FlexEnd, 'auto': Align.Auto} as const

export function yogaLayout(spec: Spec, ownerWidth: number, ownerHeight: number, inputs: Record<string, number>): Box {
  const config = Yoga.Config.create()
  config.setPointScaleFactor(0)
  const nodes: YogaNode[] = []
  const build = (spec: Spec): YogaNode => {
    const node = Yoga.Node.create(config)
    nodes.push(node)
    const style = spec.style ?? {}
    node.setFlexDirection(style.flexDirection === 'row' ? FlexDirection.Row : FlexDirection.Column)
    if (style.justifyContent !== undefined) node.setJustifyContent(justify[style.justifyContent])
    if (style.alignItems !== undefined) node.setAlignItems(align[style.alignItems])
    if (style.alignSelf !== undefined) node.setAlignSelf(align[style.alignSelf])
    if (style.width !== undefined) node.setWidth(style.width)
    if (style.height !== undefined) node.setHeight(style.height)
    if (style.minWidth !== undefined) node.setMinWidth(style.minWidth)
    if (style.maxWidth !== undefined) node.setMaxWidth(style.maxWidth)
    if (style.minHeight !== undefined) node.setMinHeight(style.minHeight)
    if (style.maxHeight !== undefined) node.setMaxHeight(style.maxHeight)
    if (style.flexGrow !== undefined) node.setFlexGrow(style.flexGrow)
    if (style.flexShrink !== undefined) node.setFlexShrink(style.flexShrink)
    if (style.flexBasis !== undefined) node.setFlexBasis(style.flexBasis)
    const edges = (value: Edges | undefined, set: (edge: Edge, value: number) => void) => {
      if (value === undefined) return
      if (typeof value === 'number') set(Edge.All, value)
      else for (const [name, edge] of [['left', Edge.Left], ['top', Edge.Top], ['right', Edge.Right], ['bottom', Edge.Bottom]] as const) {
        if (value[name] !== undefined) set(edge, value[name])
      }
    }
    edges(style.margin, (edge, value) => node.setMargin(edge, value))
    edges(style.padding, (edge, value) => node.setPadding(edge, value))
    if (style.gap !== undefined) node.setGap(Gutter.All, style.gap)
    if (style.columnGap !== undefined) node.setGap(Gutter.Column, style.columnGap)
    if (style.rowGap !== undefined) node.setGap(Gutter.Row, style.rowGap)
    if (style.aspectRatio !== undefined) node.setAspectRatio(style.aspectRatio)
    if (spec.measure !== undefined) {
      const value = (amount: Amount): number => typeof amount === 'number' ? Math.fround(amount)
        : typeof amount === 'string' ? Math.fround(inputs[amount]!)
        : Math.fround(value(amount.times[0]) * value(amount.times[1]))
      const contentWidth = value(spec.measure.width)
      const contentHeight = value(spec.measure.height)
      // The same measure function as the port's: (available < content) ? available : content when at most.
      const measure = (content: number, available: number, mode: MeasureMode) =>
        mode === MeasureMode.Exactly ? available : mode === MeasureMode.AtMost ? (available < content ? available : content) : content
      node.setMeasureFunc((width, widthMode, height, heightMode) => ({
        width: measure(contentWidth, width, widthMode),
        height: measure(contentHeight, height, heightMode),
      }))
    }
    ;(spec.children ?? []).forEach((child, index) => node.insertChild(build(child), index))
    return node
  }
  const root = build(spec)
  root.calculateLayout(ownerWidth, ownerHeight, Direction.LTR)
  const read = (spec: Spec, node: YogaNode): Box => {
    const layout = node.getComputedLayout()
    return {
      name: spec.name, left: layout.left, top: layout.top, width: layout.width, height: layout.height,
      children: (spec.children ?? []).map((child, index) => read(child, node.getChild(index))),
    }
  }
  const result = read(spec, root)
  root.freeRecursive()
  config.free()
  void nodes
  return result
}

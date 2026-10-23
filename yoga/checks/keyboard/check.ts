// The keyboard check: with the on-screen keyboard open at any height, the
// field being typed in and the button that submits it stay above the
// keyboard, and nothing on the form overlaps.
//
// Yoga doesn't know about the keyboard. The keyboard covers the bottom K px
// of the screen, and what the app does about it decides where the form is
// laid out: without a KeyboardAvoidingView the form keeps the whole screen,
// H px tall, and the keyboard is drawn over its bottom; with one whose
// behavior is 'height', the form is laid out in the H − K px above the
// keyboard. So each version's scene is the form at the height the app gives
// it, and the claims compare the laid-out boxes with the keyboard's top edge.
import {tolerance} from '../../claims.ts'
import type {Check, CheckClaim, Knob, Overlay, Scene, SceneSpec, Version} from '../../check.ts'
import {add, subtract, type LayoutCircuit, type Num} from '../../circuit.ts'
import type {Layout, Spec} from '../../yoga.ts'

// Phones in portrait. Heights from 640 (small Android phones; the iPhone SE
// is 667) to 932 (the largest iPhones). The keyboard from 0, closed, to 360:
// the iPhone keyboard is 216 to 336 px with its suggestion bar, and Android
// keyboards with a number row reach about 360. Every height in between
// happens while the keyboard slides in, and with a floating keyboard. The
// smallest space left above the keyboard is then 640 − 360 = 280 px, and both
// forms are made to fit in it.
const screen: Knob[] = [
  {name: 'W', low: 320, high: 430, grid: 1 / 64, base: 390, label: 'Screen width'},
  {name: 'H', low: 640, high: 932, grid: 1 / 64, base: 844, label: 'Screen height'},
  {name: 'K', low: 0, high: 360, grid: 1 / 64, base: 300, label: 'Keyboard height'},
]

// A box's edges on the screen: the scene's position plus each ancestor's
// offset, found by name.
function placed(c: LayoutCircuit, scene: Scene, name: string) {
  const visit = (box: Layout, x: Num, y: Num): {left: Num, top: Num, right: Num, bottom: Num} | undefined => {
    const left = add(c, x, box.left)
    const top = add(c, y, box.top)
    if (box.name === name) return {left, top, right: add(c, left, box.width), bottom: add(c, top, box.height)}
    for (const child of box.children) {
      const found = visit(child, left, top)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = visit(scene.root, scene.x, scene.y)
  if (found === undefined) throw new Error(`no box ${name} in ${scene.name}`)
  return found
}

const claim = (c: LayoutCircuit, name: string, says: string, value: Num, minimum: number, maximum: number): CheckClaim =>
  ({name, says, wire: c.wireOf(value), minimum, maximum})

// The keyboard's top edge on the screen.
const keyboardTop = (c: LayoutCircuit) => subtract(c, c.input('H'), c.input('K'))

// The scene the form is laid out in: the whole screen, or the space above
// the keyboard.
function formScene(c: LayoutCircuit, spec: Spec, avoids: boolean): SceneSpec[] {
  return [
    {name: 'device', label: 'Screen', frame: 'phone', spec: {name: 'device'}, width: c.input('W'), height: c.input('H')},
    {name: 'form', label: avoids ? 'Above the keyboard' : 'Whole screen', frame: 'phone', spec, width: c.input('W'), height: avoids ? keyboardTop(c) : c.input('H')},
  ]
}

const keyboardOverlay = (c: LayoutCircuit): Overlay[] =>
  [{name: 'keyboard', role: 'keyboard', label: 'Keyboard', rect: [0, keyboardTop(c), c.input('W'), c.input('K')]}]

// That a box is visible: its bottom at or above the keyboard's top, and its
// top at or below the screen's top.
function visible(c: LayoutCircuit, scene: Scene, name: string, words: string): CheckClaim[] {
  const box = placed(c, scene, name)
  return [
    claim(c, `${name} above keyboard`, `${words} stays above the keyboard`, subtract(c, box.bottom, keyboardTop(c)), -Infinity, tolerance),
    claim(c, `${name} below top`, `${words} stays below the top of the screen`, box.top, -tolerance, Infinity),
  ]
}

// That `later` starts at or after `earlier` ends, going down (or right).
function after(c: LayoutCircuit, scene: Scene, later: string, earlier: string, says: string, row = false): CheckClaim {
  const a = placed(c, scene, later)
  const b = placed(c, scene, earlier)
  return claim(c, `${later} after ${earlier}`, says, row ? subtract(c, a.left, b.right) : subtract(c, a.top, b.bottom), -tolerance, Infinity)
}

// A sign-in form: a heading, email and password fields, and the Sign in
// button pinned to the bottom with justifyContent: 'space-between', the way
// a design puts the main action within the thumb's reach. The password field
// has the focus. The fields and the heading fill the width, so their text
// only truncates. Its content is 24 + 152 + 50 + 24 = 250 px tall, which
// fits the smallest 280 px above the keyboard.
const field = (name: string): Spec => ({name, style: {padding: {left: 12, right: 12, top: 14, bottom: 14}}, measure: {width: name, height: 20}})
const signIn: Spec = {
  name: 'form', style: {padding: 24, justifyContent: 'space-between'},
  children: [
    {name: 'fields', style: {gap: 12}, children: [
      {name: 'heading', measure: {width: 'heading', height: 32}},
      field('email'),
      field('password'),
    ]},
    {name: 'submit', style: {padding: {left: 16, right: 16, top: 15, bottom: 15}}, measure: {width: 'submit', height: 20}},
  ],
}
const signInKnobs: Knob[] = [
  ...screen,
  {name: 'heading', low: 0, high: 600, grid: 1 / 64, base: 180, label: 'Heading text'},
  {name: 'email', low: 0, high: 800, grid: 1 / 64, base: 220, label: 'Email typed'},
  {name: 'password', low: 0, high: 800, grid: 1 / 64, base: 90, label: 'Password typed'},
  {name: 'submit', low: 0, high: 300, grid: 1 / 64, base: 52, label: 'Button label'},
]

function signInVersion(avoids: boolean): Version {
  return {
    id: avoids ? 'keyboard-avoiding' : 'whole-screen',
    label: avoids ? 'In a KeyboardAvoidingView (behavior "height")' : 'Laid out over the whole screen',
    expect: avoids ? 'proven' : 'refuted',
    knobs: signInKnobs,
    scenes: c => formScene(c, signIn, avoids),
    claims: (c, scenes) => {
      const form = scenes['form']!
      return [
        ...visible(c, form, 'password', 'The password field'),
        ...visible(c, form, 'submit', 'The Sign in button'),
        after(c, form, 'submit', 'fields', 'The Sign in button doesn\'t overlap the fields'),
        after(c, form, 'password', 'email', 'The password field doesn\'t overlap the email field'),
      ]
    },
    overlays: keyboardOverlay,
    roles: {device: 'screen', form: 'surface', fields: 'container', heading: 'text', email: 'field', password: 'field', submit: 'button'},
    texts: {
      heading: [
        'Hi', 'Hello', 'Hi again', 'Hello again', 'Welcome back', 'Welcome back!', 'Welcome back, Sam', 'Good to see you again', 'Good to see you again, Sam',
        'Welcome back, it\'s good to see you', 'Welcome back, Sam, it\'s good to see you again', 'Welcome back, Sam Rivera, it\'s good to see you again',
      ],
      email: [
        's@x.io', 'sam@x.io', 'sam@fox.io', 'sam@rivera.me', 'srivera@gmail.com', 'sam.rivera@example.com', 'sam.rivera.design@example.com',
        'samantha.rivera@northwind-design.co.uk', 'samantha.rivera-ortiz@northwind-architecture.co.uk',
        'samantha.rivera-ortiz+newsletters@northwind-architecture.co.uk',
        'samantha.rivera-ortiz.studio+newsletters@mail.northwind-architecture-group.co.uk',
        'samantha.josephine.rivera-ortiz.studio+newsletters@mail.northwind-landscape-architecture-group.co.uk',
      ],
      password: [
        '••••', '••••••', '••••••••', '••••••••••', '•••••••••••••', '•••••••••••••••••', '•••••••••••••••••••••••', '•••••••••••••••••••••••••••••••', '••••••••••••••••••••••••••••••••••••••••••', '••••••••••••••••••••••••••••••••••••••••••••••••••••••••', '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••', '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••',
      ],
      submit: [
        'Log in', 'Sign in', 'Sign me in', 'Sign in now', 'Sign me in now', 'Sign in securely', 'Sign in to continue', 'Sign in to your account',
        'Sign in to your account now', 'Sign in to your account securely', 'Continue and sign in to your account',
      ],
    },
  }
}

// A comment thread: a header, the comments, which take the rest of the
// height, and a row at the bottom with the comment box and a Post button.
// The comment box is `flex: 1`, which in React Native is flexGrow 1,
// flexShrink 1 and flexBasis 0, and has the focus. The header and the row
// are 56 px each, 112 px together.
const comments: Spec = {
  name: 'form',
  children: [
    {name: 'header', style: {flexDirection: 'row', alignItems: 'center', height: 56, padding: {left: 16, right: 16}, gap: 16}, children: [
      {name: 'back', style: {width: 24, height: 24}},
      {name: 'title', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0}, measure: {width: 'title', height: 22}},
    ]},
    {name: 'thread', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0}},
    {name: 'composer', style: {flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8}, children: [
      {name: 'draft', style: {flexGrow: 1, flexShrink: 1, flexBasis: 0, padding: {left: 12, right: 12, top: 10, bottom: 10}}, measure: {width: 'draft', height: 20}},
      {name: 'post', style: {padding: {left: 16, right: 16, top: 10, bottom: 10}}, measure: {width: 'post', height: 20}},
    ]},
  ],
}
const commentKnobs: Knob[] = [
  ...screen,
  {name: 'title', low: 0, high: 600, grid: 1 / 64, base: 120, label: 'Title text'},
  {name: 'draft', low: 0, high: 2000, grid: 1 / 64, base: 260, label: 'Comment typed'},
  {name: 'post', low: 0, high: 120, grid: 1 / 64, base: 34, label: 'Button label'},
]

function commentVersion(avoids: boolean): Version {
  return {
    id: avoids ? 'keyboard-avoiding' : 'whole-screen',
    label: avoids ? 'In a KeyboardAvoidingView (behavior "height")' : 'Laid out over the whole screen',
    expect: avoids ? 'proven' : 'refuted',
    knobs: commentKnobs,
    scenes: c => formScene(c, comments, avoids),
    claims: (c, scenes) => {
      const form = scenes['form']!
      const post = placed(c, form, 'post')
      return [
        ...visible(c, form, 'draft', 'The comment box'),
        ...visible(c, form, 'post', 'The Post button'),
        claim(c, 'post on screen', 'The Post button stays on the screen on the right', subtract(c, post.right, c.input('W')), -Infinity, tolerance),
        after(c, form, 'post', 'draft', 'The Post button doesn\'t overlap the comment box', true),
        after(c, form, 'composer', 'thread', 'The comment box doesn\'t cover the comments'),
        after(c, form, 'thread', 'header', 'The comments don\'t go under the header'),
      ]
    },
    overlays: keyboardOverlay,
    roles: {device: 'screen', form: 'surface', header: 'surface', back: 'icon', title: 'text', thread: 'container', composer: 'surface', draft: 'field', post: 'button'},
    texts: {
      title: [
        'Comments', 'All comments', 'All 128 comments', 'Comments on this post', 'Comments on the Q3 write-up', 'Comments on "What we learned in Q3"',
        'All 128 comments on "What we learned in Q3"',
        'Comments on "What we learned from the Q3 numbers"', 'Comments on "What we learned from our Q3 numbers" by Sam',
        '128 comments on "What we learned from our Q3 launch numbers" by Sam Rivera',
      ],
      draft: [
        'Nice!', 'Thanks!', 'Great post!', 'Great write-up!', 'Great read, thanks!', 'Great write-up, thanks!', 'Great write-up, thanks so much!',
        'Great write-up, thanks for sharing!', 'Great write-up, thanks for sharing the numbers!',
        'Great write-up, thanks for sharing the numbers! Really useful.',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening.',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening. Can we get the raw data?',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening. Can we get the raw data to compare with last quarter?',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening, especially the drop after week two. Could you share the raw data so we can compare it with last quarter?',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening, especially the drop after week two. Could you share the raw data so we can compare it with last quarter? I\'d love to dig into what changed in onboarding.',
        'Great write-up, thanks for sharing the numbers! The retention chart was eye-opening, especially the drop after week two. Could you share the raw data so we can compare it with last quarter? I\'d love to dig into what changed in onboarding around that time.',
      ],
      post: ['Post', 'Post it', 'Post now', 'Post comment', 'Post my comment'],
    },
  }
}

export const check: Check = {
  id: 'keyboard',
  title: 'Above the keyboard',
  question: 'With the on-screen keyboard open at any height, do the field being typed in and its button stay visible above it?',
  examples: [
    {id: 'sign-in', title: 'A sign-in form', versions: [signInVersion(false), signInVersion(true)]},
    {id: 'comments', title: 'A comment box', versions: [commentVersion(false), commentVersion(true)]},
  ],
}

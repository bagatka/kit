import { Option } from "effect"

/** Nodes that each reach all the others: one dependency cycle, or several tangled together. */
export interface Cycle {
  /** The group's smallest node, where `path` starts and ends. */
  readonly start: string
  /** The group's nodes, sorted. */
  readonly members: ReadonlyArray<string>
  /** A shortest path from `start` back to itself, through the group: `["a", "b", "a"]`. */
  readonly path: ReadonlyArray<string>
}

// Tarjan's bookkeeping for one node.
interface Visit {
  readonly index: number
  lowLink: number
  onStack: boolean
}

// A node whose edges are being followed, and the next one to follow.
interface Frame {
  readonly node: string
  readonly visit: Visit
  readonly targets: ReadonlyArray<string>
  next: number
}

/**
 * One cycle for each strongly connected component of the graph that has one: a group of two or
 * more nodes, or one node with an edge to itself. Uses Tarjan's algorithm with a stack of its own,
 * so a long chain can't overflow the call stack; time and memory are linear in nodes plus edges.
 * Deterministic for a given graph.
 */
export const findCycles = (edges: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<Cycle> => {
  const visits = new Map<string, Visit>()
  const stack: Array<{ readonly node: string; readonly visit: Visit }> = []
  const cycles: Array<Cycle> = []

  const enter = (node: string): Frame => {
    const visit = { index: visits.size, lowLink: visits.size, onStack: true }
    visits.set(node, visit)
    stack.push({ node, visit })
    return { node, visit, targets: edges.get(node) ?? [], next: 0 }
  }

  // Pops the component whose first node is `root` off the stack.
  const leave = (root: string): ReadonlyArray<string> => {
    const component: Array<string> = []
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
      top.visit.onStack = false
      component.push(top.node)
      if (top.node === root) {
        break
      }
    }
    return component
  }

  for (const start of [...edges.keys()].toSorted()) {
    if (visits.has(start)) {
      continue
    }
    const frames = [enter(start)]
    for (let frame = frames.at(-1); frame !== undefined; frame = frames.at(-1)) {
      const target = frame.targets[frame.next]
      frame.next += 1
      if (target === undefined) {
        frames.pop()
        const parent = frames.at(-1)
        if (parent !== undefined) {
          parent.visit.lowLink = Math.min(parent.visit.lowLink, frame.visit.lowLink)
        }
        if (frame.visit.lowLink === frame.visit.index) {
          const cycle = cycleThrough(leave(frame.node), edges)
          cycles.push(...Option.toArray(cycle))
        }
        continue
      }
      const seen = visits.get(target)
      if (seen === undefined) {
        frames.push(enter(target))
      } else if (seen.onStack) {
        frame.visit.lowLink = Math.min(frame.visit.lowLink, seen.index)
      }
    }
  }
  return cycles
}

// A shortest cycle through the component's smallest node, found breadth-first inside the
// component, or `None` for one node without an edge to itself.
const cycleThrough = (
  component: ReadonlyArray<string>,
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): Option.Option<Cycle> => {
  const members = component.toSorted()
  const start = members[0]
  if (start === undefined) {
    return Option.none()
  }
  const inComponent = new Set(members)
  const previous = new Map<string, string>()
  const queue = [start]
  for (const node of queue) {
    for (const target of edges.get(node) ?? []) {
      if (target === start) {
        return Option.some({ start, members, path: [...pathFrom(start, node, previous), start] })
      }
      if (inComponent.has(target) && !previous.has(target)) {
        previous.set(target, node)
        queue.push(target)
      }
    }
  }
  return Option.none()
}

// The path from `start` to `end`, following `previous` back from `end`.
const pathFrom = (start: string, end: string, previous: ReadonlyMap<string, string>): ReadonlyArray<string> => {
  const reversed = [end]
  for (let node = previous.get(end); node !== undefined && node !== start; node = previous.get(node)) {
    reversed.push(node)
  }
  if (end !== start) {
    reversed.push(start)
  }
  return reversed.toReversed()
}

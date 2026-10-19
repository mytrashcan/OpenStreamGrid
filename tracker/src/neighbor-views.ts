/** Result of topping up a peer's neighbor view. */
export interface NeighborViewFill {
  /** Peers added to the view of the peer being filled. */
  added: string[];
  /** Peers that added the filled peer to their own view in return. */
  reciprocal: string[];
  /** Links dropped to make room: `watcher` no longer sees `peerId`. */
  evicted: Array<{ watcher: string; peerId: string }>;
}

interface BroadcastViews {
  /** peer -> peers it sees */
  views: Map<string, Set<string>>;
  /** peer -> peers that see it */
  watchers: Map<string, Set<string>>;
  /** Every member, sampled in place by fills; `positions` indexes it. */
  members: string[];
  positions: Map<string, number>;
}

/**
 * Bounded neighbor views per broadcast. Each peer sees at most `size` other
 * peers, so the tracker sends it peer and inventory updates for those peers
 * only, instead of for the whole audience. Every link is made mutual; a peer
 * whose view is full drops a random neighbor to make room, as in HyParView, so
 * newcomers become visible (and get asked for segments) in a full audience.
 *
 * Members must be added before they can be linked. Fills sample the member
 * list in place, so their cost depends on the view size, not the audience.
 */
export class NeighborViews {
  private readonly broadcasts = new Map<string, BroadcastViews>();

  constructor(
    readonly size: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** Whether the broadcast has members, i.e. was seeded or joined. */
  has(broadcastId: string): boolean {
    return this.broadcasts.has(broadcastId);
  }

  /** Registers a member without links. Adding a member twice is a no-op. */
  add(broadcastId: string, peerId: string): void {
    const broadcast = this.broadcastViews(broadcastId);
    if (broadcast.positions.has(peerId)) return;
    broadcast.positions.set(peerId, broadcast.members.length);
    broadcast.members.push(peerId);
    broadcast.views.set(peerId, new Set());
    broadcast.watchers.set(peerId, new Set());
  }

  view(broadcastId: string, peerId: string): ReadonlySet<string> | undefined {
    return this.broadcasts.get(broadcastId)?.views.get(peerId);
  }

  /**
   * Tops up a member's view to `size` from the other members, preferring
   * peers whose own view has room so that fewer links need an eviction.
   */
  fill(broadcastId: string, peerId: string): NeighborViewFill {
    const added: string[] = [];
    const reciprocal: string[] = [];
    const evicted: NeighborViewFill["evicted"] = [];
    const broadcast = this.broadcasts.get(broadcastId);
    const view = broadcast?.views.get(peerId);
    if (!broadcast || !view) return { added, reciprocal, evicted };
    const wanted = this.size - view.size;
    if (wanted <= 0) return { added, reciprocal, evicted };
    // Partial Fisher-Yates over the member list: examine random members until
    // enough have room, or a budget is spent; full ones are a fallback.
    // Existing neighbors also turn up, so they count toward the budget.
    const { members, positions } = broadcast;
    const withRoom: string[] = [];
    const full: string[] = [];
    const budget = view.size + 1 + Math.max(wanted * 8, 64);
    for (
      let index = 0;
      index < members.length && withRoom.length < wanted && index < budget;
      index += 1
    ) {
      const swap = index + Math.floor(this.random() * (members.length - index));
      const candidate = members[swap] as string;
      const displaced = members[index] as string;
      members[swap] = displaced;
      members[index] = candidate;
      positions.set(displaced, swap);
      positions.set(candidate, index);
      if (candidate === peerId || view.has(candidate)) continue;
      (this.hasRoom(broadcast, candidate) ? withRoom : full).push(candidate);
    }
    for (const candidate of [...withRoom, ...full]) {
      if (view.size >= this.size) break;
      this.link(broadcast, peerId, candidate);
      added.push(candidate);
      if (broadcast.views.get(candidate)?.has(peerId)) continue;
      if (!this.hasRoom(broadcast, candidate)) {
        const dropped = this.randomNeighbor(broadcast, candidate);
        if (dropped === undefined) continue;
        this.unlink(broadcast, candidate, dropped);
        evicted.push({ watcher: candidate, peerId: dropped });
      }
      this.link(broadcast, candidate, peerId);
      reciprocal.push(candidate);
    }
    return { added, reciprocal, evicted };
  }

  /** Removes a member and returns the peers whose view contained it. */
  leave(broadcastId: string, peerId: string): string[] {
    const broadcast = this.broadcasts.get(broadcastId);
    const position = broadcast?.positions.get(peerId);
    if (!broadcast || position === undefined) return [];
    for (const neighbor of broadcast.views.get(peerId) ?? []) {
      broadcast.watchers.get(neighbor)?.delete(peerId);
    }
    const lost = [...(broadcast.watchers.get(peerId) ?? [])];
    for (const watcher of lost) broadcast.views.get(watcher)?.delete(peerId);
    broadcast.views.delete(peerId);
    broadcast.watchers.delete(peerId);
    const last = broadcast.members.pop() as string;
    if (last !== peerId) {
      broadcast.members[position] = last;
      broadcast.positions.set(last, position);
    }
    broadcast.positions.delete(peerId);
    if (broadcast.members.length === 0) this.broadcasts.delete(broadcastId);
    return lost;
  }

  removeBroadcast(broadcastId: string): void {
    this.broadcasts.delete(broadcastId);
  }

  private broadcastViews(broadcastId: string): BroadcastViews {
    let broadcast = this.broadcasts.get(broadcastId);
    if (!broadcast) {
      broadcast = { views: new Map(), watchers: new Map(), members: [], positions: new Map() };
      this.broadcasts.set(broadcastId, broadcast);
    }
    return broadcast;
  }

  private hasRoom(broadcast: BroadcastViews, peerId: string): boolean {
    return (broadcast.views.get(peerId)?.size ?? 0) < this.size;
  }

  private randomNeighbor(broadcast: BroadcastViews, peerId: string): string | undefined {
    const neighbors = [...(broadcast.views.get(peerId) ?? [])];
    return neighbors[Math.floor(this.random() * neighbors.length)];
  }

  private unlink(broadcast: BroadcastViews, from: string, to: string): void {
    broadcast.views.get(from)?.delete(to);
    broadcast.watchers.get(to)?.delete(from);
  }

  private link(broadcast: BroadcastViews, from: string, to: string): void {
    broadcast.views.get(from)?.add(to);
    broadcast.watchers.get(to)?.add(from);
  }
}

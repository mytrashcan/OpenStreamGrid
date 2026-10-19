/** Result of topping up a peer's neighbor view. */
export interface NeighborViewFill {
  /** Peers added to the view of the peer being filled. */
  added: string[];
  /** Peers that added the filled peer to their own view in return. */
  reciprocal: string[];
  /** Links dropped to make room: `watcher` no longer sees `peerId`. */
  evicted: Array<{ watcher: string; peerId: string }>;
}

/**
 * Bounded neighbor views per broadcast. Each peer sees at most `size` other
 * peers, so the tracker sends it peer and inventory updates for those peers
 * only, instead of for the whole audience. Every link is made mutual; a peer
 * whose view is full drops a random neighbor to make room, as in HyParView, so
 * newcomers become visible (and get asked for segments) in a full audience.
 */
export class NeighborViews {
  /** broadcast -> peer -> peers it sees */
  private readonly views = new Map<string, Map<string, Set<string>>>();
  /** broadcast -> peer -> peers that see it */
  private readonly watchers = new Map<string, Map<string, Set<string>>>();

  constructor(
    readonly size: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** Every peer that has a view in the broadcast, as fill candidates. */
  peers(broadcastId: string): string[] {
    return [...(this.views.get(broadcastId)?.keys() ?? [])];
  }

  view(broadcastId: string, peerId: string): ReadonlySet<string> | undefined {
    return this.views.get(broadcastId)?.get(peerId);
  }

  /**
   * Tops up a peer's view to `size` from `candidates` (the broadcast's current
   * peer IDs), preferring peers whose own view has room so that fewer links
   * need an eviction. `candidates` is sampled in place, so one array can be
   * shared by many fills; the cost depends on the view size, not the audience.
   */
  fill(broadcastId: string, peerId: string, candidates: string[]): NeighborViewFill {
    const view = this.ensureView(broadcastId, peerId);
    const added: string[] = [];
    const reciprocal: string[] = [];
    const evicted: NeighborViewFill["evicted"] = [];
    const wanted = this.size - view.size;
    if (wanted <= 0) return { added, reciprocal, evicted };
    // Partial Fisher-Yates: examine random candidates until enough of them have
    // room, or a bounded number were examined; full ones are a fallback.
    const withRoom: string[] = [];
    const full: string[] = [];
    const examineLimit = Math.max(wanted * 8, 64);
    for (
      let index = 0;
      index < candidates.length && withRoom.length < wanted && index < examineLimit;
      index += 1
    ) {
      const swap = index + Math.floor(this.random() * (candidates.length - index));
      const candidate = candidates[swap] as string;
      candidates[swap] = candidates[index] as string;
      candidates[index] = candidate;
      if (candidate === peerId || view.has(candidate)) continue;
      (this.hasRoom(broadcastId, candidate) ? withRoom : full).push(candidate);
    }
    for (const candidate of [...withRoom, ...full]) {
      if (view.size >= this.size) break;
      this.link(broadcastId, peerId, candidate);
      added.push(candidate);
      if (this.view(broadcastId, candidate)?.has(peerId)) continue;
      if (!this.hasRoom(broadcastId, candidate)) {
        const dropped = this.randomNeighbor(broadcastId, candidate);
        if (dropped === undefined) continue;
        this.unlink(broadcastId, candidate, dropped);
        evicted.push({ watcher: candidate, peerId: dropped });
      }
      this.link(broadcastId, candidate, peerId);
      reciprocal.push(candidate);
    }
    return { added, reciprocal, evicted };
  }

  /** Removes a peer and returns the peers whose view contained it. */
  leave(broadcastId: string, peerId: string): string[] {
    const views = this.views.get(broadcastId);
    const watchers = this.watchers.get(broadcastId);
    if (!views || !watchers) return [];
    for (const neighbor of views.get(peerId) ?? []) watchers.get(neighbor)?.delete(peerId);
    views.delete(peerId);
    const lost = [...(watchers.get(peerId) ?? [])];
    for (const watcher of lost) views.get(watcher)?.delete(peerId);
    watchers.delete(peerId);
    if (views.size === 0) this.removeBroadcast(broadcastId);
    return lost;
  }

  removeBroadcast(broadcastId: string): void {
    this.views.delete(broadcastId);
    this.watchers.delete(broadcastId);
  }

  private hasRoom(broadcastId: string, peerId: string): boolean {
    return (this.view(broadcastId, peerId)?.size ?? 0) < this.size;
  }

  private ensureView(broadcastId: string, peerId: string): Set<string> {
    let views = this.views.get(broadcastId);
    if (!views) {
      views = new Map();
      this.views.set(broadcastId, views);
      this.watchers.set(broadcastId, new Map());
    }
    let view = views.get(peerId);
    if (!view) {
      view = new Set();
      views.set(peerId, view);
    }
    return view;
  }

  private randomNeighbor(broadcastId: string, peerId: string): string | undefined {
    const neighbors = [...(this.view(broadcastId, peerId) ?? [])];
    return neighbors[Math.floor(this.random() * neighbors.length)];
  }

  private unlink(broadcastId: string, from: string, to: string): void {
    this.views.get(broadcastId)?.get(from)?.delete(to);
    this.watchers.get(broadcastId)?.get(to)?.delete(from);
  }

  private link(broadcastId: string, from: string, to: string): void {
    this.ensureView(broadcastId, from).add(to);
    const watchers = this.watchers.get(broadcastId);
    let watching = watchers?.get(to);
    if (watchers && !watching) {
      watching = new Set();
      watchers.set(to, watching);
    }
    watching?.add(from);
  }
}

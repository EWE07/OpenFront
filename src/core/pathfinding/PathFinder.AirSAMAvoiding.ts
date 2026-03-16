import { Game, Player, UnitType } from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinder } from "./types";

/**
 * Lightweight SAM-avoiding pathfinder for trade jets.
 *
 * Strategy (O(SAMs) per call, NOT O(grid)):
 *   1. Find all hostile SAMs that intersect the straight-line path.
 *   2. For each blocking SAM, compute a perpendicular bypass waypoint
 *      just outside the SAM circle (on the side away from the SAM center).
 *   3. Return a path: from → [bypass waypoints] → to, with each segment
 *      walked tile-by-tile via Bresenham.
 *
 * Zero allocations per tick — paths are only recomputed when the SAM
 * threat count changes (controlled by TradeJetExecution).
 */
export class AirSAMAvoidingPathFinder implements PathFinder<TileRef> {
  // Extra tiles of clearance beyond SAM range for the bypass waypoint
  private static readonly CLEARANCE = 8;
  // Max recursion depth when resolving chained SAM blocks
  private static readonly MAX_DEPTH = 6;

  constructor(
    private readonly game: Game,
    private readonly owner: Player,
  ) {}

  findPath(from: TileRef | TileRef[], to: TileRef): TileRef[] | null {
    if (Array.isArray(from)) {
      throw new Error(
        "AirSAMAvoidingPathFinder does not support multiple start points",
      );
    }

    const sams = this.getHostileSAMs();
    if (sams.length === 0) {
      return this.walkSegment(from, to);
    }

    // Only actively avoid SAMs that are NOT in cooldown
    const activeSams = sams.filter((s) => !s.inCooldown);
    if (activeSams.length === 0) {
      return this.walkSegment(from, to);
    }

    const waypoints = this.resolveWaypoints(from, to, activeSams, 0);
    return this.stitchPath(from, waypoints, to);
  }

  // ─── Core Logic ───────────────────────────────────────────────────────────

  /**
   * Recursively resolve waypoints for a from→to segment.
   * Finds the first blocking SAM, inserts a bypass, then recurses on
   * both sub-segments.
   */
  private resolveWaypoints(
    from: TileRef,
    to: TileRef,
    sams: SAMInfo[],
    depth: number,
  ): TileRef[] {
    if (depth >= AirSAMAvoidingPathFinder.MAX_DEPTH) return [];

    const mg = this.game;
    const fx = mg.x(from);
    const fy = mg.y(from);
    const tx = mg.x(to);
    const ty = mg.y(to);

    const blocking = this.firstBlockingSAM(fx, fy, tx, ty, sams);
    if (blocking === null) return [];

    const bypass = this.computeBypass(fx, fy, tx, ty, blocking);
    const before = this.resolveWaypoints(from, bypass, sams, depth + 1);
    const after = this.resolveWaypoints(bypass, to, sams, depth + 1);
    return [...before, bypass, ...after];
  }

  /**
   * Stitch from → waypoints → to into a single tile path.
   */
  private stitchPath(
    from: TileRef,
    waypoints: TileRef[],
    to: TileRef,
  ): TileRef[] {
    const full: TileRef[] = [];
    let cur = from;
    for (const wp of waypoints) {
      const seg = this.walkSegment(cur, wp);
      if (full.length > 0) seg.shift(); // avoid duplicate join tile
      full.push(...seg);
      cur = wp;
    }
    const last = this.walkSegment(cur, to);
    if (full.length > 0) last.shift();
    full.push(...last);
    return full;
  }

  // ─── Geometry Helpers ─────────────────────────────────────────────────────

  /**
   * Returns the first SAM (lowest parametric t) that blocks segment (fx,fy)→(tx,ty).
   */
  private firstBlockingSAM(
    fx: number,
    fy: number,
    tx: number,
    ty: number,
    sams: SAMInfo[],
  ): SAMInfo | null {
    let best: SAMInfo | null = null;
    let bestT = Infinity;

    for (const sam of sams) {
      const t = this.closestT(fx, fy, tx, ty, sam.cx, sam.cy);
      const clx = fx + t * (tx - fx);
      const cly = fy + t * (ty - fy);
      const dx = clx - sam.cx;
      const dy = cly - sam.cy;
      if (dx * dx + dy * dy < sam.range * sam.range && t < bestT) {
        bestT = t;
        best = sam;
      }
    }
    return best;
  }

  /**
   * Parametric t ∈ [0,1] of the closest point on segment to circle center.
   */
  private closestT(
    fx: number,
    fy: number,
    tx: number,
    ty: number,
    cx: number,
    cy: number,
  ): number {
    const dx = tx - fx;
    const dy = ty - fy;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return 0;
    return Math.max(0, Math.min(1, ((cx - fx) * dx + (cy - fy) * dy) / len2));
  }

  /**
   * Compute a bypass waypoint perpendicular to travel, on the far side of the SAM.
   */
  private computeBypass(
    fx: number,
    fy: number,
    tx: number,
    ty: number,
    sam: SAMInfo,
  ): TileRef {
    const mg = this.game;
    const map = mg.map();
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    // Perpendicular unit vector
    const perpX = -dy / len;
    const perpY = dx / len;

    // Determine which side of travel the SAM is on
    const crossZ = dx * (sam.cy - fy) - dy * (sam.cx - fx);
    // Push bypass to the OPPOSITE side of the SAM center
    const side = crossZ > 0 ? -1 : 1;

    const radius = sam.range + AirSAMAvoidingPathFinder.CLEARANCE;
    const wpX = Math.round(sam.cx + perpX * side * radius);
    const wpY = Math.round(sam.cy + perpY * side * radius);

    const clampedX = Math.max(0, Math.min(map.width() - 1, wpX));
    const clampedY = Math.max(0, Math.min(map.height() - 1, wpY));
    return map.ref(clampedX, clampedY);
  }

  /**
   * Walk a straight tile path from `from` to `to` (Bresenham).
   */
  private walkSegment(from: TileRef, to: TileRef): TileRef[] {
    const mg = this.game;
    const map = mg.map();
    const path: TileRef[] = [from];
    if (from === to) return path;

    let x = mg.x(from);
    let y = mg.y(from);
    const tx = mg.x(to);
    const ty = mg.y(to);
    const maxSteps = map.width() + map.height();

    for (let i = 0; i < maxSteps && (x !== tx || y !== ty); i++) {
      const adx = Math.abs(tx - x);
      const ady = Math.abs(ty - y);
      if (adx >= ady) {
        x += tx > x ? 1 : -1;
      } else {
        y += ty > y ? 1 : -1;
      }
      path.push(
        map.ref(
          Math.max(0, Math.min(map.width() - 1, x)),
          Math.max(0, Math.min(map.height() - 1, y)),
        ),
      );
    }
    return path;
  }

  // ─── Route Viability Check ────────────────────────────────────────────────

  /**
   * Returns true if the direct route from→to is blocked by at least one
   * hostile SAM that is NOT in cooldown (i.e. actively threatening) AND
   * there is no safe bypass around it within the map bounds.
   *
   * SAMs in cooldown are skipped — the jet will try to slip through.
   * Called before spawning and periodically during flight.
   */
  isRouteBlocked(from: TileRef, to: TileRef): boolean {
    const mg = this.game;
    // Only consider SAMs that are active (not on cooldown)
    const activeSAMs = this.getHostileSAMs().filter((s) => !s.inCooldown);
    if (activeSAMs.length === 0) return false;

    // Check if the straight line passes through any active SAM
    const fx = mg.x(from);
    const fy = mg.y(from);
    const tx = mg.x(to);
    const ty = mg.y(to);

    const blockingSAMs = activeSAMs.filter((sam) => {
      const t = this.closestT(fx, fy, tx, ty, sam.cx, sam.cy);
      const clx = fx + t * (tx - fx);
      const cly = fy + t * (ty - fy);
      const dx = clx - sam.cx;
      const dy = cly - sam.cy;
      return dx * dx + dy * dy < sam.range * sam.range;
    });

    if (blockingSAMs.length === 0) return false;

    // Try to find a bypass: for each blocking SAM, check that the bypass
    // waypoint itself isn't inside another active SAM's range
    for (const sam of blockingSAMs) {
      const bypass = this.computeBypass(fx, fy, tx, ty, sam);
      const bx = mg.x(bypass);
      const by = mg.y(bypass);

      const bypassIsSafe = activeSAMs.every((other) => {
        const dx = bx - other.cx;
        const dy = by - other.cy;
        return dx * dx + dy * dy >= other.range * other.range;
      });

      if (!bypassIsSafe) {
        // This blocking SAM has no safe bypass — route is blocked
        return true;
      }
    }

    // All blocking SAMs have viable bypasses
    return false;
  }

  // ─── SAM collection ───────────────────────────────────────────────────────

  private getHostileSAMs(): SAMInfo[] {
    const mg = this.game;
    const result: SAMInfo[] = [];
    for (const player of mg.players()) {
      if (player === this.owner) continue;
      if (this.owner.isFriendly(player)) continue;
      for (const sam of player.units(UnitType.SAMLauncher)) {
        if (sam.isUnderConstruction()) continue;
        result.push({
          cx: mg.x(sam.tile()),
          cy: mg.y(sam.tile()),
          range: mg.config().samRange(sam.level()),
          inCooldown: sam.isInCooldown(),
        });
      }
    }
    return result;
  }
}

interface SAMInfo {
  cx: number;
  cy: number;
  range: number;
  inCooldown: boolean;
}

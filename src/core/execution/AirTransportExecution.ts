import { renderTroops } from "../../client/Utils";
import {
  Execution,
  Game,
  MessageType,
  Player,
  TerraNullius,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { AirSAMAvoidingPathFinder } from "../pathfinding/PathFinder.AirSAMAvoiding";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { distSortUnit } from "../Util";
import { AttackExecution } from "./AttackExecution";

// Tiles moved per tick — same as TradeJet for visual consistency
const AIR_TRANSPORT_SPEED = 3;
const SAM_REPLAN_LOOKAHEAD = 80;

export class AirTransportExecution implements Execution {
  private active = true;
  private mg: Game;
  private target: Player | TerraNullius;
  private pathFinder: SteppingPathFinder<TileRef>;
  private samChecker: AirSAMAvoidingPathFinder;
  private dst: TileRef | null = null;
  private plane: Unit | undefined;
  private originalOwner: Player;
  private lastSamThreatCount = -1;

  constructor(
    private attacker: Player,
    private ref: TileRef,
    private troops: number,
  ) {
    this.originalOwner = this.attacker;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game, ticks: number) {
    if (!mg.isValidRef(this.ref)) {
      console.warn(`AirTransportExecution: ref ${this.ref} not valid`);
      this.active = false;
      return;
    }

    this.mg = mg;
    this.target = mg.owner(this.ref);
    this.samChecker = new AirSAMAvoidingPathFinder(mg, this.attacker);
    this.pathFinder = PathFinding.AirSAMAvoiding(mg, this.attacker);

    if (this.target.isPlayer() && !this.attacker.canAttackPlayer(this.target)) {
      this.active = false;
      return;
    }

    // Must have at least one built (not under construction) airport
    const airports = this.attacker
      .units(UnitType.Airport)
      .filter((a) => !a.isUnderConstruction())
      .sort(distSortUnit(mg, this.ref));

    if (airports.length === 0) {
      mg.displayMessage(
        "events_display.attack_failed",
        MessageType.ATTACK_FAILED,
        this.attacker.id(),
      );
      this.active = false;
      return;
    }

    this.troops = Math.min(
      this.troops ?? mg.config().boatAttackAmount(this.attacker, this.target),
      this.attacker.troops(),
    );

    if (this.troops <= 0) {
      this.active = false;
      return;
    }

    this.dst = this.ref;

    // If the target tile is water, find the nearest land tile
    if (!mg.isLand(this.dst)) {
      const nearest = this.findNearestLandTile(this.dst);
      if (nearest === null) {
        this.active = false;
        return;
      }
      this.dst = nearest;
      this.target = mg.owner(this.dst);
    }
    const src = airports[0].tile();

    this.plane = this.attacker.buildUnit(UnitType.AirTransport, src, {
      troops: this.troops,
      targetTile: this.dst,
    });

    // Notify target of incoming air invasion
    if (this.target.id() !== mg.terraNullius().id()) {
      mg.displayIncomingUnit(
        this.plane.id(),
        `Air invasion incoming from ${this.attacker.displayName()} (${renderTroops(this.plane.troops())})`,
        MessageType.NAVAL_INVASION_INBOUND,
        this.target.id(),
      );
    }

    this.mg
      .stats()
      .boatSendTroops(this.attacker, this.target, this.plane.troops());
  }

  tick(ticks: number) {
    if (!this.active || this.dst === null) {
      this.active = false;
      return;
    }

    if (!this.plane?.isActive()) {
      this.active = false;
      return;
    }

    // Update attacker if disconnected teammate captured the plane
    const planeOwner = this.plane.owner();
    if (
      this.originalOwner.isDisconnected() &&
      planeOwner !== this.originalOwner &&
      planeOwner.isOnSameTeam(this.originalOwner)
    ) {
      this.attacker = planeOwner;
      this.originalOwner = planeOwner;
    }

    // Re-check SAM threats every 20 ticks and replan if changed
    if (ticks % 20 === 0) {
      const curPos = this.plane.tile();
      const samCount = this.countNearbyHostileSAMs(curPos);
      if (samCount !== this.lastSamThreatCount) {
        this.lastSamThreatCount = samCount;
        this.samChecker = new AirSAMAvoidingPathFinder(
          this.mg,
          this.plane.owner(),
        );
        this.pathFinder = PathFinding.AirSAMAvoiding(
          this.mg,
          this.plane.owner(),
        );
      }
    }

    for (let i = 0; i < AIR_TRANSPORT_SPEED; i++) {
      if (!this.plane.isActive()) {
        this.active = false;
        return;
      }

      const result = this.pathFinder.next(this.plane.tile(), this.dst);

      switch (result.status) {
        case PathStatus.COMPLETE:
          this.land();
          return;
        case PathStatus.NEXT:
          this.plane.move(result.node);
          break;
        case PathStatus.NOT_FOUND:
          console.warn("AirTransportExecution: path not found");
          this.attacker.addTroops(this.plane.troops());
          this.plane.delete(false);
          this.active = false;
          return;
      }
    }
  }

  private countNearbyHostileSAMs(tile: TileRef): number {
    const owner = this.plane!.owner();
    let count = 0;
    for (const player of this.mg.players()) {
      if (player === owner || owner.isFriendly(player)) continue;
      for (const sam of player.units(UnitType.SAMLauncher)) {
        if (sam.isUnderConstruction()) continue;
        if (
          this.mg.manhattanDist(tile, sam.tile()) <=
          SAM_REPLAN_LOOKAHEAD + this.mg.config().samRange(sam.level())
        ) {
          count++;
        }
      }
    }
    return count;
  }

  private land() {
    if (!this.plane || this.dst === null) return;

    // Use the plane's actual current tile as the landing tile
    // (may differ slightly from dst due to pathfinding rounding)
    const landingTile = this.plane.tile();

    // Safety: only land on land tiles
    if (!this.mg.isLand(landingTile)) {
      // Find the nearest land tile the attacker can conquer
      const nearest = this.findNearestLandTile(landingTile);
      if (nearest === null) {
        // No valid landing tile — return troops
        this.attacker.addTroops(this.plane.troops());
        this.plane.delete(false);
        this.active = false;
        return;
      }
      this.dst = nearest;
    } else {
      this.dst = landingTile;
    }

    // Arrived at own territory — return troops
    if (this.mg.owner(this.dst) === this.attacker) {
      this.attacker.addTroops(this.plane.troops());
      this.plane.delete(false);
      this.active = false;
      return;
    }

    // Re-read the current owner at landing time
    this.target = this.mg.owner(this.dst);

    // ── Establish a landing zone ──────────────────────────────────────────
    // Conquer a small cluster of tiles around the landing point so the attacker
    // has a proper beachhead with border size > 1, matching the boat invasion feel.
    // Only conquer tiles that belong to the target (not other players).
    const LANDING_RADIUS = 3;
    const landingZone = this.mg
      .map()
      .circleSearch(this.dst, LANDING_RADIUS, (tile, d2) => {
        return (
          d2 <= LANDING_RADIUS * LANDING_RADIUS &&
          this.mg.isLand(tile) &&
          this.mg.owner(tile) === this.target
        );
      });

    // Conquer the center tile first, then the surrounding tiles
    this.attacker.conquer(this.dst);
    for (const tile of landingZone) {
      if (tile !== this.dst) {
        this.attacker.conquer(tile);
      }
    }

    if (this.target.isPlayer() && this.attacker.isFriendly(this.target)) {
      this.attacker.addTroops(this.plane.troops());
    } else {
      // Find the edge tile of the landing zone that has the most enemy neighbors
      // — use it as sourceTile so AttackExecution seeds properly from the beachhead
      // perimeter, not the center. sourceTile !== null also prevents auto-combining
      // with other simultaneous attacks and preserves proper retreat refunds.
      const seedTile = this.bestBeachheadTile(landingZone, this.target);

      this.mg.addExecution(
        new AttackExecution(
          this.plane.troops(),
          this.attacker,
          this.target.id(),
          seedTile,
          false, // troops already extracted when building the plane unit
        ),
      );
    }

    this.mg
      .stats()
      .boatArriveTroops(this.attacker, this.target, this.plane.troops());

    this.plane.delete(false);
    this.active = false;
  }

  /**
   * Returns the tile in the landing zone that has the most enemy neighbors
   * — i.e. the tile on the outer edge of the beachhead facing the enemy.
   * This gives AttackExecution the widest possible starting border.
   */
  private bestBeachheadTile(
    landingZone: Set<TileRef>,
    target: Player | TerraNullius,
  ): TileRef {
    let bestTile = this.dst!;
    let bestCount = 0;
    for (const tile of landingZone) {
      let enemyNeighbors = 0;
      for (const n of this.mg.neighbors(tile)) {
        if (this.mg.owner(n) === target) enemyNeighbors++;
      }
      if (enemyNeighbors > bestCount) {
        bestCount = enemyNeighbors;
        bestTile = tile;
      }
    }
    return bestTile;
  }

  private findNearestLandTile(tile: TileRef): TileRef | null {
    const mg = this.mg;
    const map = mg.map();
    const x = mg.x(tile);
    const y = mg.y(tile);
    // Search outward in a small radius for a land tile
    for (let r = 1; r <= 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!map.isValidCoord(nx, ny)) continue;
          const ref = map.ref(nx, ny);
          if (mg.isLand(ref)) return ref;
        }
      }
    }
    return null;
  }

  isActive(): boolean {
    return this.active;
  }

  owner(): Player {
    return this.attacker;
  }
}

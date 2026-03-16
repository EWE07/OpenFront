import { renderNumber } from "../../client/Utils";
import {
  Execution,
  Game,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PathFinding } from "../pathfinding/PathFinder";
import { AirSAMAvoidingPathFinder } from "../pathfinding/PathFinder.AirSAMAvoiding";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { distSortUnit } from "../Util";

// How many tiles ahead we scan for SAM threats to trigger a path replan
const SAM_REPLAN_LOOKAHEAD = 80;

export class TradeJetExecution implements Execution {
  private active = true;
  private mg: Game;
  private tradeJet: Unit | undefined;
  private wasCaptured = false;
  private pathFinder: SteppingPathFinder<TileRef>;
  private samChecker: AirSAMAvoidingPathFinder;
  private tilesTraveled = 0;
  private lastSamThreatCount = -1;

  constructor(
    private origOwner: Player,
    private srcAirport: Unit,
    private _dstAirport: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.samChecker = new AirSAMAvoidingPathFinder(mg, this.origOwner);
    this.pathFinder = PathFinding.AirSAMAvoiding(mg, this.origOwner);
  }

  tick(ticks: number): void {
    if (this.tradeJet === undefined) {
      // ── Pre-flight safety check ──────────────────────────────────────────
      // If the route is blocked by an active SAM with no viable bypass,
      // do NOT spawn the jet — abort silently and let AirportExecution
      // try again later (it will re-schedule on the next spawn cycle).
      if (
        this.samChecker.isRouteBlocked(
          this.srcAirport.tile(),
          this._dstAirport.tile(),
        )
      ) {
        this.active = false;
        return;
      }

      const spawn = this.origOwner.canBuild(
        UnitType.TradeJet,
        this.srcAirport.tile(),
      );
      if (spawn === false) {
        console.warn(`cannot build trade jet`);
        this.active = false;
        return;
      }
      this.tradeJet = this.origOwner.buildUnit(UnitType.TradeJet, spawn, {
        targetUnit: this._dstAirport,
      });
    }

    if (!this.tradeJet.isActive()) {
      this.active = false;
      return;
    }

    const tradeJetOwner = this.tradeJet.owner();
    const dstAirportOwner = this._dstAirport.owner();

    if (this.wasCaptured !== true && this.origOwner !== tradeJetOwner) {
      this.wasCaptured = true;
    }

    // If destination airport was captured by our source airport owner, cancel
    if (dstAirportOwner.id() === this.srcAirport.owner().id()) {
      this.tradeJet.delete(false);
      this.active = false;
      return;
    }

    if (
      !this.wasCaptured &&
      (!this._dstAirport.isActive() || !tradeJetOwner.canTrade(dstAirportOwner))
    ) {
      this.tradeJet.delete(false);
      this.active = false;
      return;
    }

    if (
      this.wasCaptured &&
      (tradeJetOwner !== dstAirportOwner || !this._dstAirport.isActive())
    ) {
      const airports = this.tradeJet
        .owner()
        .units(UnitType.Airport)
        .sort(distSortUnit(this.mg, this.tradeJet));
      if (airports.length === 0) {
        this.tradeJet.delete(false);
        this.active = false;
        return;
      } else {
        this._dstAirport = airports[0];
        this.tradeJet.setTargetUnit(this._dstAirport);
        this.tradeJet.touch();
      }
    }

    const curTile = this.tradeJet.tile();
    if (curTile === this.dstAirport()) {
      this.complete();
      return;
    }

    // Re-check SAM threats every 20 ticks (cheap: just counts SAMs in area)
    if (ticks % 20 === 0) {
      const currentSamThreatCount = this.countNearbyHostileSAMs(curTile);
      if (currentSamThreatCount !== this.lastSamThreatCount) {
        this.lastSamThreatCount = currentSamThreatCount;

        // Rebuild the checker and pathfinder with latest SAM state
        this.samChecker = new AirSAMAvoidingPathFinder(
          this.mg,
          this.tradeJet.owner(),
        );
        this.pathFinder = PathFinding.AirSAMAvoiding(
          this.mg,
          this.tradeJet.owner(),
        );

        // If the remaining route is now blocked by an active SAM with no
        // safe bypass, abort the flight — the jet disappears silently
        // (no gold, no message) so AirportExecution can retry later.
        if (this.samChecker.isRouteBlocked(curTile, this._dstAirport.tile())) {
          if (this.tradeJet.isActive()) {
            this.tradeJet.delete(false);
          }
          this.active = false;
          return;
        }
      }
    }

    // Speed: tiles moved per tick (3 = 3x faster than a trade ship)
    const JET_SPEED = 3;

    const dst = this._dstAirport.tile();

    for (let step = 0; step < JET_SPEED; step++) {
      const curPos = this.tradeJet.tile();
      if (curPos === dst) {
        this.complete();
        return;
      }

      const result = this.pathFinder.next(curPos, dst);

      switch (result.status) {
        case PathStatus.NEXT:
          this.tradeJet.move(result.node);
          this.tilesTraveled++;
          break;
        case PathStatus.COMPLETE:
          this.complete();
          return;
        case PathStatus.NOT_FOUND:
          console.warn("trade jet cannot find route");
          if (this.tradeJet.isActive()) {
            this.tradeJet.delete(false);
          }
          this.active = false;
          return;
      }
    }
  }

  /**
   * Count hostile SAMs within lookahead range of the given tile.
   * Used to detect when the threat environment changes and a replan is needed.
   */
  private countNearbyHostileSAMs(tile: TileRef): number {
    const owner = this.tradeJet!.owner();
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

  private complete() {
    this.active = false;
    this.tradeJet!.delete(false);
    const gold = this.mg.config().tradeJetGold(this.tilesTraveled);

    if (this.wasCaptured) {
      this.tradeJet!.owner().addGold(gold, this._dstAirport.tile());
      this.mg.displayMessage(
        "events_display.received_gold_from_captured_ship",
        MessageType.CAPTURED_ENEMY_UNIT,
        this.tradeJet!.owner().id(),
        gold,
        {
          gold: renderNumber(gold),
          name: this.origOwner.displayName(),
        },
      );
    } else {
      this.srcAirport.owner().addGold(gold);
      this._dstAirport.owner().addGold(gold, this._dstAirport.tile());
      this.mg.displayMessage(
        "events_display.received_gold_from_trade",
        MessageType.RECEIVED_GOLD_FROM_TRADE,
        this._dstAirport.owner().id(),
        gold,
        {
          gold: renderNumber(gold),
          name: this.srcAirport.owner().displayName(),
        },
      );
      this.mg.displayMessage(
        "events_display.received_gold_from_trade",
        MessageType.RECEIVED_GOLD_FROM_TRADE,
        this.srcAirport.owner().id(),
        gold,
        {
          gold: renderNumber(gold),
          name: this._dstAirport.owner().displayName(),
        },
      );
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  dstAirport(): TileRef {
    return this._dstAirport.tile();
  }
}

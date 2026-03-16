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
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { distSortUnit } from "../Util";

export class TradeJetExecution implements Execution {
  private active = true;
  private mg: Game;
  private tradeJet: Unit | undefined;
  private wasCaptured = false;
  private pathFinder: SteppingPathFinder<TileRef>;
  private tilesTraveled = 0;
  private motionPlanId = 1;
  private motionPlanDst: TileRef | null = null;

  constructor(
    private origOwner: Player,
    private srcAirport: Unit,
    private _dstAirport: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = PathFinding.Air(mg);
  }

  tick(ticks: number): void {
    if (this.tradeJet === undefined) {
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

    const dst = this._dstAirport.tile();
    const result = this.pathFinder.next(curTile, dst);

    switch (result.status) {
      case PathStatus.NEXT: {
        if (dst !== this.motionPlanDst) {
          this.motionPlanId++;
          const from = result.node;
          const path = this.pathFinder.findPath(from, dst) ?? [from];
          if (path.length === 0 || path[0] !== from) {
            path.unshift(from);
          }
          this.mg.recordMotionPlan({
            kind: "grid",
            unitId: this.tradeJet.id(),
            planId: this.motionPlanId,
            startTick: ticks + 1,
            ticksPerStep: 1,
            path,
          });
          this.motionPlanDst = dst;
        }
        this.tradeJet.move(result.node);
        this.tilesTraveled++;
        break;
      }
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

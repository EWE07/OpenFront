import { renderNumber } from "../../client/Utils";
import {
  Execution,
  Game,
  isUnit,
  MessageType,
  Player,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef } from "../game/GameMap";
import { PseudoRandom } from "../PseudoRandom";
import { SAMMissileExecution } from "./SAMMissileExecution";

type Target = {
  unit: Unit;
  tile: TileRef;
};

type InterceptionTile = {
  tile: TileRef;
  tick: number;
};

/**
 * Smart SAM targeting system preshoting nukes so its range is strictly enforced
 */
class SAMTargetingSystem {
  // Interception tiles are computed a single time, but it may not be reachable yet.
  // Store the result so it can be intercepted at the proper time, rather than recomputing each tick.
  // Null interception tile means there are no interception tiles in range. Store it to avoid recomputing.
  private readonly precomputedNukes: Map<number, InterceptionTile | null> =
    new Map();
  private readonly missileSpeed: number;

  constructor(
    private readonly mg: Game,
    private readonly sam: Unit,
  ) {
    this.missileSpeed = this.mg.config().defaultSamMissileSpeed();
  }

  updateUnreachableNukes(nearbyUnits: { unit: Unit; distSquared: number }[]) {
    if (this.precomputedNukes.size === 0) {
      return;
    }

    // Avoid per-tick allocations for the common case where only a few nukes are tracked.
    if (this.precomputedNukes.size <= 16) {
      for (const nukeId of this.precomputedNukes.keys()) {
        let found = false;
        for (const u of nearbyUnits) {
          if (u.unit.id() === nukeId) {
            found = true;
            break;
          }
        }
        if (!found) {
          this.precomputedNukes.delete(nukeId);
        }
      }
      return;
    }

    const nearbyUnitSet = new Set<number>();
    for (const u of nearbyUnits) {
      nearbyUnitSet.add(u.unit.id());
    }
    for (const nukeId of this.precomputedNukes.keys()) {
      if (!nearbyUnitSet.has(nukeId)) {
        this.precomputedNukes.delete(nukeId);
      }
    }
  }

  private tickToReach(currentTile: TileRef, tile: TileRef): number {
    return Math.ceil(
      this.mg.manhattanDist(currentTile, tile) / this.missileSpeed,
    );
  }

  private computeInterceptionTile(
    unit: Unit,
    samTile: TileRef,
    rangeSquared: number,
  ): InterceptionTile | undefined {
    const trajectory = unit.trajectory();
    const currentIndex = unit.trajectoryIndex();
    const explosionTick: number = trajectory.length - currentIndex;
    for (let i = currentIndex; i < trajectory.length; i++) {
      const trajectoryTile = trajectory[i];
      if (
        trajectoryTile.targetable &&
        this.mg.euclideanDistSquared(samTile, trajectoryTile.tile) <=
          rangeSquared
      ) {
        const nukeTickToReach = i - currentIndex;
        const samTickToReach = this.tickToReach(samTile, trajectoryTile.tile);
        const tickBeforeShooting = nukeTickToReach - samTickToReach;
        if (samTickToReach < explosionTick && tickBeforeShooting >= 0) {
          return { tick: tickBeforeShooting, tile: trajectoryTile.tile };
        }
      }
    }
    return undefined;
  }

  public getSingleTarget(ticks: number): Target | null {
    const samTile = this.sam.tile();
    const range = this.mg.config().samRange(this.sam.level());
    const rangeSquared = range * range;

    // Look beyond the SAM range so it can preshot nukes
    const detectionRange = this.mg.config().maxSamRange() * 2;
    const nukes = this.mg.nearbyUnits(
      samTile,
      detectionRange,
      [UnitType.AtomBomb, UnitType.HydrogenBomb],
      ({ unit }) => {
        if (!isUnit(unit) || unit.targetedBySAM()) return false;
        if (unit.owner() === this.sam.owner()) return false;

        const samOwner = this.sam.owner();
        const nukeOwner = unit.owner();

        // After game-over in team games, SAMs also target teammate nukes (aftergame fun)
        if (samOwner.isFriendly(nukeOwner)) {
          return (
            this.mg.getWinner() !== null && samOwner.isOnSameTeam(nukeOwner)
          );
        }

        return true;
      },
    );

    // Clear unreachable nukes that went out of range
    this.updateUnreachableNukes(nukes);

    let best: Target | null = null;
    for (const nuke of nukes) {
      const nukeId = nuke.unit.id();
      const cached = this.precomputedNukes.get(nukeId);
      if (cached !== undefined) {
        if (cached === null) {
          // Already computed as unreachable, skip
          continue;
        }
        if (cached.tick === ticks) {
          // Time to shoot!
          const target = { tile: cached.tile, unit: nuke.unit };
          if (
            best === null ||
            (target.unit.type() === UnitType.HydrogenBomb &&
              best.unit.type() !== UnitType.HydrogenBomb)
          ) {
            best = target;
          }
          this.precomputedNukes.delete(nukeId);
          continue;
        }
        if (cached.tick > ticks) {
          // Not due yet, skip for now.
          continue;
        }
        // Missed the planned tick (e.g was on cooldown), recompute a new interception tile if possible
        this.precomputedNukes.delete(nukeId);
      }
      const interceptionTile = this.computeInterceptionTile(
        nuke.unit,
        samTile,
        rangeSquared,
      );
      if (interceptionTile !== undefined) {
        if (interceptionTile.tick <= 1) {
          // Shoot instantly

          const target = { unit: nuke.unit, tile: interceptionTile.tile };
          if (
            best === null ||
            (target.unit.type() === UnitType.HydrogenBomb &&
              best.unit.type() !== UnitType.HydrogenBomb)
          ) {
            best = target;
          }
        } else {
          // Nuke will be reachable but not yet. Store the result.
          this.precomputedNukes.set(nukeId, {
            tick: interceptionTile.tick + ticks,
            tile: interceptionTile.tile,
          });
        }
      } else {
        // Store unreachable nukes in order to prevent useless interception computation
        this.precomputedNukes.set(nukeId, null);
      }
    }

    return best;
  }
}

export class SAMLauncherExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  // As MIRV go very fast we have to detect them very early but we only
  // shoot the one targeting very close (MIRVWarheadProtectionRadius)
  private MIRVWarheadSearchRadius = 400;
  private MIRVWarheadProtectionRadius = 50;
  private targetingSystem: SAMTargetingSystem;

  private pseudoRandom: PseudoRandom | undefined;

  // Track ally jets that have already paid toll so we only charge once per pass
  private allyJetsTolled: Set<number> = new Set();

  constructor(
    private player: Player,
    private tile: TileRef | null,
    private sam: Unit | null = null,
  ) {
    if (sam !== null) {
      this.tile = sam.tile();
    }
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.mg === null || this.player === null) {
      throw new Error("Not initialized");
    }
    if (this.sam === null) {
      if (this.tile === null) {
        throw new Error("tile is null");
      }
      const spawnTile = this.player.canBuild(UnitType.SAMLauncher, this.tile);
      if (spawnTile === false) {
        console.warn("cannot build SAM Launcher");
        this.active = false;
        return;
      }
      this.sam = this.player.buildUnit(UnitType.SAMLauncher, spawnTile, {});
    }
    this.targetingSystem ??= new SAMTargetingSystem(this.mg, this.sam);

    if (this.sam.isUnderConstruction()) {
      return;
    }

    if (this.sam.isInCooldown()) {
      const frontTime = this.sam.missileTimerQueue()[0];
      if (frontTime === undefined) {
        return;
      }
      const cooldown =
        this.mg.config().SAMCooldown() - (this.mg.ticks() - frontTime);

      if (cooldown <= 0) {
        this.sam.reloadMissile();
      }
      return;
    }

    if (!this.sam.isActive()) {
      this.active = false;
      return;
    }

    if (this.player !== this.sam.owner()) {
      this.player = this.sam.owner();
    }

    this.pseudoRandom ??= new PseudoRandom(this.sam.id());

    const mirvWarheadTargets = this.mg.nearbyUnits(
      this.sam.tile(),
      this.MIRVWarheadSearchRadius,
      UnitType.MIRVWarhead,
      ({ unit }) => {
        if (!isUnit(unit)) return false;
        if (unit.owner() === this.player) return false;

        // After game-over in team games, SAMs also target teammate MIRVs (aftergame fun)
        const nukeOwner = unit.owner();
        if (this.player.isFriendly(nukeOwner)) {
          if (
            this.mg.getWinner() === null ||
            !this.player.isOnSameTeam(nukeOwner)
          ) {
            return false;
          }
        }

        const dst = unit.targetTile();
        return (
          this.sam !== null &&
          dst !== undefined &&
          this.mg.manhattanDist(dst, this.sam.tile()) <
            this.MIRVWarheadProtectionRadius
        );
      },
    );

    let target: Target | null = null;
    if (mirvWarheadTargets.length === 0) {
      target = this.targetingSystem.getSingleTarget(ticks);
      if (target !== null) {
        console.log("Target acquired");
      }
    }

    // If no nuke target, check for enemy TradeJets in range
    if (target === null && mirvWarheadTargets.length === 0) {
      const samRange = this.mg.config().samRange(this.sam.level());
      const jetTargets = this.mg.nearbyUnits(
        this.sam.tile(),
        samRange,
        UnitType.TradeJet,
        ({ unit }) => {
          if (!isUnit(unit)) return false;
          const samOwner = this.sam!.owner();
          const jetOwner = unit.owner();
          // Don't shoot own jets or friendly/allied jets
          if (jetOwner === samOwner) return false;
          if (samOwner.isFriendly(jetOwner)) return false;
          return true;
        },
      );
      if (jetTargets.length > 0) {
        // Pick the closest jet
        const closest = jetTargets.reduce((a, b) =>
          a.distSquared < b.distSquared ? a : b,
        );
        target = { unit: closest.unit, tile: closest.unit.tile() };
      }
    }

    // Collect toll from allied TradeJets passing through SAM range
    this.collectAllyJetTolls();

    // target is already filtered to exclude nukes targeted by other SAMs
    if (target || mirvWarheadTargets.length > 0) {
      this.sam.launch();
      const type =
        mirvWarheadTargets.length > 0
          ? UnitType.MIRVWarhead
          : target?.unit.type();
      if (type === undefined) throw new Error("Unknown unit type");
      if (mirvWarheadTargets.length > 0) {
        const samOwner = this.sam.owner();

        // Message
        this.mg.displayMessage(
          "events_display.mirv_warheads_intercepted",
          MessageType.SAM_HIT,
          samOwner.id(),
          undefined,
          { count: mirvWarheadTargets.length },
        );

        mirvWarheadTargets.forEach(({ unit: u }) => {
          // Delete warheads
          u.delete();
        });

        // Record stats
        this.mg
          .stats()
          .bombIntercept(
            samOwner,
            UnitType.MIRVWarhead,
            mirvWarheadTargets.length,
          );
      } else if (target !== null) {
        target.unit.setTargetedBySAM(true);
        this.mg.addExecution(
          new SAMMissileExecution(
            this.sam.tile(),
            this.sam.owner(),
            this.sam,
            target.unit,
            target.tile,
          ),
        );
      } else {
        throw new Error("target is null");
      }
    }
  }

  /**
   * For each allied TradeJet currently inside this SAM's range:
   *   - Collect a toll of 50% of the estimated remaining gold once per pass.
   *   - Remove IDs of jets that have left range so we can re-toll on the next pass.
   */
  private collectAllyJetTolls(): void {
    const sam = this.sam!;
    const samOwner = sam.owner();
    const samRange = this.mg.config().samRange(sam.level());

    const allyJetsInRange = this.mg.nearbyUnits(
      sam.tile(),
      samRange,
      UnitType.TradeJet,
      ({ unit }) => {
        if (!isUnit(unit)) return false;
        const jetOwner = unit.owner();
        // Only allied jets (not own jets)
        if (jetOwner === samOwner) return false;
        return samOwner.isFriendly(jetOwner);
      },
    );

    // Cleanup: remove jets that have left range from the tolled set
    const inRangeIds = new Set(allyJetsInRange.map(({ unit }) => unit.id()));
    for (const id of this.allyJetsTolled) {
      if (!inRangeIds.has(id)) {
        this.allyJetsTolled.delete(id);
      }
    }

    // Collect toll for jets entering range for the first time
    for (const { unit: jet } of allyJetsInRange) {
      if (this.allyJetsTolled.has(jet.id())) continue;
      this.allyJetsTolled.add(jet.id());

      // Estimate remaining gold: use distance from jet's current tile to destination
      const dstUnit = jet.targetUnit();
      if (dstUnit === undefined || !dstUnit.isActive()) continue;

      const remainingDist = this.mg.manhattanDist(jet.tile(), dstUnit.tile());
      const estimatedGold = this.mg.config().tradeJetGold(remainingDist);
      const toll = estimatedGold / 2n;
      if (toll <= 0n) continue;

      samOwner.addGold(toll, sam.tile());

      this.mg.displayMessage(
        "events_display.received_gold_from_trade",
        MessageType.RECEIVED_GOLD_FROM_TRADE,
        samOwner.id(),
        toll,
        {
          gold: renderNumber(toll),
          name: jet.owner().displayName(),
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
}

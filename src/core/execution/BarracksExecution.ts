import { Execution, Game, Unit } from "../game/Game";

/**
 * Barracks — a structure that boosts troop growth rate.
 *
 * Each tick (while not under construction) it adds a flat troop bonus
 * directly to the owner. The bonus scales with the barracks level:
 *   Level 1: +3 troops/tick
 *   Level 2: +6 troops/tick
 *   Level 3: +9 troops/tick
 *   ...
 *
 * The bonus respects the player's maxTroops cap so it doesn't overflow.
 */
export class BarracksExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(private barracks: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.barracks.isActive()) {
      this.active = false;
      return;
    }

    if (this.barracks.isUnderConstruction()) {
      return;
    }

    const owner = this.barracks.owner();
    const bonus = this.mg.config().barracksTroopBonus(this.barracks.level());

    // Respect the player's max troops cap
    const max = this.mg.config().maxTroops(owner);
    const current = owner.troops();
    const toAdd = Math.min(bonus, max - current);

    if (toAdd > 0) {
      owner.addTroops(toAdd);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }
}

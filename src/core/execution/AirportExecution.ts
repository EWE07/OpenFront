import { Execution, Game, Unit, UnitType } from "../game/Game";
import { PseudoRandom } from "../PseudoRandom";
import { TradeJetExecution } from "./TradeJetExecution";

export class AirportExecution implements Execution {
  private active = true;
  private mg: Game;
  private airport: Unit;
  private random: PseudoRandom;
  private checkOffset: number;
  private tradeJetSpawnRejections = 0;

  constructor(airport: Unit) {
    this.airport = airport;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
    this.checkOffset = mg.ticks() % 10;
  }

  tick(ticks: number): void {
    if (!this.airport.isActive()) {
      this.active = false;
      return;
    }

    if (this.airport.isUnderConstruction()) {
      return;
    }

    // Only check every 10 ticks for performance
    if ((this.mg.ticks() + this.checkOffset) % 10 !== 0) {
      return;
    }

    if (!this.shouldSpawnTradeJet()) {
      return;
    }

    const airports = this.tradingAirports();
    if (airports.length === 0) {
      return;
    }

    const dstAirport = this.random.randElement(airports);
    this.mg.addExecution(
      new TradeJetExecution(this.airport.owner(), this.airport, dstAirport),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  shouldSpawnTradeJet(): boolean {
    const numTradeJets = this.mg.unitCount(UnitType.TradeJet);
    const spawnRate = this.mg
      .config()
      .tradeJetSpawnRate(this.tradeJetSpawnRejections, numTradeJets);
    for (let i = 0; i < this.airport!.level(); i++) {
      if (this.random.chance(spawnRate)) {
        this.tradeJetSpawnRejections = 0;
        return true;
      }
      this.tradeJetSpawnRejections++;
    }
    return false;
  }

  // Weighted list of airports to trade with. Same logic as Port proximity bonuses.
  tradingAirports(): Unit[] {
    const airports = this.mg
      .players()
      .filter(
        (p) => p !== this.airport!.owner() && p.canTrade(this.airport!.owner()),
      )
      .flatMap((p) => p.units(UnitType.Airport))
      .sort(
        (a1, a2) =>
          this.mg.manhattanDist(this.airport!.tile(), a1.tile()) -
          this.mg.manhattanDist(this.airport!.tile(), a2.tile()),
      );

    const weightedAirports: Unit[] = [];
    const totalAirports = airports.length;

    for (const [i, other] of airports.entries()) {
      const expanded = new Array(other.level()).fill(other);
      weightedAirports.push(...expanded);

      const tooClose =
        this.mg.manhattanDist(this.airport!.tile(), other.tile()) <
        this.mg.config().tradeJetShortRangeDebuff();

      const closeBonus = i < Math.min(4, Math.floor(totalAirports / 3) + 1);

      if (!tooClose && closeBonus) {
        weightedAirports.push(...expanded);
      }
      if (!tooClose && this.airport!.owner().isFriendly(other.owner())) {
        weightedAirports.push(...expanded);
      }
    }
    return weightedAirports;
  }
}

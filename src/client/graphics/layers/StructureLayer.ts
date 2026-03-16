import { colord, Colord } from "colord";
import { Theme } from "../../../core/configuration/Config";
import { EventBus } from "../../../core/EventBus";
import { TransformHandler } from "../TransformHandler";
import { Layer } from "./Layer";

import { Cell, UnitType } from "../../../core/game/Game";
import { euclDistFN, isometricDistFN } from "../../../core/game/GameMap";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView, UnitView } from "../../../core/game/GameView";
import cityIcon from "/images/buildings/cityAlt1.png?url";
import factoryIcon from "/images/buildings/factoryAlt1.png?url";
import shieldIcon from "/images/buildings/fortAlt3.png?url";
import anchorIcon from "/images/buildings/port1.png?url";
import missileSiloIcon from "/images/buildings/silo1.png?url";
import SAMMissileIcon from "/images/buildings/silo4.png?url";

const underConstructionColor = colord("rgb(150,150,150)");

// Base radius values and scaling factor for unit borders and territories
const BASE_BORDER_RADIUS = 16.5;
const BASE_TERRITORY_RADIUS = 13.5;
const RADIUS_SCALE_FACTOR = 0.5;
const ZOOM_THRESHOLD = 4.3; // below this zoom level, structures are not rendered

interface UnitRenderConfig {
  icon: string;
  borderRadius: number;
  territoryRadius: number;
}

export class StructureLayer implements Layer {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private unitIcons: Map<string, HTMLImageElement> = new Map();
  private theme: Theme;
  private tempCanvas: HTMLCanvasElement;
  private tempContext: CanvasRenderingContext2D;

  // Configuration for supported unit types only
  private readonly unitConfigs: Partial<Record<UnitType, UnitRenderConfig>> = {
    [UnitType.Port]: {
      icon: anchorIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.City]: {
      icon: cityIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.Factory]: {
      icon: factoryIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.MissileSilo]: {
      icon: missileSiloIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.DefensePost]: {
      icon: shieldIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.SAMLauncher]: {
      icon: SAMMissileIcon,
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
    [UnitType.Airport]: {
      icon: "", // set dynamically in constructor from generated canvas
      borderRadius: BASE_BORDER_RADIUS * RADIUS_SCALE_FACTOR,
      territoryRadius: BASE_TERRITORY_RADIUS * RADIUS_SCALE_FACTOR,
    },
  };

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
  ) {
    this.theme = game.config().theme();
    this.tempCanvas = document.createElement("canvas");
    const tempContext = this.tempCanvas.getContext("2d");
    if (tempContext === null) throw new Error("2d context not supported");
    this.tempContext = tempContext;

    // Generate the Airport icon as a data URL (no external PNG needed)
    this.generateAndLoadAirportIcon();

    this.loadIconData();
  }

  /**
   * Draws a top-down airplane on a 64×64 canvas and loads it as an
   * HTMLImageElement, then registers it for the Airport unit type.
   */
  private generateAndLoadAirportIcon(): void {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d")!;
    const cx = size / 2;
    const cy = size / 2;
    const s = size * 0.33;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "white";
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1;
    ctx.save();
    ctx.translate(cx, cy);

    // Fuselage
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.18, s * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();

    // Main wings
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.05);
    ctx.lineTo(-s * 0.92, s * 0.38);
    ctx.lineTo(-s * 0.55, s * 0.42);
    ctx.lineTo(0, s * 0.18);
    ctx.lineTo(s * 0.55, s * 0.42);
    ctx.lineTo(s * 0.92, s * 0.38);
    ctx.closePath();
    ctx.fill();

    // Tail fins
    ctx.beginPath();
    ctx.moveTo(0, s * 0.42);
    ctx.lineTo(-s * 0.38, s * 0.72);
    ctx.lineTo(-s * 0.12, s * 0.62);
    ctx.lineTo(0, s * 0.55);
    ctx.lineTo(s * 0.12, s * 0.62);
    ctx.lineTo(s * 0.38, s * 0.72);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    const dataUrl = c.toDataURL("image/png");
    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
      this.unitIcons.set(UnitType.Airport, img);
    };
  }

  private loadIcon(unitType: string, config: UnitRenderConfig) {
    const image = new Image();
    image.src = config.icon;
    image.onload = () => {
      this.unitIcons.set(unitType, image);
      console.log(
        `icon loaded: ${unitType}, size: ${image.width}x${image.height}`,
      );
    };
    image.onerror = () => {
      console.error(`Failed to load icon for ${unitType}: ${config.icon}`);
    };
  }

  private loadIconData() {
    Object.entries(this.unitConfigs).forEach(([unitType, config]) => {
      // Airport icon is generated programmatically in generateAndLoadAirportIcon
      if (unitType === UnitType.Airport) return;
      this.loadIcon(unitType, config);
    });
  }

  shouldTransform(): boolean {
    return true;
  }

  tick() {
    const updates = this.game.updatesSinceLastTick();
    const unitUpdates = updates !== null ? updates[GameUpdateType.Unit] : [];
    for (const u of unitUpdates) {
      const unit = this.game.unit(u.id);
      if (unit === undefined) continue;
      this.handleUnitRendering(unit);
    }
  }

  init() {
    this.redraw();
  }

  redraw() {
    console.log("structure layer redrawing");
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d", { alpha: true });
    if (context === null) throw new Error("2d context not supported");
    this.context = context;

    // Enable smooth scaling
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";

    this.canvas.width = this.game.width() * 2;
    this.canvas.height = this.game.height() * 2;

    Promise.all(
      Array.from(this.unitIcons.values()).map((img) =>
        img.decode?.().catch((err) => {
          console.warn("Failed to decode unit icon image:", err);
        }),
      ),
    ).finally(() => {
      this.game.units().forEach((u) => this.handleUnitRendering(u));
    });
  }

  renderLayer(context: CanvasRenderingContext2D) {
    if (
      this.transformHandler.scale <= ZOOM_THRESHOLD ||
      !this.game.config().userSettings()?.structureSprites()
    ) {
      return;
    }
    context.drawImage(
      this.canvas,
      -this.game.width() / 2,
      -this.game.height() / 2,
      this.game.width(),
      this.game.height(),
    );
  }

  private isUnitTypeSupported(unitType: UnitType): boolean {
    return unitType in this.unitConfigs;
  }

  private drawBorder(
    unit: UnitView,
    borderColor: Colord,
    config: UnitRenderConfig,
  ) {
    // Draw border and territory
    for (const tile of this.game.bfs(
      unit.tile(),
      isometricDistFN(unit.tile(), config.borderRadius, true),
    )) {
      this.paintCell(
        new Cell(this.game.x(tile), this.game.y(tile)),
        borderColor,
        255,
      );
    }

    for (const tile of this.game.bfs(
      unit.tile(),
      isometricDistFN(unit.tile(), config.territoryRadius, true),
    )) {
      this.paintCell(
        new Cell(this.game.x(tile), this.game.y(tile)),
        unit.isUnderConstruction()
          ? underConstructionColor
          : unit.owner().territoryColor(),
        130,
      );
    }
  }

  private handleUnitRendering(unit: UnitView) {
    const unitType = unit.type();
    const iconType = unitType;
    if (!this.isUnitTypeSupported(unitType)) return;

    const config = this.unitConfigs[unitType];
    let icon: HTMLImageElement | undefined;
    let borderColor = unit.owner().borderColor();

    // Handle cooldown states and special icons
    if (unit.isUnderConstruction()) {
      icon = this.unitIcons.get(iconType);
      borderColor = underConstructionColor;
    } else {
      icon = this.unitIcons.get(iconType);
    }

    if (!config || !icon) return;

    // Clear previous rendering
    for (const tile of this.game.bfs(
      unit.tile(),
      euclDistFN(unit.tile(), config.borderRadius + 1, true),
    )) {
      this.clearCell(new Cell(this.game.x(tile), this.game.y(tile)));
    }

    if (!unit.isActive()) return;

    this.drawBorder(unit, borderColor, config);

    // Render icon at 1/2 scale for better quality
    const scaledWidth = icon.width >> 1;
    const scaledHeight = icon.height >> 1;
    const startX = this.game.x(unit.tile()) - (scaledWidth >> 1);
    const startY = this.game.y(unit.tile()) - (scaledHeight >> 1);

    this.renderIcon(icon, startX, startY - 4, scaledWidth, scaledHeight, unit);
  }

  private renderIcon(
    image: HTMLImageElement,
    startX: number,
    startY: number,
    width: number,
    height: number,
    unit: UnitView,
  ) {
    let color = unit.owner().borderColor();
    if (unit.isUnderConstruction()) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      color = underConstructionColor;
    }

    // Make temp canvas at the final render size (2x scale)
    this.tempCanvas.width = width * 2;
    this.tempCanvas.height = height * 2;

    // Enable smooth scaling
    this.tempContext.imageSmoothingEnabled = true;
    this.tempContext.imageSmoothingQuality = "high";

    // Draw the image at final size with high quality scaling
    this.tempContext.drawImage(image, 0, 0, width * 2, height * 2);

    // Restore the alpha channel
    this.tempContext.globalCompositeOperation = "destination-in";
    this.tempContext.drawImage(image, 0, 0, width * 2, height * 2);

    // Draw the final result to the main canvas
    this.context.drawImage(this.tempCanvas, startX * 2, startY * 2);
  }

  paintCell(cell: Cell, color: Colord, alpha: number) {
    this.clearCell(cell);
    this.context.fillStyle = color.alpha(alpha / 255).toRgbString();
    this.context.fillRect(cell.x * 2, cell.y * 2, 2, 2);
  }

  clearCell(cell: Cell) {
    this.context.clearRect(cell.x * 2, cell.y * 2, 2, 2);
  }
}

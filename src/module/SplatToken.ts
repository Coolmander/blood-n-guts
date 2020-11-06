import { log, LogLevel } from '../module/logging';
import { BloodNGuts } from '../blood-n-guts';
import { MODULE_ID } from '../constants';
import {
  lookupTokenBloodColor,
  getRandomGlyph,
  getRandomBoxMuller,
  alignSplatsGetOffsetAndDimensions,
  getDirectionNrml,
  getUID,
  distanceBetween,
} from './helpers';
import * as splatFonts from '../data/splatFonts';

export default class SplatToken {
  public id: string;
  public x: number;
  public y: number;
  public bloodColor: string;
  public spriteWidth: number;
  public spriteHeight: number;
  public direction: PIXI.Point;
  public hitSeverity: number;
  public bleedingSeverity: number;
  public currPos: PIXI.Point;
  public lastPos: PIXI.Point;
  public movePos: PIXI.Point;

  private token: Token;
  private hp: number;
  private maxHP: number;
  private splatsContainer: PIXI.Container;
  private bleedingDistance: number;
  private tokenSplats: Array<SplatStateObject>;

  constructor(token: Token) {
    this.bloodColor = lookupTokenBloodColor(token);
    if (this.bloodColor === 'none') return;
    // @ts-ignore
    this.id = token.id || token.actor.data._id;
    this.token = token;
    this.spriteWidth = token.data.width * canvas.grid.size * token.data.scale;
    this.spriteHeight = token.data.height * canvas.grid.size * token.data.scale;
    this.saveState(token);
    this.bleedingSeverity = this.token.getFlag(MODULE_ID, 'bleedingSeverity');
    this.bleedingDistance = 0;
    this.tokenSplats = this.token.getFlag(MODULE_ID, 'splats') || [];
    this.splatsContainer = new PIXI.Container();
  }

  public async createMask(): Promise<void> {
    if (this.bloodColor === 'none') return;
    // @ts-ignore
    const maskTexture = await PIXI.Texture.fromURL(this.token.data.img);
    const maskSprite = PIXI.Sprite.from(maskTexture);
    maskSprite.width = this.spriteWidth;
    maskSprite.height = this.spriteHeight;

    const textureContainer = new PIXI.Container();
    textureContainer.addChild(maskSprite);
    const bwMatrix = new PIXI.filters.ColorMatrixFilter();
    const negativeMatrix = new PIXI.filters.ColorMatrixFilter();
    maskSprite.filters = [bwMatrix, negativeMatrix];
    bwMatrix.brightness(0, false);
    negativeMatrix.negative(false);
    const renderTexture = new PIXI.RenderTexture(
      new PIXI.BaseRenderTexture({
        width: this.spriteWidth,
        height: this.spriteHeight,
        // scaleMode: PIXI.SCALE_MODES.LINEAR,
        // resolution: 1
      }),
    );

    const renderSprite = new PIXI.Sprite(renderTexture);
    canvas.app.renderer.render(textureContainer, renderTexture);

    this.splatsContainer.addChild(renderSprite);
    this.splatsContainer.mask = renderSprite;

    this.splatsContainer.pivot.set(this.spriteWidth / 2, this.spriteHeight / 2);
    this.splatsContainer.position.set(
      (this.token.data.width * canvas.grid.size) / 2,
      (this.token.data.height * canvas.grid.size) / 2,
    );
    this.splatsContainer.angle = this.token.data.rotation;

    // If the `halfHealthBloodied` setting is true we need to pre-splat the tokens that are bloodied
    if (!this.bleedingSeverity && this.hp < this.maxHP / 2 && game.settings.get(MODULE_ID, 'halfHealthBloodied')) {
      this.hitSeverity = 2 - this.hp / (this.maxHP / 2);
      this.bleedingSeverity = this.hitSeverity;
      this.tokenSplats = this.bleedToken();
    }
  }

  public updateSplats(updatedSplats): void {
    if (this.bloodColor === 'none' || JSON.stringify(updatedSplats) === JSON.stringify(this.tokenSplats)) return;
    this.tokenSplats = updatedSplats || [];
    this.draw();
  }

  public updateChanges(changes): void {
    if (
      this.bloodColor === 'none' ||
      (changes.rotation === undefined &&
        changes.x === undefined &&
        changes.y === undefined &&
        changes.actorData?.data?.attributes?.hp === undefined)
    )
      return;
    const updates = { bleedingSeverity: null, splats: null };
    [this.hitSeverity, updates.bleedingSeverity] = this.getUpdatedDamage(changes);
    if (updates.bleedingSeverity !== null) this.bleedingSeverity = updates.bleedingSeverity;
    else delete updates.bleedingSeverity;
    this.direction = this.getUpdatedMovement(changes);
    //this.updateBleeding();

    if (this.hitSeverity > 0) {
      this.bleedFloor();
      updates.splats = this.bleedToken();
    } else if (this.hitSeverity < 0 && this.tokenSplats.length) {
      updates.splats = this.healToken();
    } else delete updates.splats;

    if (this.direction && this.bleedingSeverity) this.bleedTrail();

    this.updateRotation(changes);

    this.saveState(this.token, updates, changes);
  }

  private getUpdatedDamage(changes): [number, number] {
    if (changes.actorData === undefined || changes.actorData.data.attributes?.hp === undefined) return [null, null];
    return this.getSeverities(this.getDamageSeverity(changes));
  }

  private getUpdatedMovement(changes): PIXI.Point {
    if (changes.x === undefined && changes.y === undefined) return;

    const posX = changes.x === undefined ? this.x : changes.x;
    const posY = changes.y === undefined ? this.y : changes.y;
    this.currPos = new PIXI.Point(posX, posY);
    this.lastPos = new PIXI.Point(this.x, this.y);
    this.movePos = new PIXI.Point(this.currPos.x - this.lastPos.x, this.currPos.y - this.lastPos.y);
    log(LogLevel.DEBUG, 'checkForMovement pos: l,c:', this.lastPos, this.currPos);

    return getDirectionNrml(this.lastPos, this.currPos);
  }

  private updateRotation(changes): void {
    if (changes.rotation === undefined) return;
    log(LogLevel.DEBUG, 'updateTokenOrActorHandler updating rotation', changes.rotation);
    this.splatsContainer.angle = changes.rotation;
  }

  private bleedFloor(): void {
    const density = game.settings.get(MODULE_ID, 'floorSplatDensity');
    if (!density) return;
    log(LogLevel.DEBUG, 'updateTokenOrActorHandler damageScale > 0:' + this.id + ' - bleeding:true');
    BloodNGuts.generateFloorSplats(
      this,
      splatFonts.fonts[game.settings.get(MODULE_ID, 'floorSplatFont')],
      game.settings.get(MODULE_ID, 'floorSplatSize'),
      Math.round(density),
    );
  }

  private bleedTrail(): void {
    const density = game.settings.get(MODULE_ID, 'trailSplatDensity');
    if (!density) return;

    const amount = density * this.bleedingSeverity;

    const distTravelled = distanceBetween(new PIXI.Point(), this.movePos) + this.bleedingDistance;
    this.bleedingDistance = (1 / amount) * canvas.grid.size;
    const numSplats = distTravelled / this.bleedingDistance;
    this.bleedingDistance = distTravelled % this.bleedingDistance;

    if (numSplats < 1) return;

    const distances: number[] = [];
    for (let i = 1 / numSplats; i <= 1; i += 1 / numSplats) {
      distances.push(i);
    }
    BloodNGuts.generateTrailSplats(
      this,
      splatFonts.fonts[game.settings.get(MODULE_ID, 'trailSplatFont')],
      game.settings.get(MODULE_ID, 'trailSplatSize'),
      distances,
    );
  }

  private bleedToken(): SplatStateObject[] {
    const splatStateObj: Partial<SplatStateObject> = {};
    const density = game.settings.get(MODULE_ID, 'tokenSplatDensity');
    if (density === 0) return;

    const font = splatFonts.fonts[game.settings.get(MODULE_ID, 'tokenSplatFont')];

    // scale the splats based on token size and severity
    const fontSize = Math.round(
      game.settings.get(MODULE_ID, 'trailSplatSize') *
        ((this.spriteWidth + this.spriteHeight) / canvas.grid.size / 2) *
        this.hitSeverity,
    );
    log(LogLevel.DEBUG, 'bleedToken fontSize', fontSize);
    splatStateObj.styleData = {
      fontFamily: font.name,
      fontSize: fontSize,
      fill: this.bloodColor,
      align: 'center',
    };
    const style = new PIXI.TextStyle(splatStateObj.styleData);
    // amount of splats is based on density and severity
    const amount = Math.round(density * this.hitSeverity);
    if (amount === 0) return;
    // get a random glyph and then get a random (x,y) spread away from the token.
    const glyphArray: Array<string> = Array.from({ length: amount }, () => getRandomGlyph(font));
    const pixelSpreadX = this.spriteWidth * game.settings.get(MODULE_ID, 'splatSpread');
    const pixelSpreadY = this.spriteHeight * game.settings.get(MODULE_ID, 'splatSpread');
    log(LogLevel.DEBUG, 'bleedToken amount', amount);
    log(LogLevel.DEBUG, 'bleedToken pixelSpread', pixelSpreadX, pixelSpreadY);

    // create our splats for later drawing.
    splatStateObj.splats = glyphArray.map((glyph) => {
      const tm = PIXI.TextMetrics.measureText(glyph, style);
      const randX = getRandomBoxMuller() * pixelSpreadX - pixelSpreadX / 2;
      const randY = getRandomBoxMuller() * pixelSpreadY - pixelSpreadY / 2;
      return {
        x: Math.round(randX - tm.width / 2),
        y: Math.round(randY - tm.height / 2),
        width: tm.width,
        height: tm.height,
        glyph: glyph,
      };
    });
    const { offset } = alignSplatsGetOffsetAndDimensions(splatStateObj.splats);
    splatStateObj.offset = offset;
    splatStateObj.splats.forEach((s) => {
      s.x += offset.x + this.spriteHeight / 2;
      s.y += offset.y + this.spriteWidth / 2;
    });

    splatStateObj.id = getUID();
    splatStateObj.tokenId = this.id;

    const updatedSplats = duplicate(this.tokenSplats);

    updatedSplats.push(<SplatStateObject>splatStateObj);
    BloodNGuts.scenePool.push({ state: <SplatStateObject>splatStateObj, splatsContainer: this.splatsContainer });

    return updatedSplats;
  }

  private healToken(): SplatStateObject[] {
    // make positive for sanity purposes
    let tempSeverity = this.hitSeverity * -1;
    // deal with scale/healthThreshold > 1. We can only heal to 100%
    if (tempSeverity > 1) tempSeverity = 1;
    log(LogLevel.DEBUG, 'healToken allTokensSplats:');
    let removeAmount = Math.ceil(this.tokenSplats.length * tempSeverity);
    log(LogLevel.DEBUG, 'healToken removeAmount:', removeAmount);
    const updatedSplats = duplicate(this.tokenSplats);
    while (removeAmount-- > 0) {
      const state = updatedSplats.shift();
      BloodNGuts.scenePool = BloodNGuts.scenePool.filter((poolObj) => poolObj.state.id != state.id);
    }
    return updatedSplats;
    //await this.token.setFlag(MODULE_ID, 'splats', this.tokenSplats);
  }

  private async saveState(token, updates?, changes?): Promise<void> {
    //local state
    this.x = changes?.x || token.x;
    this.y = changes?.y || token.y;
    this.hp = changes?.actorData?.data?.attributes?.hp?.value || token.actor.data.data.attributes.hp.value;
    this.maxHP = changes?.actorData?.data?.attributes?.hp?.max || token.actor.data.data.attributes.hp.max;
    //flag state
    if (updates && Object.keys(updates).length) {
      const flags = {
        [MODULE_ID]: updates,
      };

      await this.token.update({ flags }, { diff: false });
    }

    // reset hit severity and direction for next round.
    this.hitSeverity = null;
    this.direction = null;
    this.movePos = null;
  }

  private getSeverities(severity: number): [number, number] {
    if (severity > (this.bleedingSeverity ?? 0) + 1) {
      return [severity, severity];
    } else if (severity < 0) {
      return [severity, 0];
    }
    return [severity, this.bleedingSeverity];
  }
  /**
   * Get severity, a number between -1 and 2:
   * * > -1[full health or fully healed] to  0[minimal heal]
   * * > 1 + (0[minimal damage] and 0.5[all HP in one hit])* 2 [if dead]
   * * or 0 if not hit at all.
   * @category GMOnly
   * @function
   * @param {Token} token - the token to check.
   * @param {any} changes - the token.actor changes object.
   * @returns {number} - the damage severity.
   */
  private getDamageSeverity(changes): number {
    log(LogLevel.INFO, 'getDamageSeverity', changes.actorData);
    const currentHP = changes.actorData.data.attributes.hp.value;

    //fully healed, return -1
    if (currentHP === this.maxHP) return -1;

    const healthThreshold = game.settings.get(MODULE_ID, 'healthThreshold');
    const damageThreshold = game.settings.get(MODULE_ID, 'damageThreshold');
    const lastHP = this.hp;
    const fractionOfMax = currentHP / this.maxHP;
    const changeFractionOfMax = (lastHP - currentHP) / this.maxHP;

    if (currentHP && currentHP < lastHP) {
      if (fractionOfMax > healthThreshold) {
        log(LogLevel.DEBUG, 'getDamageSeverity below healthThreshold', fractionOfMax);
        return 0;
      }
      if (changeFractionOfMax < damageThreshold) {
        log(LogLevel.DEBUG, 'getDamageSeverity below damageThreshold', fractionOfMax);
        return 0;
      }
    }

    // healing
    if (changeFractionOfMax < 0) {
      //renormalise scale based on threshold.
      return changeFractionOfMax / healthThreshold;
    }
    // dead, multiply by 2.
    const deathMultiplier = currentHP === 0 ? game.settings.get(MODULE_ID, 'deathMultiplier') : 1;
    const severity = 1 + (changeFractionOfMax / 2) * deathMultiplier;

    log(LogLevel.DEBUG, 'getDamageSeverity severity', severity);
    return severity;
  }

  public getCenter(): PIXI.Point {
    return this.token.center;
  }

  private wipe(): void {
    let counter = 0;
    // delete everything except the sprite mask
    while (this.splatsContainer?.children?.length > 1) {
      const displayObj = this.splatsContainer.children[counter];
      if (!displayObj.isMask) displayObj.destroy();
      else counter++;
    }
  }

  public wipeAll(): void {
    this.wipe();
    if (this.token) this.token.setFlag(MODULE_ID, 'splats', null);
    this.tokenSplats = [];
  }

  public removeState(id): void {
    this.tokenSplats = this.tokenSplats.filter((stateObj) => stateObj.id !== id);
  }

  public draw(): void {
    log(LogLevel.DEBUG, 'tokenSplat: draw');
    this.wipe();
    // @ts-ignore
    if (!this.tokenSplats) return;
    BloodNGuts.allFontsReady.then(() => {
      this.tokenSplats.forEach((splatState) => {
        splatState.splats.forEach((splat) => {
          const text = new PIXI.Text(splat.glyph, splatState.styleData);
          text.x = splat.x;
          text.y = splat.y;
          this.splatsContainer.addChild(text);
        });
      });
    });
  }
}

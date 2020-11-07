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

/**
 * Extends `Token` and adds a layer to display token splats.
 * @class
 */
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
  private container: PIXI.Container;
  private bleedingDistance: number;
  private tokenSplats: Array<SplatDataObject>;

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
    this.container = new PIXI.Container();
  }

  /**
   * Creates a transparency mask from the token icon and adds it to it's splat container.
   * @category GMOnly
   * @function
   */
  public createMask(): void {
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

    this.container.addChild(renderSprite);
    this.container.mask = renderSprite;

    this.container.pivot.set(this.spriteWidth / 2, this.spriteHeight / 2);
    this.container.position.set(
      (this.token.data.width * canvas.grid.size) / 2,
      (this.token.data.height * canvas.grid.size) / 2,
    );
    this.container.angle = this.token.data.rotation;

    // If the `halfHealthBloodied` setting is true we need to pre-splat the tokens that are bloodied
    if (!this.bleedingSeverity && this.hp < this.maxHP / 2 && game.settings.get(MODULE_ID, 'halfHealthBloodied')) {
      this.hitSeverity = 2 - this.hp / (this.maxHP / 2);
      this.bleedingSeverity = this.hitSeverity;
      this.tokenSplats = this.bleedToken();
    }
  }

  /**
   * Saves updated splats to tokenSplats and calls draw() if changed.
   * @category GMandPC
   * @param updatedSplats - the latest token splat data.
   * @function
   */
  public updateSplats(updatedSplats): void {
    if (this.bloodColor === 'none' || JSON.stringify(updatedSplats) === JSON.stringify(this.tokenSplats)) return;
    this.tokenSplats = updatedSplats || [];
    this.draw();
  }

  /**
   * Checks for token movement and damage, generates splats and saves updates.
   * @category GMOnly
   * @param changes - the latest token changes.
   * @function
   */
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

  /**
   * Checks for token damage and returns severities.
   * @category GMOnly
   * @function
   * @param changes - the latest token changes.
   * @returns {number, number} - the hitSeverity and bleedingSeverity
   */
  private getUpdatedDamage(changes): [number, number] {
    if (changes.actorData === undefined || changes.actorData.data.attributes?.hp === undefined) return [null, null];
    return this.updateSeverities(this.getDamageSeverity(changes));
  }

  /**
   * Checks for token movement and returns direction.
   * @category GMOnly
   * @function
   * @param changes - the latest token changes.
   * @returns {PIXI.Point} - the direction normalised from {-1,-1} to {0,0} or null if no movement
   */
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

  /**
   * Updates splat container rotation.
   * @category GMOnly
   * @function
   * @param changes - the latest token changes.
   */
  private updateRotation(changes): void {
    if (changes.rotation === undefined) return;
    log(LogLevel.DEBUG, 'updateTokenOrActorHandler updating rotation', changes.rotation);
    this.container.angle = changes.rotation;
  }

  /**
   * Generates blood splatter on the floor under this token.
   * @category GMOnly
   * @function
   */
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

  /**
   * Generates a blood trail behind this token.
   * @category GMOnly
   * @function
   */
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

  /**
   * Generates a blood trail on this token and returns the `SplatDataObject`s
   * @category GMOnly
   * @function
   * @returns {SplatDataObject[]} - the array of updated `SplatDataObject`s
   */
  private bleedToken(): SplatDataObject[] {
    const splatDataObj: Partial<SplatDataObject> = {};
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
    splatDataObj.styleData = {
      fontFamily: font.name,
      fontSize: fontSize,
      fill: this.bloodColor,
      align: 'center',
    };
    const style = new PIXI.TextStyle(splatDataObj.styleData);
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
    splatDataObj.splats = glyphArray.map((glyph) => {
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
    const { offset } = alignSplatsGetOffsetAndDimensions(splatDataObj.splats);
    splatDataObj.offset = offset;
    splatDataObj.splats.forEach((s) => {
      s.x += offset.x + this.spriteHeight / 2;
      s.y += offset.y + this.spriteWidth / 2;
    });

    splatDataObj.id = getUID();
    splatDataObj.tokenId = this.id;

    const updatedSplats = duplicate(this.tokenSplats);
    updatedSplats.push(<SplatDataObject>splatDataObj);
    BloodNGuts.scenePool.push({ data: <SplatDataObject>splatDataObj, container: this.container });

    return updatedSplats;
  }

  /**
   * Removes token splats from our splat container based on scale of healing.
   * @category GMOnly
   * @function
   * @returns {SplatDataObject[]} - the array of updated `SplatDataObject`s
   */
  private healToken(): SplatDataObject[] {
    // make positive for sanity purposes
    let tempSeverity = this.hitSeverity * -1;
    // deal with scale/healthThreshold > 1. We can only heal to 100%
    if (tempSeverity > 1) tempSeverity = 1;
    log(LogLevel.DEBUG, 'healToken allTokensSplats:');
    let removeAmount = Math.ceil(this.tokenSplats.length * tempSeverity);
    log(LogLevel.DEBUG, 'healToken removeAmount:', removeAmount);
    const updatedSplats = duplicate(this.tokenSplats);
    while (removeAmount-- > 0) {
      const data = updatedSplats.shift();
      BloodNGuts.scenePool = BloodNGuts.scenePool.filter((poolObj) => poolObj.data.id != data.id);
    }
    return updatedSplats;
  }

  /**
   * Saves the state of this SplatToken at the end of an update round.
   * @category GMOnly
   * @function
   * @async
   * @param token - token data to save.
   * @param updates - updates to save.
   * @param changes - changes to save.
   */
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

  /**
   * Takes the new damage severity and determines the hitSeverity and bleedingSeverity
   * @category GMOnly
   * @function
   * @param {number} damageSeverity - the updated damage severity.
   * @returns {number, number} - the hitSeverity and bleedingSeverity.
   */
  private updateSeverities(damageSeverity: number): [number, number] {
    if (damageSeverity > (this.bleedingSeverity ?? 0) + 1) {
      return [damageSeverity, damageSeverity];
    } else if (damageSeverity < 0) {
      return [damageSeverity, 0];
    }
    return [damageSeverity, this.bleedingSeverity];
  }

  /**
   * Get severity, a representation of the scale of damage done to this Token in the
   * form of a number between -1 and 2+:
   * * -1[full health or fully healed] to  0[minimal heal]
   * * 1[minimal hit] to 2+[maximal hit]
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

  /**
   * Get center point of this token.
   * @category GMOnly
   * @function
   * @returns {PIXI.Point} - the center point.
   */
  public getCenter(): PIXI.Point {
    return this.token.center;
  }

  /**
   * Wipes all splat tokens but leaves the data and mask alone.
   * @category GMOnly
   * @function
   */
  private wipe(): void {
    let counter = 0;
    // delete everything except the sprite mask
    while (this.container?.children?.length > 1) {
      const displayObj = this.container.children[counter];
      if (!displayObj.isMask) displayObj.destroy();
      else counter++;
    }
  }

  /**
   * Wipes all splat tokens and token data.
   * @category GMOnly
   * @function
   */
  public wipeAll(): void {
    this.wipe();
    if (this.token) this.token.setFlag(MODULE_ID, 'splats', null);
    this.tokenSplats = [];
  }

  /**
   * Removes a token splat based on id.
   * @category GMOnly
   * @function
   * @param {string} - the id of the splat to remove.
   */
  public removeSplat(id): void {
    this.tokenSplats = this.tokenSplats.filter((s) => s.id !== id);
  }

  /**
   * Wipes and draws all splats on this token.
   * @category GMOnly
   * @function
   */
  public draw(): void {
    log(LogLevel.DEBUG, 'tokenSplat: draw');
    this.wipe();
    // @ts-ignore
    if (!this.tokenSplats) return;
    BloodNGuts.allFontsReady.then(() => {
      this.tokenSplats.forEach((splatData) => {
        splatData.splats.forEach((splat) => {
          const text = new PIXI.Text(splat.glyph, splatData.styleData);
          text.x = splat.x;
          text.y = splat.y;
          this.container.addChild(text);
        });
      });
    });
  }
}

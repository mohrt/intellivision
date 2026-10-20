import type { Cartridge } from './cart/cartridge';
import type { CpuBus } from './cpu/cp1610';
import type { Controllers } from './io/controllers';
import type { Ay8914 } from './sound/ay8914';
import type { Stic } from './stic/stic';

export const SCRATCH_RAM = 0x0100;
export const SCRATCH_RAM_SIZE = 0xf0;
export const PSG_BASE = 0x01f0;
export const SYSTEM_RAM = 0x0200;
export const SYSTEM_RAM_SIZE = 0x160;
export const EXEC_BASE = 0x1000;

/**
 * The Intellivision's memory map:
 *
 *   $0000-$003F  STIC registers (aliased at $4000, $8000 and $C000 for writes)
 *   $0100-$01EF  8-bit scratchpad RAM
 *   $01F0-$01FD  AY-3-8914 sound chip; $01FE/$01FF the hand controllers
 *   $0200-$035F  16-bit system RAM; BACKTAB is its first 240 words
 *   $1000-$1FFF  EXEC ROM (10-bit)
 *   $3000-$37FF  GROM; $3800-$39FF GRAM (aliased up to $3FFF)
 *   everything else: the cartridge
 *
 * Unused addresses read $FFFF. Where two chips answer, the bus sees the AND of
 * what they drive, as on the real open-collector bus.
 */
export class IntellivisionBus implements CpuBus {
  readonly scratchRam = new Uint8Array(SCRATCH_RAM_SIZE);
  readonly systemRam = new Uint16Array(SYSTEM_RAM_SIZE);
  exec: Uint16Array | null = null;
  execAux: Uint16Array | null = null;
  cartridge: Cartridge | null = null;
  /** The bus cycle of the instruction running now, for the STIC's access windows. */
  now = 0;
  /** Called before a write to the sound chip, so its output so far uses the old settings. */
  beforeSound: () => void = () => {};

  constructor(
    private readonly stic: Stic,
    private readonly psg: Ay8914,
    private readonly controllers: Controllers,
  ) {}

  read(address: number): number {
    address &= 0xffff;
    const cartridge = this.cartridge;
    if (address < 0x1000) {
      if (address < 0x80) return this.stic.readRegister(address, this.now);
      if (address >= SCRATCH_RAM && address < SCRATCH_RAM + SCRATCH_RAM_SIZE) return this.scratchRam[address - SCRATCH_RAM];
      if (address >= PSG_BASE && address < SYSTEM_RAM) {
        return address >= 0x1fe ? this.controllers.read((address & 1) as 0 | 1) : this.psg.read(address - PSG_BASE);
      }
      if (address >= SYSTEM_RAM && address < SYSTEM_RAM + SYSTEM_RAM_SIZE) return this.systemRam[address - SYSTEM_RAM];
      if (address >= 0x400 && address < 0x500 && this.execAux) return this.execAux[address - 0x400];
      return cartridge ? cartridge.read(address) : 0xffff;
    }
    if (address < 0x2000) return this.exec ? this.exec[address - EXEC_BASE] : 0xffff;
    if (address >= 0x3000 && address < 0x4000) return this.stic.readGraphics(address - 0x3000, this.now);
    const value = cartridge ? cartridge.read(address) : 0xffff;
    if ((address & 0x3fff) < 0x40) return value & this.stic.readRegister(address, this.now);
    return value;
  }

  write(address: number, value: number): void {
    address &= 0xffff;
    value &= 0xffff;
    if (address < 0x1000) {
      if (address < 0x80) this.stic.writeRegister(address, value, this.now);
      else if (address >= SCRATCH_RAM && address < SCRATCH_RAM + SCRATCH_RAM_SIZE) this.scratchRam[address - SCRATCH_RAM] = value;
      else if (address >= PSG_BASE && address < 0x1fe) {
        this.beforeSound();
        this.psg.write(address - PSG_BASE, value);
      } else if (address >= SYSTEM_RAM && address < SYSTEM_RAM + SYSTEM_RAM_SIZE) this.systemRam[address - SYSTEM_RAM] = value;
      else this.cartridge?.write(address, value);
      return;
    }
    if (address < 0x2000) return;
    if (address >= 0x3000 && address < 0x4000) {
      this.stic.writeGraphics(address - 0x3000, value, this.now);
      return;
    }
    if ((address & 0x3fff) < 0x40) this.stic.writeRegister(address, value, this.now);
    this.cartridge?.write(address, value);
  }
}

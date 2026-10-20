const READABLE = 1;
const WRITABLE = 2;
/** RAM that only keeps the low 8 bits. */
const NARROW = 4;

export interface RomBlock {
  address: number;
  words: Uint16Array;
}

export interface RamBlock {
  address: number;
  length: number;
  /** 8 for byte-wide RAM, 16 for word-wide. */
  width: 8 | 16;
}

export interface CartridgeLayout {
  rom: RomBlock[];
  ram: RamBlock[];
}

/**
 * A cartridge as the bus sees it: ROM and RAM anywhere in the 64K-word address
 * space. Addresses it doesn't drive read as $FFFF, like the empty bus.
 */
export class Cartridge {
  /** ROM and RAM contents together; the RAM parts are what save states need. */
  readonly memory = new Uint16Array(0x10000);
  private readonly access = new Uint8Array(0x10000);
  /** The words of ROM, to start RAM from scratch on power up. */
  private readonly romImage: Uint16Array;

  constructor(readonly layout: CartridgeLayout) {
    for (const { address, words } of layout.rom) {
      for (let i = 0; i < words.length; i++) {
        const at = (address + i) & 0xffff;
        this.memory[at] = words[i];
        this.access[at] = READABLE;
      }
    }
    for (const { address, length, width } of layout.ram) {
      for (let i = 0; i < length; i++) {
        this.access[(address + i) & 0xffff] = READABLE | WRITABLE | (width === 8 ? NARROW : 0);
      }
    }
    this.romImage = this.memory.slice();
  }

  /** Clears the RAM (power on). */
  reset(): void {
    this.memory.set(this.romImage);
  }

  read(address: number): number {
    return this.access[address] & READABLE ? this.memory[address] : 0xffff;
  }

  write(address: number, value: number): void {
    const access = this.access[address];
    if (access & WRITABLE) this.memory[address] = access & NARROW ? value & 0xff : value;
  }

  /** The address ranges it uses, for showing to the user. */
  describe(): string {
    const hex = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;
    const rom = this.layout.rom.map((block) => `${hex(block.address)}-${hex(block.address + block.words.length - 1)}`);
    const ram = this.layout.ram.map((block) => `RAM ${hex(block.address)}-${hex(block.address + block.length - 1)}`);
    return [...rom, ...ram].join(', ');
  }
}

import type { CpuBus } from '../../src/cpu/cp1610';

/** 64K words of RAM, for testing the CPU on its own. */
export class FlatBus implements CpuBus {
  readonly memory = new Uint16Array(0x10000);
  readonly writes: [number, number][] = [];

  read(address: number): number {
    return this.memory[address & 0xffff];
  }

  write(address: number, value: number): void {
    this.memory[address & 0xffff] = value;
    this.writes.push([address & 0xffff, value]);
  }

  load(address: number, words: number[]): void {
    this.memory.set(words, address);
  }
}

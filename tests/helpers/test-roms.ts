import type { MachineRoms } from '../../src/roms/system-roms';
import { asm } from './asm';

/**
 * A stand-in EXEC for tests (the real one is copyrighted). Its interrupt
 * handler turns the display on and returns; its main loop counts in R1 and
 * puts the count in BACKTAB's first card, scratch RAM and the sound chip's
 * channel A period.
 */
export function testRoms(): MachineRoms {
  const exec = new Uint16Array(0x1000);
  const at = (address: number, ...instructions: number[][]) => exec.set(instructions.flat(), address - 0x1000);
  at(0x1000, asm.jump(0x1010));
  // $1004: the interrupt handler.
  at(0x1004, asm.direct('mvo', 0x0020, 0), asm.pulr(7));
  at(
    0x1010,
    asm.mvii(0x02f0, 6),
    asm.mvii(0x0008, 1),
    asm.eis(),
    // $1015: the loop.
    asm.incr(1),
    asm.direct('mvo', 0x0200, 1),
    asm.direct('mvo', 0x0100, 1),
    asm.direct('mvo', 0x01f0, 1),
    asm.branch('b', 0x101c, 0x1015),
  );
  // Card n of the GROM is n's bit pattern on every row.
  const grom = Uint8Array.from({ length: 0x800 }, (_, i) => i >> 3);
  return { exec, execAux: null, grom, speech: null };
}

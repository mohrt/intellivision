# Intellivision in the browser

**Play it at [mohrt.github.io/intellivision](https://mohrt.github.io/intellivision/)**

A Mattel Intellivision emulator written from scratch in TypeScript:

- **CPU:** the General Instrument CP1610, every instruction, with the cycle counts jzIntv uses.
- **STIC video:** the background table in Color Stack mode (including Colored Squares cards) and Foreground/Background mode, GROM and GRAM cards, the eight moving objects with their sizes, flips and priority, the delay registers and edge masking, and the collision registers (between objects, with the background and with the border).
- **Timing:** the STIC's frame as jzIntv measured it: the interrupt at the start of vertical blank, the windows in which the CPU can reach the STIC's registers and GRAM, and the bus requests that stop the CPU while the STIC fetches each row of cards. A frame with no write to the display-enable register is blank.
- **Sound:** the AY-3-8914, with its envelope scaling and noise.
- **Intellivoice:** the SP0256 speech chip and its 64-decle FIFO, for the games that talk. It matches jzIntv's Intellivoice sample for sample, from its own ROM and from the FIFO.
- **Hand controllers:** both, with the 16-direction disc, the 12-key keypad and the action buttons.

Drop a `.rom`, `.bin` or `.int` file (or a `.zip` containing one) onto the page to play it.

## The system ROMs

Every Intellivision game runs on the console's Executive ROM (EXEC) and draws with the Graphics ROM (GROM). They are still under copyright, so the site never serves them. On the first visit the page shows a setup panel in place of the screen, asking for your own images:

- **EXEC:** exactly 8,192 bytes, often called `exec.bin`. Mattel's has the CRC-32 `CBCE86F7`. Intellivision II dumps of 8,704 bytes work too.
- **GROM:** exactly 2,048 bytes, often called `grom.bin`. Mattel's has the CRC-32 `683A4158`.
- **Intellivoice ROM** (optional): the speech chip's 2,048-byte ROM, often called `ivoice.bin`, with the CRC-32 `0DE7579D`. Only the few games that talk need it (B-17 Bomber, Space Spartans, Bomb Squad, TRON Solar Sailer and some homebrews); without it they play without speech, and the cartridge panel offers to add it.

They can be chosen at once, or as a `.zip` (MAME's `intv.zip` works). They are kept in the browser's storage, so later visits start straight away. **System ROMs...** in the toolbar replaces or forgets them. ROMs other than Mattel's are accepted after a warning.

No commercial games are included either. Use images of cartridges you own, or homebrews whose authors allow it.

## Cartridges

- **`.rom`** (Intellicart) images say where their ROM and RAM go.
- **`.bin` and `.int`** images are raw big-endian words. With a jzIntv `.cfg` file (in the same `.zip`, with the same name) its `[mapping]`, `[memattr]` RAM and JLP RAM are used. Without one, games with an unusual memory map are recognised by their checksum, from MAME's `intv.hsi` (CC0). Everything else gets the usual map: 8K words at $5000, then $D000 and $F000.
- Titles come from jzIntv's public-domain list of cartridge checksums.

## Free games

`npm run fetch:games` puts the freely licensed games listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free games" picker. Each entry has its credit, licence and source. Games published as ROMs are downloaded and checked against their checksum. Games published only as source are built from a pinned commit with jzIntv's `as1600` assembler and the IntyBASIC compiler, which are built from source too. This needs git, make and a C/C++ compiler.

- **4-Tris** by Joe Zbiciak (GNU GPL v2), falling blocks.
- **Runner-Z** by Josue (GNU GPL v3), a lane-changing runner written in IntyBASIC.
- **Space Versus** by Marco A. Marrero (MIT), a space duel for one or two players, second in AtariAge's IntyBASIC contest.
- **Space Patrol** by Joe Zbiciak, Arnauld Chevallier and David Harley (GNU GPL v2 or later), a moon buggy over craters and under saucers. This is the SDK-1600 build from jzIntv's examples.
- **Tag-Along Todd 2** and **Tank** by Joe Zbiciak (GNU GPL v2 or later), from jzIntv's examples: collect the pop cans without Todd catching you, and an artillery duel for two players.
- **Pumpkin Master**, **IntyPak**, **IntyLander** and **Barzack** by Oscar Toledo G. (BSD 2-Clause), from IntyBASIC's samples: a pumpkin shooter, a maze chase, a lunar lander and a robot-filled escape.
- **Snatch** by Noltisoft (GNU GPL v3), a treasure grab written in IntyBASIC. Three small fixes let it compile with IntyBASIC 1.5.1: a constant defined twice, an `else if` after a one-line `if`, and an `elseif` missing its `then`.

## Controls

- **Keyboard** (player 1, the left controller): arrow keys for the disc, Space or Z for the top action buttons, X and C for the lower left and right ones. The number keys are the keypad, with `-` or Backspace for Clear and `=` or Enter for Enter (the numpad works too). P or Pause pauses.
- **Gamepads** work as soon as you press one of their buttons: the first is player 1, the second player 2 (the right controller). The D-pad, or the left stick in all 16 directions, is the disc. A is the top buttons, X and B the lower left and right. Y and Start are Enter, Back/Select is Clear, and the shoulder buttons and triggers are 1 to 4.
- **On-screen controller**: the disc (press towards a direction), the keypad and the action buttons, for player 1 or player 2. It works with a mouse or by touch.

## Console

The toolbar has pause, the console's reset button, power cycle, full screen and the TV standard (NTSC or PAL). Save states keep the whole console, cartridge included, in the browser. They can be exported and imported as `.intvstate` files.

Not covered: the Entertainment Computer System, the Keyboard Component, paged and bank-switched ROMs, and JLP's accelerators and flash saves.

## Development

```sh
npm install
npm run fetch:games     # optional: the free games into public/games/ (needs git, make, cc)
npm run dev             # http://localhost:5173
npm test
npm run build:carts     # rebuilds src/cart/known-carts.ts from its pinned sources
```

`npm test` also boots the free games and any cartridges you put in `roms/` (never committed), given your own system ROMs there as `exec.bin`, `grom.bin` and (for speech) `ivoice.bin`, or as `INTV_EXEC=/path/to/exec.bin INTV_GROM=/path/to/grom.bin INTV_VOICE=/path/to/ivoice.bin`. Games that talk must speak. A `.bin` there takes the `.cfg` with the same name. `SHOTS=/tmp/shots npm test` saves screenshots.

## Deploying

`.github/workflows/pages.yml` downloads and builds the free games, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").

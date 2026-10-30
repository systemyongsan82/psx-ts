# Resident Evil (USA) — disc facts & acceptance

## Disc

- File: `Resident Evil (USA)/Resident Evil (USA).bin` + `.cue` (single track, MODE2/2352, 289,277 raw sectors, ~64.3 min).
- The `.cue` says INDEX 01 at 00:00:00 but the first synced header in the file reads MSF 00:02:00 — i.e. **file sector 0 IS PSX LBA 0** (`PsxBinImage` auto-detects `baseOffset=0`).
- Form2 payload is 0x914 = 2324 bytes (XA audio blocks occupy 18×128 = 2304 of it; the rest padding/EDC); Form1 user data = 800h = 2048 bytes. Submode form bit = bit5 (0x20); audio+realtime bits (bit2+bit6) decide XA delivery, per docs/kb/cdrom.md §6-7.
- XA audio on this disc: 41,838 audio-flagged Form2 sectors. Layout: interleaved 1-in-8 runs (LBAs 11430..~153746, with periodic larger gaps where data bursts sit between audio), a big pure-Form1 data region 153747..224269, then a contiguous ~45k-sector audio run 224270..269517. This is interleaved/streamed XA — the drive delivers data sectors to CPU and audio to SPU concurrently; RE seeks and reads both.
- ISO9660: volume `RESIDENT_EVIL`; PVD at LBA 16; root dir at LBA 22. Files (dir records):

| name | extent | size |
|---|---|---|
| SYSTEM.CNF | 270718 | 69 |
| SLUS_001.70 | 270719 | 653,312 |
| CAPCOM.INF | 271038 | 1024 |
| ZNULL.DAT | 271039 | 37,044,000 |

- SYSTEM.CNF content: `BOOT = cdrom:SLUS_001.70;1` / `TCB = 4` / `EVENT = 16` / `STACK = 0X801FFF00`.

## Boot exe (PS-X EXE header of SLUS_001.70, nocash semantics)

- Nocash field map (docs/kb/exe-psx.md + addendum): `0x10` = Initial PC, `0x14` = GP, `0x18` = load destination, `0x1C` = filesize (excludes 0x800-byte header), `0x28/0x2C` = memfill (zero-fill region), `0x30/0x34` = SP base/offset.
- SLUS_001.70 observed: `0x10=0x8005F8A0 (entry), 0x14=0 (gp), 0x18=0x80010000 (dest), 0x1C=0x0009F000 (=651,264; 2048+651,264=653,312 ✔), memfill=0, spBase=0x801FFFF0`. Loader rule (`src/disc/psxexe.ts#planExeLoad`): load 651,264 bytes at `0x80010000`, no memfill, **entry 0x8005F8A0**; stack top from SYSTEM.CNF = `0x801FFF00` (SYSTEM.CNF wins over the exe SP base; per nocash boot-state: SP = SystemCnfSp).

## What "playable" requires (acceptance checklist)

1. Boot without crash; CPU reaches game main loop (exe entry 0x8005F8A0 → main loop poll).
2. Intro / title screen visible (GPU display output 320×240, 24-bit NTSC timing acceptable).
3. Title FMV plays (MDEC + XA) OR at minimum Start skips to the title menu cleanly.
4. Title menu navigable with keyboard (pad digital protocol: D-pad, ×=Cross, □=Square, Start).
5. Start game → mansion corridor renders with geometry (GTE), lighting (GPU blending), textures (CLUT).
6. Character walkable with D-pad; interact with  ×; inventory opens.
7. Streaming XA music/ambience audible; SFX (SPU voices) audible after door transitions.
8. Loading door transitions complete (CD file reads of ZNULL.DAT through the CD controller).
9. No save/memcard required.

## Engine/technical notes for RE (known)

- Intro FMVs are XA video (STR interleave) + XA audio → MDEC decode path must work for correct boot flow.
- RE polls its own CD state via kernel cd device; expects `CdOpen/CdRead/CdInt` style completion events. If RE instead uses raw `cdrom:1F801800` command reads, the controller device must be command-complete on its own.
- Timer1 in hblank / timer2 in 1/8-sysclk are used for frame pacing; vsync event classes per nocash: root-counter class `F2000003h` spec 2 (vblank) or IRQ0-callback class `F0000001h` spec 0x1000; CDROM events are class `F0000003h` (see docs/kb/kernel.md §4-5).
- The game never relies on BIOS audio; all audio is XA streaming through SPU CD input + SPU voice SFX.
- RE sets GPU display 320x240 or 368x240 (FMV) and VRAM texture pages at 0xA20 etc; texture window + dithering used; do not approximate.
- Save data: not required. Disable-safe: if the game asks, reply "no memcard" via SIO absence (DIP: pad only).
- `ZNULL.DAT` reads are large sequential (36MB in ≈ seconds); HLE fast path (`CdRomHle.readIntoRam`) exists exactly for this.

## Integration harness expectations

- Boot log must show: SYSTEM.CNF found → exe loaded (bytes count) → entry PC set → first frames render.
- Headless screenshots land in `shots/`; stop-on-error dumps last 4096 log lines (`shots/stopped.log`).
- Known first suspects when RE fails: TCB/event setup, CD IRQ semantics (INT1 vs INT3 ordering), GTE flags, pad ACK timing, ZNULL read path.
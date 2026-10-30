# Resident Evil (USA) — disc facts & acceptance

## Disc

- File: `Resident Evil (USA)/Resident Evil (USA).bin` + `.cue` (single track, MODE2/2352, 289,277 raw sectors, ~64.3 min).
- The `.cue` says INDEX 01 at 00:00:00 but the first synced header in the file reads MSF 00:02:00 — i.e. **file sector 0 IS PSX LBA 0** (`PsxBinImage` auto-detects `baseOffset=0`).
- Sync pattern per sector: `00 FF FF FF FF FF FF FF FF FF FF 00`, MSF at offset 12, mode byte at 15, subheader (file/ch/submode/coding) at 16..19, user data at 24 (2048 bytes, Form1) or audio at 24 (2328 bytes, Form2).
- Form2 usage on this disc: 41,842 sectors — essentially one giant XA-audio stream from raw 11430 to 269517 (~57 min; RE's continuous streamed music/ambience, seeked by the game). A few stray Form2 sectors near the start.
- ISO9660: volume `RESIDENT_EVIL`; PVD at LBA 16; root dir at LBA 22. Files (dir records):

| name | extent | size |
|---|---|---|
| SYSTEM.CNF | 270718 | 69 |
| SLUS_001.70 | 270719 | 653,312 |
| CAPCOM.INF | 271038 | 1024 |
| ZNULL.DAT | 271039 | 37,044,000 |

- SYSTEM.CNF content: `BOOT = cdrom:SLUS_001.70;1` / `TCB = 4` / `EVENT = 16` / `STACK = 0X801FFF00`.

## Boot exe (PS-X EXE header of SLUS_001.70)

- `t_addr=0x8005F8A0, t_size=0, d_addr=0x80010000, d_size=0x0009F000 (651,264), pc=0, gp=0`
- Loader rule encoded in `src/disc/psxexe.ts#planExeLoad`: t_size=0 → skip text load; load 651,264 bytes at `0x80010000`; entry = `pc==0 ? t_addr : pc` → **entry 0x8005F8A0**; stack top from SYSTEM.CNF = `0x801FFF00`.

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
- Timer1 in hblank / timer2 in 1/8-sysclk are used for frame pacing; vsync event (kernel spec 0xF1000002?) drives the main loop.
- The game never relies on BIOS audio; all audio is XA streaming through SPU CD input + SPU voice SFX.
- RE sets GPU display 320x240 or 368x240 (FMV) and VRAM texture pages at 0xA20 etc; texture window + dithering used; do not approximate.
- Save data: not required. Disable-safe: if the game asks, reply "no memcard" via SIO absence (DIP: pad only).
- `ZNULL.DAT` reads are large sequential (36MB in ≈ seconds); HLE fast path (`CdRomHle.readIntoRam`) exists exactly for this.

## Integration harness expectations

- Boot log must show: SYSTEM.CNF found → exe loaded (bytes count) → entry PC set → first frames render.
- Headless screenshots land in `shots/`; stop-on-error dumps last 4096 log lines (`shots/stopped.log`).
- Known first suspects when RE fails: TCB/event setup, CD IRQ semantics (INT1 vs INT3 ordering), GTE flags, pad ACK timing, ZNULL read path.
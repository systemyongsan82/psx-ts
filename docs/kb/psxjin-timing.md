# PSXjin timing and movie semantics

Source: github.com/TASVideos/psxjin, commit 534fd3856913c3198e649806a91db5c232e4d34a (2013-11-04), directory `psxjin/`.
PSXjin is a PCSX 1.5 derivative. All values below are read from that tree. Citations are file:line in that tree.

## Boot

| Fact | Source |
|---|---|
| Reset: `pc = 0xBFC00000`, `SR = 0x10900000`, `PRid = 2`, then `psxExecuteBios()` | R3000A.cpp:44-60 |
| `psxExecuteBios()` runs `ExecuteBlock()` until `pc == 0x80030000` | R3000A.cpp:199-202 |
| `Config.HLE` is forced to 0 | PsxMem.cpp:84 |
| `LoadCdrom()` with `!Config.HLE` only does `psxRegs.pc = psxRegs.GPR.n.ra; return 0` | Misc.cpp:191-201 |
| Run CD / movie start: `SysReset(); CheckCdrom(); LoadCdrom(); Movie.currentFrame = 0` | Win32/WndMain.cpp:687-697, movie.cpp:1119-1123 |

So PSXjin does **not** load the exe directly. It runs the real BIOS to the shell entry, returns from the shell call (skipping the Sony/PlayStation logos), and the real BIOS then reads SYSTEM.CNF and the exe through its own CD code. Movie frame 0 begins at that point. Cycles spent before it are not counted as movie frames.

## CPU and frame timing

| Constant | Value | Source |
|---|---|---|
| `PSXCLK` | 33,868,800 | PsxCommon.h:330 |
| `BIAS` | 2 | PsxCommon.h:329 |
| Cycles per instruction (interpreter) | 1 (`psxRegs.cycle++`), no extra for loads, stores, mult, div or GTE | PsxInterpreter.cpp:121, 422 |
| VSync counter rate (NTSC) | `PSXCLK/60 = 564,480`, split into `rate - (rate/262)*22 = 517,092` and `(rate/262)*22 = 47,388` (vblank part) | PsxCounters.cpp:108-122 |
| Frame length in CPU cycles | each part is divided by `BIAS` (period = `(target - count) * rate / BIAS`, target 1, count 0), so `258,546 + 23,694 = 282,240` cycles = 282,240 instructions | PsxCounters.cpp:38, 108-122 |
| VBlank IRQ0 raised | at "VSync Start" (I_STAT bit 0) | PsxCounters.cpp:267-272 |
| Root counter period | `(target - count) * rate / BIAS` cycles | PsxCounters.cpp:38-40 |
| Counter 1 hblank source rate | `vsyncRate / 262` | PsxCounters.cpp:322 |
| Counter 0 dotclock source rate | `vsyncRate / 386 / 262` | PsxCounters.cpp:313 |
| Counter 2 sysclk/8 | rate 8 | PsxCounters.cpp:331 |
| SPU async tick | every 768 cycles | PsxCounters.cpp:96 |

Interrupt and event checks run in `psxBranchTest()` (R3000A.cpp:121), which the interpreter calls on branches, not every instruction.

## Movie frame and input latch

| Fact | Source |
|---|---|
| `Movie.currentFrame++` happens at "VSync End", after the 22-line vblank period | PsxCounters.cpp:129-147 |
| Input for a frame is read when the game first polls the pad in that frame (`iJoysToPoll == 2`), otherwise it is consumed at VSync End as a lag frame | plugins.cpp:446-482, PsxCounters.cpp:170-223 |
| Text pad line: 13 chars shifted into bits 15..3, then char 13 into bit 0, then `^0xFFFF` | movie.cpp:656-667 |
| Pad mnemonics `#XO^1234LDRUSLRs` | movie.cpp:932 |

Column → button: Square, Cross, Circle, Triangle, R1, L1, R2, L2, Left, Down, Right, Up, Start, Select.

## SIO

| Constant | Value | Source |
|---|---|---|
| `SIO_INT` delay per byte | 200 cycles | Sio.cpp:62-68 |

## CD-ROM

| Constant | Value | Source |
|---|---|---|
| `cdReadTime` | `(PSXCLK/75)/BIAS = 225,792` cycles; at double speed `/2 = 112,896` | CdRom.cpp:86, 595 |
| Command first response | `AddIrqQueue(cmd, 0x800)` for almost every command | CdRom.cpp:729-924 |
| Exception: one command uses `0x40000` | CdRom.cpp:813 |
| Second responses (Pause, Init, SeekL, SeekP, GetID, ReadToc) | `0x800` | CdRom.cpp:259, 277, 392, 409, 443, 482 |
| Read start | `READ_ACK` after `0x800`, then sectors every `cdReadTime` (or `/2`) | CdRom.cpp:105-111, 595, 642 |
| Seek time | none modelled | CdRom.cpp |

With 282,240 cycles per frame, PSXjin delivers 2.5 sectors per frame at double speed, the same as real hardware. What differs is the CPU work per frame: 282,240 instructions at 1 cycle each.

## DMA and MDEC

| Item | Delay | Source |
|---|---|---|
| GPU DMA completion | `(words/4)/BIAS` cycles | PsxDma.cpp:104 |
| MDEC out DMA | `(size/4)/BIAS` cycles | Mdec.cpp:288, 296 |

| CD sector delivery | `cdrReadInterrupt` retries every 0x800 cycles while `cdr.Stat` is still pending, otherwise delivers and re-arms `cdReadTime` (`/2` at double speed) | CdRom.cpp:566-571, 595, 639-641 |
| CD interrupt retry | `cdrInterrupt` re-arms 0x800 while `cdr.Stat` is set | CdRom.cpp:167-170 |
| READ_ACK then first sector | `CDREAD_INT(0x40000)` | CdRom.cpp:517-526 |
| CD DMA (DMA3) | completes immediately, no delay | CdRom.cpp:1066-1073 |
| SPU DMA (DMA4) | completes immediately, no delay | PsxDma.cpp:58-59 |
| MDEC-in DMA (DMA0) | completes immediately | Mdec.cpp:251-269 |
| MDEC out `mdec1Interrupt` re-arm | `PSXCLK / 1000` while DMA1 still busy | Mdec.cpp:310-318 |
| Root counter reads | count advances `BIAS * cycles / rate` (counters tick twice per cycle) | PsxCounters.cpp:356-361 |
| Root counter 0/1 rate in hblank/dot modes | `vsync rate / 386 / 262`, `vsync rate / 262` | PsxCounters.cpp:313, 322 |
| Movie frame boundary | `Movie.currentFrame++` at VSync End, 22 hsyncs after IRQ0 (VSync Start) | PsxCounters.cpp:129-147, 267-272 |
| Pad value for a frame | first `PAD1_startPoll` after `iJoysToPoll = 2` (set in `execI` when `iVSyncFlag`) | plugins.cpp:446-482, PsxInterpreter.cpp:99-116 |

Modelled in the psxjin profile: sector retry (`sectorRetryCycles`), GPU and MDEC-out completion (`dmaWordDivisor`). Root counter rates are not modelled; our line-driven timers advance 2150 per line, PSXjin 564,480 per frame (about 0.2% apart).

## Memory cards

| Fact | Source |
|---|---|
| Header flag bit 3 `MOVIE_FLAG_MEMORY_CARDS` | PsxCommon.h:280 |
| Without that flag, both slots get fresh temp cards (`SIO_ClearMemoryCardsEmbed` → `LoadMcd` → `CreateMcd`) | movie.cpp:379-400, Sio.cpp:735-741 |
| `CreateMcd`: "MC" frame 0 with checksum 0x0E, 15 directory frames 0xA0 | Sio.cpp:374-440 |

Both slot 1 and slot 2 hold a blank formatted card.

## PJM header (v2)

| Offset | Field | Source |
|---|---|---|
| 0x0C | u16 flags | movie.cpp:186 |
| 0x0E | pad type port 1 | movie.cpp:215 |
| 0x0F | pad type port 2 | movie.cpp:216 |
| 0x10 | total frames | movie.cpp:218 |
| 0x14 | rerecords | movie.cpp:219 |
| 0x18, 0x1C, 0x20, 0x24, 0x28, 0x2C | offsets: savestate, card 1, card 2, cheats, CD ids, input | movie.cpp:220-225 |

Flag bits: 1 savestate, 2 PAL, 3 memory cards, 4 cheats, 5 IRQ hacks, 6 text, 7/8 multitap, 9 analog hack, 10 RCntFix (PsxCommon.h:278-287).
Pad types: 4 standard, 7 analog pad, 8 none (PSEmu_Plugin_Defs.h:175-181, PsxCommon.h:277).

The Director's Cut TAS: flags `0x0240` (text, analog hack), pad 1 = 4 standard, pad 2 = 8 none, power-on start, no embedded cards.

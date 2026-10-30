# PS-EXE / SYSTEM.CNF — completed from vendored nocash (2024-10-30 pass)
Adds the authoritative field meanings that were "OPEN" in the earlier version. Source: [PSX-SPX §CDROM File Playstation EXE and SYSTEM.CNF](https://problemkaputt.de/psx-spx.htm#cdromfileplaystationexeandsystemcnf) (docs/raw/psx-spx.htm L8846–8943).

## Header (verbatim; header = 800h bytes, not 2048!)
```
  000h-007h ASCII ID "PS-X EXE"
  008h-00Fh Zerofilled
  010h      Initial PC                   (usually 80010000h, or higher)
  014h      Initial GP/R28               (usually 0)
  018h      Destination Address in RAM   (usually 80010000h, or higher)
  01Ch      Filesize (must be N*800h)    (excluding 800h-byte header)
  020h      Unknown/Unused ;Addr         (usually 0)  ;\optional overlay?
  024h      Unknown/Unused ;Size         (usually 0)  ;/(not auto-loaded)
  028h      Memfill Start Address        (usually 0) (when below Size=None)
  02Ch      Memfill Size in bytes        (usually 0) (0=None)
  030h      Initial SP/R29 & FP/R30 Base (usually 801FFFF0h) (or 0=None)
  034h      Initial SP/R29 & FP/R30 Offs (usually 0, added to above Base)
  038h-04Bh Reserved for A(43h) Function (should be zerofilled in exefile)
  04Ch-xxxh ASCII marker "Sony Computer Entertainment Inc. for ..."
  xxxh-7FFh Zerofilled ; 800h... Code/Data (loaded to entry[018h] and up)
```
Code/data loads to [018h] with size [01Ch]; no relocation. "In bootfiles, SP is usually 801FFFF0h ... (but in most cases the stack values in the exeheader seem to be ignored ... eg. replaced by the SYSTEM.CNF value)". Memfill = zerofill [028h]..+[02Ch] (word-by-word; executed in slow uncached BIOS ROM). Region [038h-04Bh] is BIOS-internal RA/SP/R30/R28/R16 storage. Arguments: R4=1, R5=0 typically.

## SYSTEM.CNF (verbatim semantics)
```
  BOOT = cdrom:\abcd_123.45;1 arg ;boot exe (drive:\path\name.ext;version)
  TCB = 4                         ;HEX (=4 decimal)   ;max number of threads
  EVENT = 10                      ;HEX (=16 decimal)  ;max number of events
  STACK = 801FFF00                ;HEX (=memtop-256)
```
Case-insensitive filename; `;1` = ISO version number; optional `arg` (≤128 bytes) copied to **00000180h**; lines terminated CRLF. Values are HEX.

## Observed on this disc [docs/re-notes.md] — same values, now correctly interpreted
- t_addr/PC@0x10 = 0x8005F8A0 (=Initial PC = entry), GP@0x14 = 0, dest@0x18 = 0x80010000, filesize@0x1C = 0x0009F000 = 651,264 (=2048+651,264 = 653,312 ✔ and 653,312 = 0x800×319 ✔ N*800h check), pc@0x28 = 0 (=memfill none), STACK from SYSTEM.CNF = 0X801FFF00 (with literal "0X" prefix on the disc).

## ⚠ Divergence for src/disc/psxexe.ts (KB note)
`parsePsExe` maps 0x10→textAddr, 0x14→textSize, 0x28→pc (entry=pc||0, fallback 0x10). nocash semantics: 0x10 = **PC/entry** directly, 0x14 = GP, 0x28 = **memfill start** (when its sibling size@0x2C = 0 this region is unused, i.e. NOT an entry point). For Resident Evil the two schemas coincide (0x14=0 → no text load; 0x28=0 → entry falls back to word@0x10=0x8005F8A0), so boot behavior is identical. But any game setting memfill (0x28/0x2C) would, under the current parsing, get word@0x28 treated as a PC jump instead of a memfill — fix while touching this file (load only [0x18]/[0x1C], entry=[010], optional memfill from [0x28]/[0x2C]).

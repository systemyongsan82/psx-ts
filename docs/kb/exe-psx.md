# PS-EXE format — verified facts from this disc (USA, SLUS-00170)

Status: written from local artifacts only — the disc image
`Resident Evil (USA)/Resident Evil (USA).bin`, as recorded in `docs/re-notes.md`,
its cue sheet, and the loader `src/disc/psxexe.ts`.
No external source could be fetched during this pass, so the general format
rows marked **OPEN** below are intentionally empty instead of guessed.
Re-verify each OPEN item against [nocash PSX-SPX](https://problemkaputt.de/psx-spx.htm)
(PSX-EXE / SYSTEM.CNF sections) once available.

## Container

- Cue sheet, verbatim excerpt of `Resident Evil (USA)/Resident Evil (USA).cue`: single
  track, `TRACK 01 MODE2/2352`, `INDEX 01 00:00:00`.
- Raw sector layout as implemented in `src/disc/image.ts`: 2352-byte sectors; 12-byte
  sync `00 FF FF FF FF FF FF FF FF FF FF 00`; MSF at 12–14; mode byte at 15; XA
  subheader at 16–19 (file/channel/submode/coding); user data at 24 (= 2048 bytes,
  Form1) [notes §Disc].
- The file's sector 0 is PSX LBA 0 — `PsxBinImage.detectBaseOffset` (image.ts) finds
  MSF 00:02:00 = LBA 150 at file sector 0, so `baseOffset = 0` [notes §Disc].
- ISO9660: `CD001` PVD at LBA 16, volume id, root/extents scanned by
  `src/disc/iso9660.ts` (`ROOT_PVD_LBA = 16`, user data again at byte 24, size 2048).

## Files on this disc (extents as recorded [notes §Disc])

| name | extent (LBA) | size (B) |
|---|---|---|
| SYSTEM.CNF | 270718 | 69 |
| SLUS_001.70 | 270719 | 653,312 |
| CAPCOM.INF | 271038 | 1024 |
| ZNULL.DAT | 271039 | 37,044,000 |

User-data byte offset of extent L inside the .bin = `L * 2352 + 24`
(SYSTEM.CNF → 636,728,760; SLUS_001.70 → 636,731,112).

## SYSTEM.CNF (contents as recorded [notes §Disc; 69 bytes])

```
BOOT = cdrom:SLUS_001.70;1
TCB = 4
EVENT = 16
STACK = 0X801FFF00
```

Consistency check: those 4 lines with CRLF endings total exactly 69 bytes, matching
the recorded file size. **OPEN:** BIOS-level meaning of TCB/EVENT values (4/16) and
how STACK feeds the kernel stack setup is not documented from a citable local source
yet; nothing in `src/` parses this file so far.

## SLUS_001.70 header — 2048-byte header, observed values [notes §Boot exe;
   offset/name mapping as implemented in `src/disc/psxexe.ts` `parsePsExe`]

| Offset | Field       | Observed value | Notes |
|---|---|---|---|
| 0x00 | magic | `PS-X EXE` (8 B) | hardcoded check in psxexe.ts |
| 0x08 | — | (not captured) | **OPEN** |
| 0x10 | text address | 0x8005F8A0 | |
| 0x14 | text size | 0 | see load rule below |
| 0x18 | data address | 0x80010000 | |
| 0x1C | data size | 0x0009F000 = 651,264 | 2048 + 651,264 = 653,312 = full exe size ✔ |
| 0x20 | bss address | (value not recorded) | parsed by psxexe.ts; **OPEN** |
| 0x24 | bss size | (value not recorded) | parsed by psxexe.ts; **OPEN** |
| 0x28 | PC (entry) | 0 → entry falls back to text address = 0x8005F8A0 | psxexe.ts: `pcField !== 0 ? pcField : textAddr` |
| 0x2C | GP | 0 | |
| 0x30–0x4C | — | (not captured) | **OPEN** |

Load rule as implemented (`planExeLoad`): copy `textSize` bytes to `textAddr` when
nonzero, then `dataSize` bytes to `dataAddr`; zero `bssSize` bytes at `bssAddr` when
nonzero; entry = `pc`, or the text address when `pc == 0`. The `t_size == 0` variant
is observed here in the wild: the executable's "text" is empty and its entire payload
loads via the data segment. Stack top from SYSTEM.CNF = 0x801FFF00 [notes §Boot exe].

## OPEN items needing a fetched spec

- Exact meaning of all documented header fields beyond those observed (T/S fields at
  0x30/0x34, stack base/offset at 0x38/0x3C, timestamp fields at 0x44/0x48, 0x4C+),
  and the canonical field names.
- Whether `pc` should be treated as a *PSX address in kuseg* (0x80010000-style masks)
  on every disc, or whether t_addr-relative PC exists.
- BIOS-level meaning of `TCB=`/`EVENT=`/`STACK=` and the `;1` version suffix in BOOT.

Fetch targets: [nocash PSX-SPX](https://problemkaputt.de/psx-spx.htm) — a local copy
is now vendored at `docs/raw/psx-spx.htm`; GitHub mirrors of psx-spx;
the DobieStation/pcsxr/mednafen/Rustation repos for cross-reference.
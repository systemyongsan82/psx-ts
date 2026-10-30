# CD-ROM drive controller

Source: nocash PSX-SPX https://problemkaputt.de/psx-spx.htm (§ anchors cited; vendored
copy `docs/raw/psx-spx.htm` with line ranges). **[verbatim]** = copied unmodified.
Disc-specific facts: `docs/re-notes.md` [disc]. Implementation seam: `src/disc/cdrom.ts`.

## 1. I/O registers (1F801800–1F801803, index 0–3)
[verbatim] § CDROM Controller I/O Ports (`#cdromcontrollerioports`), L5078–L5360:
```
1F801800h Index/Status: bit0-1 index (R/W); bit2 ADPBUSY (XA-ADPCM fifo empty=0);
  bit3 PRMEMPT param fifo empty; bit4 PRMWRDY param fifo full; bit5 RSLRRDY response
  fifo empty (0=Empty); bit6 DRQSTS data fifo empty (0=Empty); bit7 BUSYSTS busy (1).
1F801801h W.0 Command Register; R.1 (+ mirrors .0/.2/.3) Response Fifo (16-byte buffer;
  pads with 00h to 16 then restarts; after reading last used byte RSLRRDY clears).
1F801802h W.0 Parameter Fifo (up to 16 bytes); R.0-3 Data Fifo (8- or 16-bit; reads
  800h-byte or 924h-byte sectors; reads past end repeat index [800h-8] resp. [924h-4]).
1F801803h W.0 Request Register: bit5 SMEN want command-start interrupt (INT10h);
  bit7 BFRD want data (1=load data fifo / 0=reset it). bit6 BFWR.
1F801802h W.1 IRQ Enable; 1F801803h R.0 (+R.2 mirror): 0-4 enable (usually 1Fh).
1F801803h R.1/3 Interrupt Flag — Read: bit0-2 low-3bit = INT1..INT7 number (0=none;
  1=INT1 … 7=INT7); bit3 = INT8-related; bit4 = INT10h command-start; bit5-7 read 1.
  Write: bits 0-4 = "1" acknowledges those flags (write 07h to clear response bits or
  1Fh to clear all); acknowledging empties the response fifo and (re)sends a pending
  command; also acts as param-fifo reset etc. (bit6 write = clear parameter fifo).
1F801801h.W.2/802.W.3 + 803.W.2/.W.3: XA audio CD-out→SPU volume mixers (bit5 of .W.3
  apply; see SPU agent).
```
INT meanings `[verbatim]` L5350–L5365:
```
  INT1   Received SECOND (or further) response to ReadS/ReadN (and Play+Report)
  INT2   Received SECOND response (to various commands)
  INT3   Received FIRST response (to any command)
  INT4   DataEnd (when Play/Forward reaches end of disk) (maybe also for Read?)
  INT5   Received error-code (in FIRST or SECOND response)
         INT5 also occurs on SECOND GetID response, on unlicensed disks
         INT5 also occurs when opening the drive door (even if no command was active)
```
Response interrupts queue (INT3 then INT5 are delivered in order, not ORed); upper flags
(INT10h) OR with lower ones. IRQ flag changes aren't synced to the CPU clock (polling
caution, verbatim L5366–L5370). The controller is a separate MCU (16.5KB firmware,
MC68HC05) polling a mainloop "check sectors / check commands / drive maintenance" with no
fixed priority or timing; ~15 slow mainloop cycles/s (§ CDROM Mainloop/Responses —
L6787-L6828, verbatim in structure); only two undelivered per type exist (two delivery
flags; no queue).

## 2. Command table (complete)
[verbatim] § CDROM Controller Command Summary (`#cdromcontrollercommandsummary`), L5369–L5452:
```
  Command          Parameters      Response(s)
  00h -            -               INT5(11h,40h)  ;reportedly "Sync" uh?
  01h Getstat      -               INT3(stat)
  02h Setloc     E amm,ass,asect   INT3(stat)
  03h Play       E (track)         INT3(stat), optional INT1(report bytes)
  04h Forward    E -               INT3(stat), optional INT1(report bytes)
  05h Backward   E -               INT3(stat), optional INT1(report bytes)
  06h ReadN      E -               INT3(stat), INT1(stat), datablock
  07h MotorOn    E -               INT3(stat), INT2(stat)
  08h Stop       E -               INT3(stat), INT2(stat)
  09h Pause      E -               INT3(stat), INT2(stat)
  0Ah Init         -               INT3(late-stat), INT2(stat)
  0Bh Mute       E -               INT3(stat)
  0Ch Demute     E -               INT3(stat)
  0Dh Setfilter  E file,channel    INT3(stat)
  0Eh Setmode      mode            INT3(stat)
  0Fh Getparam     -               INT3(stat,mode,null,file,channel)
  10h GetlocL    E -               INT3(amm,ass,asect,mode,file,channel,sm,ci)
  11h GetlocP    E -               INT3(track,index,mm,ss,sect,amm,ass,asect)
  12h SetSession E session         INT3(stat), INT2(stat)
  13h GetTN      E -               INT3(stat,first,last)  ;BCD
  14h GetTD      E track (BCD)     INT3(stat,mm,ss)       ;BCD
  15h SeekL      E -               INT3(stat), INT2(stat)  ;\use prior Setloc
  16h SeekP      E -               INT3(stat), INT2(stat)  ;/to set target
  17h/18h -      -                 INT5(11h,40h)
  19h Test         sub_function    depends on sub_function
  1Ah GetID      E -               INT3(stat), INT2/5(stat,flg,typ,atip,"SCEx")
  1Bh ReadS      E?-               INT3(stat), INT1(stat), datablock
  1Ch Reset        -               INT3(stat), Delay
  1Dh GetQ       E adr,point       INT3(stat), INT2(10bytesSubQ,peak_lo)
  1Eh ReadTOC      -               INT3(late-stat), INT2(stat)
  1Fh VideoCD      sub,a,b,c,d,e   INT3(stat,a,b,c,d,e)   ;SCPH-5903 only
  50h..57h Secrets / 58h..5Fh Crash / 6Fh..FFh,1Fh..4Fh: INT5(11h,40h)
```
E=Error 80h can appear on commands 02h..09h/0Bh..0Dh/10h..16h/1Ah/1Bh?/1Dh when the disk
is missing (or in some cases when the disk is stopped). Note the brief's "0A?" — real
byte names: 02h=Setloc, 05h=Backward, 07h=MotorOn, 0Eh/Setmode, etc. — there is no "0A?"
gap; the summary above is the complete retail list.
Test command 19h sub-functions `[verbatim rows 00h-25h + 20h relevance]` L5426–L5462:
kernel uses sub 20h "Get cdrom BIOS date/version (yy,mm,dd,ver)"; 00h-03h motor/lens
force; 05h SCEx counters; 21h drive switches; 22h-25h chip/region strings; unsupported
combos return INT5(11h,10h) and do NOT clear the parameter fifo (clear via
[1F801803h.Index1]=40h).

## 3. Status byte (stat) and error codes
[verbatim] § CDROM Status Commands (`#cdromstatuscommands`), L5809–L5850:
```
  7  Play          Playing CD-DA         ;\only ONE of these bits can be set
  6  Seek          Seeking               ; at a time (Read/Play won't get set
  5  Read          Reading data sectors  ;/until after Seek completion)
  4  ShellOpen     Once shell open (0=Closed, 1=Is/was Open)
  3  IdError       (0=Okay, 1=GetID denied) (also set when Setmode.Bit4=1)
  2  SeekError     (0=Okay, 1=Seek error)     (followed by Error Byte)
  1  Spindle Motor (0=Motor off, 1=Motor on)
  0  Error         Invalid Command/parameters (followed by Error Byte)
```
Getstat (01h) resets the shell-open-after-read flag (unique to Getstat). Stat bit0/bit2
suppress the normal response and send INT5 + error byte instead [verbatim]: first-response
errors 10h invalid sub_function/parameter, 20h wrong number of parameters, 40h invalid
command, 80h cannot respond yet (TOC unread / no disk); second-response errors 04h seek
failed; error 08h "drive door became opened" even without a command. Gran-Turismo-style
note: during Seek only bit6 is set; Read follows after seek completes.

## 4. Control / seek / init commands
[verbatim, § CDROM Control Commands L5486–L5660; § CDROM Seek L5680–L5700 condensed]:
- Setfilter 0Dh,file,channel: selects XA-ADPCM file/channel; data-sector delivery is NOT
  affected ("normal 'data' sectors are kept received regardless of Setfilter").
- Setmode 0Eh,mode `[verbatim bit table]`: bit7 Speed (0=normal,1=double), bit6 XA-ADPCM
  (send XA-ADPCM to SPU input), bit5 SectorSize (0=800h data-only, 1=924h whole sector
  minus sync), bit4 Ignore bit (ignores sector size + exact Setloc; stat.bit3 set on
  INT1; purpose unknown), bit3 XA-Filter, bit2 Report (play interrupts), bit1 AutoPause,
  bit0 CDDA (allow CD-DA; ignore missing EDC).
- Init 0Ah: sets mode=20h, activates motor, standby, aborts all commands → INT3 → INT2.
- Reset 1Ch → INT3 → delay 1/8 s (software must wait; no finish INT).
- MotorOn 07h → INT3 → INT2 (fails INT5(stat,20h) if motor already on; Read/Seek/Play
  start the motor automatically anyway).
- Stop 08h → INT3(stat with bit5 cleared) → INT2(stat bit1 cleared); head to track 1 start.
- Pause 09h → INT3(stat, still bit5 during read) → INT2(bit5 cleared); stops read/play,
  keeps spin, keeps position.
- Setloc 02h,amm,ass,asect (minutes/sectors absolute on disk, BCD): stores target only;
  processing happens via SeekL/SeekP/Read/Play. ReadN/ReadS auto-seek to an unprocessed
  Setloc; if reading was paused, Read resumes and re-runs the last received sector once.
- SeekL 15h → INT3 → INT2 (data/header mode; ends at approx N-8..N-0 single-speed,
  N-5..N+2 double-speed). SeekP 16h → INT3 → INT2 (SubQ mode; N-9..N-1 / N-2..N).
- SetSession 12h/session; multi-session notes, errors (skip unless needed; verbatim
  L5730–L5760).

## 5. Read path (ReadN/ReadS), DMA, and timing
[verbatim] § CDROM Read Commands (`#cdromreadcommands`) L5674–L5742:
- ReadN 06h / ReadS 1Bh → INT3(stat), then repeated "INT1(stat) → datablock" until
  Pause. Sequential from the Setloc target. Both read sequentially from Setloc.
- Kernel INT1 handler DMA sequence for ReadN `[verbatim L5696–L5720]`:
```
  [1F801800h]=00h; read [1F801800h]; [1F801803h]=00h; read; [1F801800h]=00h
  [1F801803h]=80h                      ;BFRD=want data
  [1F801018h]=00020943h  ;cdrom_delay  [1F801020h]=0000132Ch ;com_delay
  x=[1F8010F4h] AND 00FFFFFFh          ;DICR → 00840000h
  [1F8010F4h]=x OR 00880000h           ;DMA3 IRQ enable
  [1F8010F0h] |= 00008000h             ;DPCR enable ch3
  [1F8010B0h]=A0010000h ;MADR          [1F8010B4h]=00010200h ;BCR count
  [1F8010B4h]=11000000h ;CHCR DMA go
  then: [1F801800h]=01h; [1F801803h]=40h  ;ack INT1 + reset param fifo
```
- Data-request hand-shake per sector `[verbatim L5736–L5742]`: wait INT1 → set
  Request.BFRD (1F801803h.Index0.bit7=1) → ack INT1 → copy 800h/924h bytes via I/O or
  DMA3; buffer overrun before issuing BFRD silently skips sectors (no overrun flag;
  GetlocL newest-sector trick detects it — GetlocL returns the NEWEST buffered sector,
  INT1 delivers the OLDEST).
- Sector buffer: 32KB IC303, 8 slots, effectively only ~2 usable (oldest + newest/current;
  test data verbatim § Response/Data Queueing L6951–L7050). Process INT1s promptly.
- INT1 rate `[verbatim § Response Timings L6938–L6946]`: single speed avg 006E1CDh cycles
  (00686DA..0072732), double 0036CD2h (00322DF..003AB2B); exact: "SystemClock*930h/4/44100Hz
  for Single Speed (and half as much for Double Speed)" = 33,868,800×2352/4/44100 =
  **451,584 cycles** [arithmetic; matches src/core/contracts.ts CD_SECTOR_CYCLES=451,584].
- 75 sectors/s: the physical constant "sectors 75 sectors per second (00h..74h)" — verbatim
  § CDROM Disk Format L7288-L7292; frame=98×33-byte frames per sector; user area 930h.
- Seek/read latency: first responses are near-immediate (GetStat avg 000C4E1h
  cycles, min 0004A73..max 003115Bh; Init 0013CCEh+) [verbatim § Response Timings
  L6890–L6910]; second responses & seek timings have no exact table — "Unknown",
  coarse/fine seek step behavior noted verbatim L6922–L6936. Second-response averages:
  GetID 0004A00h; Pause ≈5 sectors 0211 81C (1×)/010BD93h (2×); Stop 0D38ACAh(1×)/
  18A6076h(2×) [verbatim table L6914–L6920].

## 6. Which IRQ for Form1 vs Form2 (data delivery rules)
[verbatim] § CDROM Control Commands "Data/ADPCM Sector Filtering/Delivery" L5637–L5657:
```
 try_deliver_as_adpcm_sector:
  reject if CD-DA AUDIO format
  reject if sector isn't MODE2 format
  reject if adpcm_disabled(setmode.6)
  reject if filter_enabled(setmode.3) AND selected file/channel doesn't match
  reject if submode isn't audio+realtime (bit2 and bit6 must be both set)
  deliver: send sector to xa-adpcm decoder
 try_deliver_as_data_sector:
  reject data-delivery if adpcm-delivery happened
  reject if filter_enabled(setmode.3) AND submode is audio+realtime
  1st delivery attempt: send INT1+data, unless there's another INT pending
  2nd attempt (after delay): with file/channel matching if enablefilter
```
So the CPU-facing interrupt is always IRQ2 carrying CD-INT1 (+data) for anything that
isn't delivered to the ADPCM decoder; Form2-ness itself doesn't choose the IRQ — submode
bit2+bit6 (audio+RT) does. During ReadN both Form1 data and non-ADPCM Form2 sectors hit
INT1.

## 7. XA subheader (byte/bit tables) — and the detection fix
[verbatim] § CDROM XA Subheader (`#cdromxasubheaderfilechannelinterleave`), L7835–L7950:
```
Byte0 FN  File Number (00h..FFh)
Byte1 CN  Channel Number (0-4: 00h..1Fh; 5-7 zero; Ace Combat 3 uses FFh=invalid gaps)
Byte2 SM  Submode:
  0   End of Record (EOR) (all Volume Descriptors, and all sectors with EOF)
  1   Video      ;\Sector Type (usually ONE of these bits should be set)
  2   Audio      ; PSX .STR files are declared as Data (not as Video)
  3   Data       ;/VCD videos start with empty sectors, all 3 bits cleared
  4   Trigger    (application use)
  5   Form2      (0=Form1/800h-byte data, 1=Form2, 914h-byte data)
  6   Real Time (RT)
  7   End of File (EOF)
Byte3 CI  Codinginfo: data: 00h. XA-ADPCM: bit0-1 mono/stereo, bit2-2 rate
  (0=37800Hz, 1=18900Hz), bit4-5 bits/sample (0=4bit, 1=8bit), bit6 emphasis, bit7 0.
Normal data-sector subheader usually 00h,00h,08h,00h (sometimes 09h).
```
Form2 encoding `[verbatim]` § CDROM Sector Encoding L7745–L7752: `sector[012h]=sector[012h]
OR 20h ;indicate form2` (and Form1 clears it); Form1 data starts at +018h (2048 bytes + EDC
across [010h..817h] + 114h ECC); Form2 data at +018h length 914h (2324) + EDC across
[010h..92Bh] (optional, may be 00000000h).
**Recommended `src/disc/image.ts` fix**: `mode2-form2 = (raw[offset+18] & 0x20) !== 0`
(and form1 = mode2 && !form2). Current `&0x08` (Data) and `&0x04` (Audio) misclassify:
STR/FMV sectors (submode Data|Form2 = 0x08|0x20) would be counted as form1/2048-byte
sectors, corrupting MDEC input sizing; audio Form2 works only by luck of the Audio bit.
RE's XA streams are Form2+Audio+RT (submode 64h), matching nocash's example `01h,FFh,64h,01h`.
[disc-side verification possible: re-notes says 41,842 Form2 sectors, raw 11430..269517.]

## 8. Sector encoding (formats) `[verbatim]` § CDROM Sector Encoding L7666–L7734
```
Audio:    000h 930h Audio Data (2352 bytes)
Mode0:    000h 0Ch Sync | 00Ch 4 Header (mm,ss,sect,mode=00) | 010h 920h Zerofilled
Mode1:    000h 0Ch Sync | 00Ch 4 (mm,ss,sect,01) | 010h 800h Data | 810h 4 EDC |
          814h 8 zfill | 81Ch 114h ECC
Mode2/F1: 000h 0Ch Sync | 00Ch 4 (mm,ss,sect,02) | 010h 4 Sub-Header (SM AND DFh) |
          014h 4 copy | 018h 800h Data | 818h 4 EDC | 81Ch 114h ECC
Mode2/F2: 000h 0Ch Sync | 00Ch 4 (…) | 010h 4 Sub-Header (SM OR 20h) | 014h copy |
          018h 914h Data (2324) | 92Ch 4 EDC (optional)
Sync = 00 FF FF FF FF FF FF FF FF FF FF 00
MSF encoded BCD: minute=adr/75/60, second=adr/75 mod 60, sector=adr mod 75.
```
(This disc: all sectors Mode2 [disc]; first synced header reads MSF 00:02:00 at file
sector 0 → file sector 0 = LBA 0 after the 2-second pregap convention [disc].)

## 9. GetID and disc identification (RE-relevant)
[verbatim] GetID 1Ah → INT3(stat) → INT2/5(stat,flg,typ,atip,"SCEx"); licensed Mode2
second response = `INT2(02h,00h, 20h,00h, 53h,43h,45h,4xh)` — i.e. SCEA (America/NTSC) for
SLUS-00170. Unlicensed/audio/mode1 variants → INT5; door-open → INT5(11h,80h). SCEx string
displayed by intro; region must match.

## 10. Errors / aborts
Error paths are covered in §3; aborts: Pause (mid-read) and Stop; invalid commands →
INT5 error bytes; disk-missing → 80h-class errors; GetlocL fails INT5(80h) during seek
(or on Audio). Door-open INT5 can arrive with no command active. ReadN on unlicensed
media: read works but data arrives uncorrected (see §5 verbatim note).

## 11. RE disc notes + seams ([disc] docs/re-notes.md)
Single track MODE2/2352; ZNULL.DAT 36 MB sequential reads (HLE fast path
`readIntoRam` in src/disc/cdrom.ts); XA stream extents raw 11430..269517 (41,842 Form2
sectors); harness suspects: "CD IRQ semantics (INT1 vs INT3 ordering)". BIOS-side kernel
functions and their class F0000003h events: see docs/kb/kernel.md §4.
Uncertainties: exact 2nd-response seek latencies (nocash: complicated/unknown); count of
sector-buffer slots (unknown, ~2 usable); XA filtering effect on data delivery after the
1st attempt delay.
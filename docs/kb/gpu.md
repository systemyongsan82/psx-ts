# PlayStation GPU — implementation reference
Source: nocash PSX-SPX (https://problemkaputt.de/psx-spx.htm) — local vendored copy `docs/raw/psx-spx.htm` (line numbers below refer to that file; §anchors are the original HTML ids). Tables quoted **verbatim** (markup stripped, values unaltered). Items marked *(derived)* are arithmetic derived from cited facts; *(KB note)* is KB-only synthesis.

## 1. Ports and DMA [nocash §GPU I/O Ports, L456–527]
```
  Port            Name    Expl.
  1F801810h-Write GP0     Send GP0 Commands/Packets (Rendering and VRAM Access)
  1F801814h-Write GP1     Send GP1 Commands (Display Control) (and DMA Control)
  1F801810h-Read  GPUREAD Receive responses to GP0(C0h) and GP1(10h) commands
  1F801814h-Read  GPUSTAT Receive GPU Status Register
```
- GP0 has a **64-byte (16-word) command FIFO**. GP0 DMA via DMA2; GPUREAD DMA read via DMA2.
- DMA channels (verbatim):
```
  Channel                  Recommended for
  DMA2 in Linked Mode    - Sending rendering commands  ;GP0(20h..7Fh,E1h..E6h)
  DMA2 in Continous Mode - VRAM transfers to/from GPU  ;GP0(A0h,C0h)
  DMA6                   - Initializing the Link List  ;Main RAM
```
- Before DMA2, set the DMA direction via GP1(04h). DMA2 ≡ GP0 port access by software; DMA6 only initializes main RAM (not connected to GPU). [KB note: DMA6=OTC details are in §DMA Channels of the main doc.]

## 2. Command summary [L506–527]
```
  GP0(00h)                 - Nop?
  GP0(01h,02h,80h,A0h,C0h) - Direct VRAM Access
  GP0(03h)                 - Timing Control
  GP0(1Fh)                 - Interrupt Request (IRQ1)
  GP0(20h..3Fh)            - Render Polygons
  GP0(40h..5Fh)            - Render Lines
  GP0(60h..7Fh)            - Render Rectangles
  GP0(E1h..E6h)            - Rendering Attributes
  GP1(00h..09h,10h,20h)    - Display Control (these via GP1 register)
```
GP0 = 8-bit command (MSBs) + 24-bit parameter; parameters appended as further 32-bit words; execution starts when all parameters received (polygon/line: already on 3rd/2nd vertex). Generic render-command decode (top byte of word 1) [§GPU MISC, L1737–1747, verbatim]:
```
  0-23  Color for (first) Vertex                   (Not for Raw-Texture)
  24    Texture Mode      (0=Blended, 1=Raw)       (Textured-Polygon/Rect only)
  25    Semi Transparency (0=Off, 1=On)            (All Render Types)
  26    Texture Mapping   (0=Off, 1=On)            (Polygon/Rectangle only)
  27-28 Rect Size   (0=Var, 1=1x1, 2=8x8, 3=16x16) (Rectangle only)
  27    Num Vertices      (0=Triple, 1=Quad)       (Polygon only)
  27    Num Lines         (0=Single, 1=Poly)       (Line only)
  28    Shading           (0=Flat, 1=Gouroud)      (Polygon/Line only)
  29-31 Primitive Type    (1=Polygon, 2=Line, 3=Rectangle)
```

## 3. Polygons GP0(20h..3Fh) [§GPU Render Polygon Commands, L528–627, verbatim tables]
Mono (20h/22h tri-opaque/ST, 28h/2Ah quad):
```
  1st  Color+Command     (CcBbGgRrh)
  2nd  Vertex1           (YyyyXxxxh)
  3rd  Vertex2           (YyyyXxxxh)
  4th  Vertex3           (YyyyXxxxh)
 (5th) Vertex4           (YyyyXxxxh) (if any)
```
Textured (24h/26h/2Ch/2Eh = blending; 25h/27h/2Dh/2Fh = raw; color ignored for raw):
```
  1st  Color+Command     (CcBbGgRrh) (color is ignored for raw-textures)
  2nd  Vertex1           (YyyyXxxxh)
  3rd  Texcoord1+Palette (ClutYyXxh)
  4th  Vertex2           (YyyyXxxxh)
  5th  Texcoord2+Texpage (PageYyXxh)
  6th  Vertex3           (YyyyXxxxh)
  7th  Texcoord3         (0000YyXxh)
 (8th) Vertex4           (YyyyXxxxh) (if any)
 (9th) Texcoord4         (0000YyXxh) (if any)
```
Shaded mono (30h/32h/38h/3Ah):
```
  1st  Color1+Command    (CcBbGgRrh)
  2nd  Vertex1           (YyyyXxxxh)
  3rd  Color2            (00BbGgRrh)
  4th  Vertex2           (YyyyXxxxh)
  5th  Color3            (00BbGgRrh)
  6th  Vertex3           (YyyyXxxxh)
 (7th) Color4            (00BbGgRrh) (if any)
 (8th) Vertex4           (YyyyXxxxh) (if any)
```
Shaded textured (34h/36h/3Ch/3Eh): interleaved color/vertex/texcoord, 10–12 words as nocash table (Color1,V1,Texcoord1+Palette,Color2,V2,Texcoord2+Texpage,Color3,V3,Texcoord3,[Color4,V4,Texcoord4]).
Nonsense/undocumented (verbatim): GP0(35h,37h,3Dh,3Fh) = same parameters as shaded-textured but unused-shading raw texture (Castlevania uses 3Dh/3Fh); GP0(21h,23h,29h,2Bh,31h,33h,39h,3Bh) ≡ same as 20h/22h/28h/2Ah/30h/32h/38h/3Ah (Vampire Hunter D uses 29h).
Rules (verbatim): polygons render up to <excluding> lower-right vertex coord; quads = two triangles (1,2,3)+(2,3,4); vertex order don't-care at GPU; dither enable (texpage) affects only gouraud or texture-blended polygons.

## 4. Lines GP0(40h..5Fh) [L628–675, verbatim]
Mono 40h/42h (opaque/ST) and 48h/4Ah mono poly-line; shaded 50h/52h, 58h/5Ah poly-line. Words: Color+Command, Vertex1, [Color2, Vertex2...] [VertexN...] [Termination `55555555h` (poly only)]. Lines render up to <including> lower-right (unlike polygons). Wild Arms 2 uses 50005000h as terminator (unclear bits). Dithering applies to lines regardless of mono/shaded.

## 5. Rectangles GP0(60h..7Fh) [L676–769, verbatim]
Mono: 60h/62h variable (+3rd word Size `YsizXsizh` max 1023x511), 68h/6Ah 1x1 dot, 70h/72h 8x8, 78h/7Ah 16x16. Textured: 64h–67h variable, 6Ch–6Fh 1x1 "(nonsense)", 74h–77h 8x8, 7Ch–7Fh 16x16:
```
  1st  Color+Command     (CcBbGgRrh) (color is ignored for raw-textures)
  2nd  Vertex            (YyyyXxxxh) (upper-left edge of the rectangle)
  3rd  Texcoord+Palette  (ClutYyXxh) (see bug on odd/even Texcoord.X values)
 (4th) Width+Height      (YsizXsizh) (variable size only) (max 1023x511)
```
- No gouraud; no dither; no rotation/scaling; drawn as one unit.
- For rects the Texpage comes from GP0(E1h) (not from a packet word); texture window size 256x256 — larger sizes repeat the source.
- Odd/Even Texcoord.X bug verbatim:
```
  if 15bpp then tex_error_mask=3, else tex_error_mask=7       ;4bpp/8bpp/15bpp
  if (tex.x AND tex_error_mask)=0 then
    tex.x=(tex.x-1)                                           ;1st error
    tex.x=(tex.x AND texwindow.mask) OR texwindow.offset      ;window
    if 4bpp AND (tex.x AND 8)=0 then tex.x=(tex.x+1) AND FFh  ;2nd error
  else    ;no error...
    tex.x=(tex.x AND texwindow.mask) OR texwindow.offset      ;window
```
Doesn't occur with X-Flip; X-Flip ignores LSB of Texcoord.X and forcedly starts at odd values. X/Y-flip bits = Texpage bits 12/13, affect rectangles only; unsupported on old 160-pin GPUs.
[KB note: two VRAM-transfer commands mimic GP0(60h)/65h ("GP0(D0)"/"GP0(D3)" per other docs) — nocash describes them here; they don't clip to Drawing Area, don't support transparency, don't convert depth.]

## 6. Rendering attributes [L770–919, verbatim fields]
Vertex (polygon/line/rect parameter 1st..Nth where color words absent):
```
  0-10   X-coordinate (signed, -1024..+1023)
  11-15  Not used (usually sign-extension, but ignored by hardware)
  16-26  Y-coordinate (signed, -1024..+1023)
  26-31  Not used (usually sign-extension, but ignored by hardware)
```
Max distance between two vertices: 1023 horiz / 511 vert — exceeding prim is NOT rendered. Outside-drawing-area portions still render their inside part.
Color: bits 0-7 R, 8-15 G, 16-23 B, 24-31 command-id (first word). Untextured FFh = brightest; texture blending 80h = brightest (81h..FFh "brighter than bright", output clamped 1Fh).
Texpage attribute (in textured polygons; bit map = same rows as GP0(E1h).0-8/.11; bits 9-10 & 12-13 do NOT change E1h):
```
  0-8    Same as GP0(E1h).Bit0-8 (see there)
  9-10   Unused (does NOT change GP0(E1h).Bit9-10)
  11     Same as GP0(E1h).Bit11  (see there)
  12-13  Unused (does NOT change GP0(E1h).Bit12-13)
  14-15  Unused (should be 0)
```
CLUT attribute (4/8bpp only):
```
  0-5      CLUT X coordinate bit4-9  (in 16-halfword steps)
  6-14     CLUT Y coordinate bit0-8  (in 1-line steps)
  15       CLUT Y coordinate bit9    (0=Normal, 1=Upper Mbyte, Open Bus)
```
*(derived)* CLUT position: X_VRAM = attr[0-5]<<4; Y_VRAM = attr[6-14] | (attr[15]<<9); halfword address = Y_VRAM*1024 + X_VRAM (1024 halfwords per VRAM line, from the 1024×512 VRAM shape in §VRAM). Texture-page *(derived)*: base X = pageattr[0-3]<<6 (64-hw steps), Y = pageattr[4]<<8 | pageattr[11]<<9.

### GP0(E1h) Draw Mode ("Texpage") [verbatim]
```
  0-3   Texture page X.bit6-9 (N*64) (ie. in 64-halfword steps)    ;GPUSTAT.0-3
  4     Texture page Y.bit8   (N*256) (ie. 0 or 256)               ;GPUSTAT.4
  5-6   Semi Transparency     (0=B/2+F/2, 1=B+F, 2=B-F, 3=B+F/4)   ;GPUSTAT.5-6
  7-8   Texture page colors   (0=4bit, 1=8bit, 2=15bit, 3=Reserved);GPUSTAT.7-8
  9     Dither 24bit to 15bit (0=Off/strip LSBs, 1=Dither Enabled) ;GPUSTAT.9
  10    Interlace Drawing     (0=All Lines, 1=Inactive Lines)      ;GPUSTAT.10
  11    Texture page Y.bit9   (0=Normal, 1=Upper Mbyte, Open Bus)  ;GPUSTAT.15
  12    Textured Rectangle X-Flip   (BIOS does set this bit on power-up...?)
  13    Textured Rectangle Y-Flip   (BIOS does set it equal to GPUSTAT.13...?)
  14-23 Not used (should be 0)
  24-31 Command  (E1h)
```
Texture page colors 3 = same as 15bit. E1h required only for lines, rects, untextured polys (but bits 9-10/12-13 changeable only via E1h). Games insert GP0(00h) between Texpage and Rect (NOP?, timing).

### GP0(E2h) Texture Window [verbatim + formula]
```
  0-4    Texture window Mask X   (in 8 pixel steps)
  5-9    Texture window Mask Y   (in 8 pixel steps)
  10-14  Texture window Offset X (in 8 pixel steps)
  15-19  Texture window Offset Y (in 8 pixel steps)
  20-23  Not used (zero)
  24-31 Command  (E2h)
```
`Texcoord = (Texcoord AND (NOT (Mask*8))) OR ((Offset AND Mask)*8)` — window repeats through the texture page.

### GP0(E3h/E4h) Drawing area top-left / bottom-right [verbatim]
```
  0-9    X-coordinate (0..1023)
  10-18  Y-coordinate (0..511)   ;\on Old 160pin GPU (max 1MB VRAM)
  19-23  Not used (zero)         ;/
  10-19  Y-coordinate (0..1023)  ;\on New 208pin GPU (max 2MB VRAM)
  20-23  Not used (zero)         ;/(retail consoles have only 1MB though)
  24-31  Command  (Exh)
```
GP0(20h..7Fh) clip to this region automatically.

### GP0(E5h) Drawing Offset [verbatim]
```
  0-10   X-offset (-1024..+1023) (usually within X1,X2 of Drawing Area)
  11-21  Y-offset (-1024..+1023) (usually within Y1,Y2 of Drawing Area)
  22-23  Not used (zero)
  24-31  Command  (E5h)
```
If GTE emits coordinate 0,0 = center of drawing area → offset = X1+(X2-X1)/2, Y1+(Y2-Y1)/2; if 0,0 = upper-left of area → offset = X1,Y1. The signed 11-bit offset is added to the signed 11-bit vertex and the sum truncated to signed 11-bit. E3/E4/E5 do not occupy FIFO space (execute immediately) — best set only when FIFO empty (else they may hit older queued commands).

### GP0(E6h) Mask bit setting [verbatim]
```
  0     Set mask while drawing (0=TextureBit15, 1=ForceBit15=1)   ;GPUSTAT.11
  1     Check mask before draw (0=Draw Always, 1=Draw if Bit15=0) ;GPUSTAT.12
  2-23  Not used (zero)
  24-31 Command  (E6h)
```
Bit0 off: written pixel's bit15 = texture bit15 (ST-marked colors) — for untextured polys bit15=0. Bit1 on: old framebuffer pixels with bit15=1 are write-protected for rendering commands AND CPU-to-VRAM/VRAM-to-VRAM transfers (per 16-bit halfword) — Fill excluded. *(derived note for parent's "0x2000" question: the two mask flags live in GPUSTAT bit11/bit12 = 0x0800/0x1000; nocash gives no 0x2000 mask semantics — 0x2000 is GPUSTAT bit13 = Interlace Field, see §9.)*

## 7. VRAM transfers [L920–1023, verbatim]
```
GP0(01h) Clear Cache:           1 word (Cc000000h). Discards CLUT+Texture cache (needed after overwriting VRAM / CLUT upload / rendering into texture memory).
GP0(02h) Fill Rectangle in VRAM:
  1st  Color+Command     (CcBbGgRrh)  ;24bit RGB value (see note)
  2nd  Top Left Corner   (YyyyXxxxh)  ;Xpos counted in halfwords, steps of 10h
  3rd  Width+Height      (YsizXsizh)  ;Xsiz counted in halfwords, steps of 10h
  (24bit color auto-converted to 15bit RGB, bit15=0; no write-mask effect)
GP0(80h) Copy VRAM→VRAM:        cmd + src + dst + size, Xpos in halfwords
GP0(A0h) Copy CPU→VRAM:         cmd + dst + size then N halfwords (odd count: send an extra halfword, 32-bit packets)
GP0(C0h) Copy VRAM→CPU:         cmd + src + size (write to GP0), then data from GPUREAD (or DMA):
  "Wait for bit27 of the status register to be set before reading the image data.
   When the number of halfwords is odd, an extra halfword is read at the end (packets consist of 32bit units)."
```
FILL masking/rounding (verbatim — this is the "+1"/saturation semantics for fill):
```
  Xpos=(Xpos AND 3F0h)                       ;range 0..3F0h, in steps of 10h
  Ypos=(Ypos AND 1FFh)                       ;range 0..1FFh
  Xsiz=((Xsiz AND 3FFh)+0Fh) AND (NOT 0Fh)   ;range 0..400h, in steps of 10h
  Ysiz=((Ysiz AND 1FFh))                     ;range 0..1FFh
  Fill does NOT occur when Xsiz=0 or Ysiz=0; Xsiz=400h only via param 3F1h..3FFh rounded up (param 400h handled as 0).
```
COPY masking (verbatim — "+1" width/height semantics):
```
  Xpos=(Xpos AND 3FFh)                       ;range 0..3FFh
  Ypos=(Ypos AND 1FFh)                       ;range 0..1FFh
  Xsiz=((Xsiz-1) AND 3FFh)+1                 ;range 1..400h
  Ysiz=((Ysiz-1) AND 1FFh)+1                 ;range 1..200h
```
Notes (verbatim): COPY clears Texture Cache (not CLUT cache); FILL clears none. Transfer coords are absolute VRAM addresses (no draw-offset, no draw-area). Continuous GPU-DMA transfers work only during V-Blank (outside, data skipped/misaddressed); linked-list DMA works anytime. Copy/Fill wrap modulo 1024×512 (no carry between X/Y). VRAM→VRAM copies move 128 halfwords source→temp→dest (partial widths allowed).

## 8. GPU display control (GP1) [L1087–1344, verbatim]
GP1 sends word to 1F801814h; direct (works even when FIFO full).
- **GP1(00h) Reset GPU** → executes 01..08 and resets GP0(E1h..E6h) attrs; GPUSTAT becomes **14802000h**; x1/y1 too small on purpose; GP0(03h) and GP1(09h) unaffected.
- **GP1(01h)** Reset Command Buffer (clear FIFO, abort current command).
- **GP1(02h)** Acknowledge IRQ1 (GPUSTAT.24).
- **GP1(03h) Display Enable**: bit0 0=On, 1=Off(black) ;GPUSTAT.23. Still fetches VRAM pixels & sends SYNC (no speedup; use GP1(07h) shrink for that).
```
GP1(04h) DMA Direction: bit1-0 → GPUSTAT.29-30
  0 = Off (bit25 is always 0=No DRQ)
  1 = To GPU, drq when FIFO at least galf empty
  2 = To GPU, drq when FIFO empty                  ;Same as GPUSTAT.28
  3 = From GPU                                     ;Same as GPUSTAT.27
GP1(05h) Start of Display area (in VRAM):
  0-9   X (0-1023)    (halfword address in VRAM)  (relative to begin of VRAM)
  10-18 Y (0-511)     (scanline number in VRAM)   (relative to begin of VRAM)
GP1(06h) Horizontal Display range (on Screen):
  0-11   X1 (260h+0)       ;12bit       ;\counted in 53.222400MHz units,
  12-23  X2 (260h+320*8)   ;12bit       ;/relative to HSYNC
  width shown = ("(((X2-X1)/cycles_per_pix)+2) AND NOT 3")
GP1(07h) Vertical Display range (on Screen):
  0-9   Y1 (NTSC=88h-(224/2), (PAL=A3h-(264/2))  ;\scanline numbers on screen,
  10-19 Y2 (NTSC=88h+(224/2), (PAL=A3h+(264/2))  ;/relative to VSYNC
  If Y2 > 106h (NTSC) or 139h (PAL): vblank IRQ0 stops. Height must be >0.
GP1(08h) Display mode:
  0-1   Horizontal Resolution 1     (0=256, 1=320, 2=512, 3=640) ;GPUSTAT.17-18
  2     Vertical Resolution         (0=240, 1=480, when Bit5=1)  ;GPUSTAT.19
  3     Video Mode                  (0=NTSC/60Hz, 1=PAL/50Hz)    ;GPUSTAT.20
  4     Display Area Color Depth    (0=15bit, 1=24bit)           ;GPUSTAT.21
  5     Vertical Interlace          (0=Off, 1=On)                ;GPUSTAT.22
  6     Horizontal Resolution 2     (0=256/320/512/640, 1=368)   ;GPUSTAT.16
  7     "Reverseflag"               (0=Normal, 1=Distorted)      ;GPUSTAT.14
```
Display Area Color Depth does NOT change the Drawing Area (always 15bit). GP1(09h) = VRAM size 1M/2M (2M unused on retail); GP1(20h) prototype VRAM size; GP1(0Bh) unknown-internal; GP1(0Ah,0Ch..0Fh,21h..3Fh) N/A; GP1(40h..FFh) mirrors.
GP1(10h) Get GPU Info (result latched in GPUREAD immediately; do NOT wait GPUSTAT.27 for info reads): 02h texture window, 03h draw area TL, 04h draw area BR, 05h draw offset (19/20bit fields old/new GPUs), 07h GPU type (new GPU).

## 9. GPUSTAT (1F801814h read) [L1345–1419, verbatim] — full table with 25 DRQ semantics as in §8; key bits: 0-9/E1-mirror, 11/12 mask, 13 Interlace Field (always 1 when not interlaced), 14 Reverseflag, 15 texpage Y.b9, 16-22 mode/state, 23 display off, 24 IRQ1, 25 DRQ (GP1(04h)-dependent, =bit28 when dir=2, =bit27 when dir=3), 26 ready-for-command, 27 read-data available (GP0(C0h)), 28 write-FIFO empty, 29-30 DMA direction, 31 interlace line parity (always 0 during Vblank). Corner case (verbatim): Bit28 is cleared immediately after the command word for polygon/line commands (before vertices) — DMA based on bit28 must start on command words (parameters in a separate DMA block would likely hang).

## 10. VRAM formats [§GPU Video Memory, L1627–1735, verbatim]
Framebuffer sizes (KB @16/24bit): 256x240 120/180, 320x240 150/225, 368x240 (nocash lists "xx0"), 512x240 240/360, 640x240 300/450; double in 480-line modes.
```
15bit Direct Display (default)      | 24bit Direct Display:
  0-4   Red       (0..31)           |  0-7  Red
  5-9   Green     (0..31)           |  8-15 Green
  10-14 Blue      (0..31)           |  16-23 Blue
  15    Mask flag (0=Normal,         (24bit pixels use 3 bytes; only via
         1=Do not allow to overwrite) VRAM transfers; GP0(20h..7Fh) always 15bit)
```
Texture formats:
```
  16bit Texture (Direct Color)             ;(One 256x256 page = 128Kbytes)
  0-4 Red, 5-9 Green, 10-14 Blue, 15 Semi Transparency Flag
   Color 0000h = Fully-Transparent; 0001h..7FFFh = Non-Transparent;
   8000h..FFFFh = Semi-Transparent (*) — (*) or Non-Transparent on opaque commands
  8bit Texture: two pixels per halfword — first pixel = bits0-7 (left), second = bits8-15 (right); one page = 64KB
  4bit Texture: four pixels per halfword — bits0-3 left … bits12-15 right; one page = 32KB
```
Texture pages: 256×256 texel; X in multiples of 64 halfwords, Y in multiples of 256 lines. CLUT = 256×1 (8bpp) or 16×1 (4bpp) image; X multiples of 16 halfwords, Y 0..511. Black limitation: texture color 0000h = transparent (can't render textured black); 8000h = Non-Transparent black on opaque commands, Semi-Transparent black on ST commands. PSX 5-bit ramp is not linear to PC RGB (mid ≈8 vs 16).

## 11. Display timing basics [§GPU Display Timings, L2026–2090, verbatim]
```
  CPU Clock   =  33.868800MHz (44100Hz*300h)
  Video Clock =  53.222400MHz (44100Hz*300h*11/7)
  PAL:  314 scanlines per frame (13Ah)
  NTSC: 263 scanlines per frame (107h)
  PAL:  3406 video cycles per scanline     NTSC: 3413 video cycles per scanline
  Dotclocks: 256-pix 5.322240MHz, 320-pix 6.652800MHz, 368-pix 7.603200MHz,
             512-pix 10.644480MHz, 640-pix 13.305600MHz
  Frame Rates: PAL ca. 49.76Hz; NTSC ca. 59.29Hz
```
*(KB note answering the parent's "262?" question: nocash says a full NTSC frame = **263 scanlines (107h)** including hidden/blanking lines; games typically display 224–240 of them via GP1(07h). Values ≈262 float around other docs; the citable nocash number is 263.)*

## Sources
- [PSX-SPX — Graphics Processing Unit (GPU)](https://problemkaputt.de/psx-spx.htm#graphicsprocessingunitgpu) — **Credibility:** the canonical public hardware spec (nocash), vendored locally for byte-identical citation; **Relevance:** every table above; **Sufficiency:** complete for GP0/GP1/GPUSTAT/VRAM/timing; rendering-pipeline internals (FIFO, texture caching, render/refresh timing) intentionally out of scope (§gpufifo, §gputexturecaching, §gpurenderingtimings, L1852–2281).

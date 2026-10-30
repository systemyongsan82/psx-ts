# PlayStation MDEC — implementation reference
Source: nocash PSX-SPX (local `docs/raw/psx-spx.htm`); STR/BS parts from §CDROM File sections (anchors/lines per section). Tables **verbatim**.

## 1. Registers and DMA [§MDEC I/O Ports L3125–3196, verbatim]
```
  1F801820h - MDEC0 - MDEC Command/Parameter Register (W): 31-0 Command or Parameters
  1F801820h.Read - MDEC Data/Response Register (R): 31-0 Macroblock Data (garbage if none)
  1F801824h - MDEC1 - MDEC Status Register (R):
   31    Data-Out Fifo Empty (0=No, 1=Empty)
   30    Data-In Fifo Full   (0=No, 1=Full, or Last word received)
   29    Command Busy  (0=Ready, 1=Busy receiving or processing parameters)
   28    Data-In Request  (set when DMA0 enabled and ready to receive data)
   27    Data-Out Request (set when DMA1 enabled and ready to send data)
   26-25 Data Output Depth  (0=4bit, 1=8bit, 2=24bit, 3=15bit)      ;CMD.28-27
   24    Data Output Signed (0=Unsigned, 1=Signed)                  ;CMD.26
   23    Data Output Bit15  (0=Clear, 1=Set) (for 15bit depth only) ;CMD.25
   22-19 Not used (seems to be always zero)
   18-16 Current Block (0..3=Y1..Y4, 4=Cr, 5=Cb) (or for mono: always 4=Y)
   15-0  Number of Parameter Words remaining minus 1  (FFFFh=None)  ;CMD.Bit0-15
  1F801824h - MDEC1 - MDEC Control/Reset Register (W):
   31    Reset MDEC (1=Abort any command, and set status=80040000h)
   30    Enable Data-In Request  (DMA0 / Status.28)
   29    Enable Data-Out Request (DMA1 / Status.27)
```
Colored 16x16 macroblock data comes out as 8x8 blocks; DMA1 reorders automatically (STAT current-block bits tell it how); mono 8x8 needs no reordering. Data transfers: "DMA1 and DMA0 should be usually used with a blocksize of 20h words" (pad parameters with FE00h halfwords to the 80h-halfword block boundary). Full movie chain (verbatim): DMA3 CDROM→RAM, CPU Huffman→16bit RLE, DMA0 RAM→MDEC, DMA1 MDEC→RAM, DMA2 RAM→GPU.

## 2. Commands [verbatim]
```
MDEC(1) Decode Macroblock(s)   (=word 2xxxxxxx):
  31-29 Command (1=decode_macroblock); 28-27 Data Output Depth (0=4bit,1=8bit,2=24bit,3=15bit) ;STAT.26-25
  26 Data Output Signed (0=Unsigned,1=Signed) ;STAT.24 ; 25 Data Output Bit15 (0=Clear,1=Set, 15bit only) ;STAT.23
  24-16 Not used (should be zero); 15-0 Number of Parameter Words (size of compressed data)
MDEC(2) Set Quant Table(s)     (=word 4xxxxxxx):
  31-29 Command (2=set_iqtab); 28-1 zero; 0 Color (0=Luminance only, 1=Luminance and Color)
  followed by 64 unsigned bytes luminance quant table (Y1..Y4), then (bit0=1) 64 bytes color table (Cr,Cb)
MDEC(3) Set Scale Table        (=word 6xxxxxxx):
  31-29 Command (3=set_scale); 28-0 zero; followed by 64 signed halfwords, 14bit fractional part
MDEC(0) No function  (=word 8xxxxxxx; bits25-28 mirrored to STAT.23-26, bits0-15 to STAT.0-15)
MDEC(4..7) Invalid — act as MDEC(0)
```
*(KB note answering the parent's "0x40000000 / 0x60000000": yes — 0x40000000 = MDEC(2) set quant tables (bit0 = also chroma, so 0x40000001 = both tables), 0x60000000 = MDEC(3) set scale table.)*

## 3. Decompression pipeline [§MDEC Decompression L3244–3469, verbatim]
```
  decode_colored_macroblock: rl_decode_block(Crblk,src,iq_uv); rl_decode_block(Cbblk,src,iq_uv);
    rl_decode_block(Yblk,src,iq_y), yuv_to_rgb(0,0); yuv_to_rgb(0,8); yuv_to_rgb(8,0); yuv_to_rgb(8,8)
  decode_monochrome_macroblock: rl_decode_block(Yblk,src,iq_y), y_to_mono
```
```
  rl_decode_block(blk,src,qt):
    for i=0 to 63, blk[i]=0
    @@skip: n=[src], src=src+2, k=0
      if n=FE00h then @@skip              ;ignore padding
      q_scale=(n SHR 10) AND 3Fh          ;first halfword: scale + first value
      val=signed10bit(n AND 3FFh)*qt[k]
    @@lop:
      if q_scale=0 then val=signed10bit(n AND 3FFh)*2   ;no-quant special mode
      val=minmax(val,-400h,+3FFh)         ;signed 11bit clamp
      val=val*scalezag[i]                 ;for "fast_idct_core" only
      if q_scale>0 then blk[zagzig[k]]=val       ;with zigzag reordering
      if q_scale=0 then blk[k]=val               ;no zigzag
      n=[src], src=src+2
      k=k+((n SHR 10) AND 3Fh)+1
      val=(signed10bit(n AND 3FFh)*qt[k]*q_scale+4)/8   ;dequant+rounding
      if k<=63 then jump @@lop            ;ends at n=FE00h (sets k>63)
    idct_core(blk)
```
Wait — nocash's loop saturates before scalezag and applies scalezag at the dequant point; transcribe both lines as printed (the fast-IDCT premultiplication detail). *(KB note: nocash's pseudocode has the val=minmax/scalezag ordering as shown; if you drop the fast-IDCT, the minmax+dequant still stands — nocash notes the saturation/rounding "aren't actually required" for a very-fast decoder.)*
**fast_idct_core** (verbatim 80-multiply algorithm, valid for the standard scale table): two passes (rows/cols), with `z12=(1.414213562*z12)-z13`, `z5=(1.847759065*(z12-z10))`, `tmp6=(2.613125930*(z10))+z5-tmp7`, `tmp5=(1.414213562*(z11-z13))-tmp6`, `tmp4=(1.082392200*(z12))-z5+tmp5` then butterfly outputs — full text at L3280–3310 (transcribed in the local file; quick path: 8-row row pass, swap(src,dst), column pass; "dst[i*8+0]=tmp0+tmp7, dst[i*8+7]=tmp0-tmp7, dst[i*8+1]=tmp1+tmp6, dst[i*8+6]=tmp1-tmp6, dst[i*8+2]=tmp2+tmp5, dst[i*8+5]=tmp2-tmp5, dst[i*8+4]=tmp3+tmp4, dst[i*8+3]=tmp3-tmp4").
**real_idct_core** (verbatim): 1024 multiplies, column-wise two passes; `dst[x+y*8]=(sum+0fffh)/2000h` per output (round-half-up intent; hardware "appears to be working roughly like that", results not perfect — possible extra fraction-strips per pass; nocash flags this as unverified detail).

## 4. Tables [verbatim]
scalefactor: `1.000000000, 1.387039845, 1.306562965, 1.175875602, 1.000000000, 0.785694958, 0.541196100, 0.275899379` (= cos((0..7)*90°/8), ×sqrt(2)/8? — as printed: "for [1..7]: multiplied by sqrt(2)").
`zigzag[0..63]`: `0,1,5,6,14,15,27,28, 2,4,7,13,16,26,29,42, 3,8,12,17,25,30,41,43, 9,11,18,24,31,40,44,53, 10,19,23,32,39,45,52,54, 20,22,33,38,46,51,55,60, 21,34,37,47,50,56,59,61, 35,36,48,49,57,58,62,63`; `zagzig` = inverse; `scalezag[zigzag[x+y*8]] = scalefactor[x]*scalefactor[y]/8`.
Default quant table (applies to luminance AND is shipped identical for most movies; X-Files/Eagle One "fraquant" use fixed-point multiples):
```
  02h,10h,10h,13h,10h,13h,16h,16h
  16h,16h,16h,16h,1Ah,18h,1Ah,1Bh
  1Bh,1Bh,1Ah,1Ah,1Ah,1Ah,1Bh,1Bh
  1Bh,1Dh,1Dh,1Dh,22h,22h,22h,1Dh
  1Dh,1Dh,1Bh,1Bh,1Dh,1Dh,20h,20h
  22h,22h,25h,26h,25h,23h,23h,22h
  23h,26h,26h,28h,28h,28h,30h,30h
  2Eh,2Eh,38h,38h,3Ah,45h,45h,53h
```
IDCT scale matrix (MDEC(3), 16-bit values, hardware uses upper 13 bits; = scalefactors×sqrt(2)×4000h; s0..s7 pattern table as in source):
```
  5A82 5A82 5A82 5A82 5A82 5A82 5A82 5A82
  7D8A 6A6D 471C 18F8 E707 B8E3 9592 8275
  7641 30FB CF04 89BE 89BE CF04 30FB 7641
  6A6D E707 8275 B8E3 471C 7D8A 18F8 9592
  5A82 A57D A57D 5A82 5A82 A57D A57D 5A82
  471C 8275 18F8 6A6D 9592 E707 7D8A B8E3
  30FB 89BE 7641 CF04 CF04 7641 89BE 30FB
  18F8 B8E3 6A6D 8275 7D8A 9592 471C E707
```

## 5. Color conversion [verbatim]
```
  yuv_to_rgb(xx,yy):
    for y,x: R=[Crblk+((x+xx)/2)+((y+yy)/2)*8], B=[Cbblk+...]; G=(-0.3437*B)+(-0.7143*R); R=1.402*R; B=1.772*B
      Y=[Yblk+x+y*8]; R/G/B = MinMax(-128,127, Y + comp); if unsigned then BGR = BGR xor 808080h
      dst[(x+xx)+(y+yy)*16] = BGR
  y_to_mono: Y=Y AND 1FFh (clip signed 9bit); Y=MinMax(-128,127,Y); if unsigned then Y=Y xor 80h
```
Exact fixed-point resolution of yuv_to_rgb unknown (nocash); possible 9-bit limit as in y_to_mono. Unsigned mode = add 128 to each channel (equivalent to the famous "no subtract in YUV" RGB15/RGB24 path). Output width select: 15bit vs 24bit via MDEC(1).28-27 ("2=24bit, 3=15bit").

## 6. Data format [§MDEC Data Format L3470–3577, verbatim essentials]
Colored macroblock = Cr(8×8, half-res) + Cb(8×8) + Y1..Y4 → RGB 16×16; vertical strip arrangement typical on disc (16×240 streams). Monochrome = Y 8×8 (no RGB conversion). RLE block storage: `DCT(1 halfword) + RLE... + EOB(FE00h)`:
```
  DCT: 15-10 Q (quantization factor, 6bit unsigned, feeds DCT.bit10-15) ; 9-0 DC (10bit signed)
  RLE: 15-10 LEN (skip zero-AC count); 9-0 AC (10bit signed)   ; example: "000h,000h,123h" → "(2 shl 10)+123h"
  EOB: FE00h fixed end code (optional when block fully defined)
  Dummy halfwords: FE00h ignored at block start / after EOB elsewhere; needed to pad word (and 32-word DMA) boundaries
```

## 7. STR video sectors + frame headers [§STR Sectors L11386–11452; §BS Headers L12877–13060, verbatim]
```
  000h 2    StStatus (0160h) (RV6Rh; R=Reserved=0, V=Version=1, 6=Fixed ID)
  002h 2    StType (0000h..7FFFh=User Defined, 8000h..FFFFh=System; 8001h=MDEC)
  004h 2    StSectorOffset (Sector number in the frame, 0=First)
  006h 2    StSectorSize   (Number of sectors in the frame) (eg. 4 or 5)
  008h 4    StFrameNo      (Frame number, 1=First) (except Viewpoint=0)
  00Ch 4    StFrameSize    (in bytes, in this frame, excluding headers/padding)
  ...StType=8001h (with StStatus=0160h): 010h 2 StMovieWidth (eg. 0140h) ; 012h 2 StMovieHeight (eg. 00F0h) ;
    014h 4 StHeadM (reserved for system) (eg. 38000720h) ; 018h 4 StHeadV (eg. 00020001h) ; both = copies of the
    first STR sector's BS fileheader at 020h..027h ; 01Ch 4 Unspecified ; 020h 7E0h Data (BS format) or padding
```
BS v1/v2/v3 file header (at 020h of the first frame sector): `000h 2 MDEC Size/4 (after huffman decompression, rounded to 80h/4 bytes); 002h 2 File ID (3800h); 004h 2 Quantization step/factor (0000h..003Fh, for MDEC "DCT.bit10-15"); 006h 2 Version (1,2,3; 2 most common); 008h.. Huffman compressed blocks (Cr,Cb,Y1,Y2,Y3,Y4, ...)`. *(KB note re parent's "magic 0x0009380?": nocash has no such magic — the ID halfword is **3800h** and MDEC Size/4 sits at BS-header offset 0; the "9380"-looking value is likely a mis-remembered `38000720h` StHeadM.)* Frame rate: implied by CDROM speed — "Sony: BS 320x240 can be 30fps at double speed"; general rule = 150 or 75 sectors/s minus audio sectors ÷ sectors-per-frame; variable-rate needs Vblank pacing. Width/height usually multiples of 16 (exceptions tabulated in nocash L11420–11437; decode buffer round up to 16 and crop).

## Sources
- [PSX-SPX — Macroblock Decoder (MDEC)](https://problemkaputt.de/psx-spx.htm#macroblockdecodermdec), [§CDROM File Video Streaming STR](https://problemkaputt.de/psx-spx.htm#cdromfilevideostreamingstrsony), [§BS Compression Headers](https://problemkaputt.de/psx-spx.htm#cdromfilevideobscompressionheaders), [§DMA Channels](https://problemkaputt.de/psx-spx.htm#dmachannels) — **Credibility:** canonical spec, vendored; **Relevance:** complete command/control/IDCT/color/streaming reference; **Sufficiency:** complete for RE intro FMVs; STR variants (interleaved/BS/encrypted movies) and WAC streams referenced but not transcribed (L11453–13494).

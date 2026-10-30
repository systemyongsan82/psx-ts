# PlayStation GTE (COP2) — implementation reference
Source: nocash PSX-SPX (local copy `docs/raw/psx-spx.htm`; anchors and line refs below). Tables **verbatim** (markup decoded: `&lt;`→`<` etc.). No hardware test vectors exist in nocash — see the hand-computed example, clearly labeled.

## 1. Access path and routing [§GTE Overview L2373–2457; §CPU Coprocessor Opcodes L39209–39251]
```
  mov  cop0r12,rt          ;-enable/disable COP2 (GTE) via COP0 status register
  mov  cop2r0-63,rt        ;\write parameters to GTE registers
  mov  cop2r0-31,[rs+imm]  ;/
  mov  cop2cmd,imm25       ;-issue GTE command
  mov  rt,cop2r0-63        ;\read results from GTE registers
  mov  [rs+imm],cop2r0-31  ;/
  jt   cop2flg,dest        ;-jump never  ;\implemented (no exception), but,
  jf   cop2flg,dest        ;-jump always ;/flag seems to be always "false"
```
Primary opcode field (verbatim [§CPU Opcode Encoding L38892–39202]):
```
  12h=COP2   32h=LWC2   3Ah=SWC2
```
Coprocessor opcode encoding (verbatim) — this is the rs-field verification the CPU agent needs:
```
  31..26 |25..21|20..16|15..11|10..6 |  5..0  |
  0100nn |0|0000| rt   | rd   | N/A  | 000000 | MFCn rt,rd_dat  ;rt = dat
  0100nn |0|0010| rt   | rd   | N/A  | 000000 | CFCn rt,rd_cnt  ;rt = cnt
  0100nn |0|0100| rt   | rd   | N/A  | 000000 | MTCn rt,rd_dat  ;dat = rt
  0100nn |0|0110| rt   | rd   | N/A  | 000000 | CTCn rt,rd_cnt  ;cnt = rt
  0100nn |0|1000|00000 | <-immediate16bit--> | BCnF target ;jump if false
  0100nn |0|1000|00001 | <-immediate16bit--> | BCnT target ;jump if true
  0100nn |1| <------immediate25bit--------> | COPn imm25
  1100nn | rs   | rt   | <-immediate16bit--> | LWCn rt_dat,[rs+imm]
  1110nn | rs   | rt   | <-immediate16bit--> | SWCn rt_dat,[rs+imm]
```
For COP2 (nn=2, primary=0x22): **rs field** = bits25-21's low 5 = 0000 MFC2 / 0010 CFC2 / 0100 MTC2 / 0110 CTC2; `rd` (bits 15-11) selects the GTE register: rd 0-31 → data registers cop2r0-31 (MFC2/MTC2), rd 0-31 → control registers cop2r32-63 (CFC2/CTC2, "cnt" numbering = control reg = cop2r32+rd). GTE command = COP2 instruction **(bit25=1)**: word = 0x4A000000|imm25 *(derived from the two tables above, both nocash)*. bc2t/bc2f jump never/always. Coprocessor read load-delay: next opcode can't use the destination; writes to cop2 registers delay 2–3 cycles (IRGB: 3). 
*(KB note for `gte.cop2(instr, gprValue)` consumers: classify `instr` by primary 0x22 + bit25 + rs: rs=4/6 write `gprValue` into rd/cop2 and return garbage-don't-care; rs=0/2 return the cop2 word; bit25=1 → treat imm25 as command.)*
GTE busy: CPU halts on cop2 register **reads** and on issuing a command while busy (~command cycle count; +1 extra cycle for IRGB/ORGB reads during busy).

## 2. GTE command encoding (COP2 imm25 fields) [verbatim]
```
  31-25  Must be 0100101b for "COP2 imm25" instructions
  20-24  Fake GTE Command Number (00h..1Fh) (ignored by hardware)
  19     sf - Shift Fraction in IR registers (0=No fraction, 1=12bit fraction)
  17-18  MVMVA Multiply Matrix    (0=Rotation. 1=Light, 2=Color, 3=Reserved)
  15-16  MVMVA Multiply Vector    (0=V0, 1=V1, 2=V2, 3=IR/long)
  13-14  MVMVA Translation Vector (0=TR, 1=BK, 2=FC/Bugged, 3=None)
  11-12  Always zero                        (ignored by hardware)
  10     lm - Saturate IR1,IR2,IR3 result (0=To -8000h..+7FFFh, 1=To 0..+7FFFh)
  6-9    Always zero                        (ignored by hardware)
  0-5    Real GTE Command Number (00h..3Fh) (used by hardware)
```
MVMVA bits only used by MVMVA; sf/lm usually fixed per command (variable for MVMVA; sf changeable for SQR).
Parent's example verified *(derived from these tables)*: **0x4A280001** → bits31-25=0100101 (COP2 imm25), bits20-24=02h (fake number "RTPT" per fake table — **ignored by hardware**), bits0-5=01h → **RTPS**. The SDK DWORDs (e.g. MVMVA `dw $13BF|sf<<25|mx<<23|v<<21|cv<<19|lm<<18`) are **not** GTE opcodes (DMPSX translates them; verbatim warning retained in nocash [L2775–2787]).

## 3. Command summary [L2687–2762, verbatim, both tables]
```
  Opc  Name      Clk Expl.
  00h  -             N/A (modifies similar registers than RTPS...)
  01h  RTPS      15  Perspective Transformation single
  06h  NCLIP     8   Normal clipping
  0Ch  OP(sf)    6   Outer product of 2 vectors
  10h  DPCS      8   Depth Cueing single
  11h  INTPL     8   Interpolation of a vector and far color vector
  12h  MVMVA(..) 8   Multiply vector by matrix and add vector
  13h  NCDS      19  Normal color depth cue single vector
  14h  CDP       13  Color Depth Que
  16h  NCDT      44  Normal color depth cue triple vectors
  1Bh  NCCS      17  Normal Color Color single vector
  1Ch  CC        11  Color Color
  1Eh  NCS       14  Normal color single
  20h  NCT       30  Normal color triple
  28h  SQR(sf)   5   Square of vector IR
  29h  DCPL      8   Depth Cue Color light
  2Ah  DPCT      17  Depth Cueing triple (should be fake=08h, but isn't)
  2Dh  AVSZ3     5   Average of three Z values
  2Eh  AVSZ4     6   Average of four Z values
  30h  RTPT      23  Perspective Transformation triple
  3Dh  GPF(sf)   5   General purpose interpolation
  3Eh  GPL(sf)   5   General purpose interpolation with base
  3Fh  NCCT      39  Normal Color Color triple vector
  (0xh rows = N/A; unknown what happens on "N/A" opcodes)
```
Fake-number listing (bit20-24, no hardware effect): 01 RTPS, 02 RTPT, 04 MVMVA, 06 DCPL, 07 DPCS, 08 DPCT, 09 INTPL, 0A SQR, 0C NCS, 0D NCT, 0E NCDS, 0F NCDT, 10 NCCS, 11 NCCT, 12 CDP, 13 CC, 14 NCLIP, 15 AVSZ3, 16 AVSZ4, 17 OP, 19 GPF, 1A GPL. Wipeout 2097 glitch example: NCLIP issued as 0x0140006h?? *(verbatim: "accidently uses 0140006h (fake=01h and distorted bit18) instead of 1400006h (fake=14h)")*.
Per-command full encodings (literal, from the per-command headers [L2825-2952, 2899-2951, 2953-3048]): RTPS `0180001h`, RTPT `0280030h`, NCLIP `1400006h`, AVSZ3 `158002Dh`, AVSZ4 `168002Eh`, MVMVA `0400012h`, SQR `0A00428h+sf*80000h`, OP `170000Ch+sf*80000h`, NCS `0C8041Eh`, NCT `0D80420h`, NCCS `108041Bh`, NCCT `118043Fh`, NCDS `0E80413h`, NCDT `0F80416h`, CC `138041Ch` (lm=1), CDP `1280414h`, DCPL `0680029h`, DPCS `0780010h`, DPCT `0x8002Ah`, INTPL `0980011h`, GPF `190003Dh`, GPL `1A0003Eh`. *(These are imm25 values; full cop2 word = 0x4A000000|value.)*

## 4. Register map [§GTE Registers L2460–2629 + summary tables in §Overview, verbatim]
Data registers (cop2r0-31):
```
  cop2r0-1   3xS16 VXY0,VZ0              Vector 0 (X,Y,Z)
  cop2r2-3   3xS16 VXY1,VZ1              Vector 1
  cop2r4-5   3xS16 VXY2,VZ2              Vector 2
  cop2r6     4xU8  RGBC                  Color/code value
  cop2r7     1xU16 OTZ                   Average Z value (for Ordering Table)
  cop2r8     1xS16 IR0                   16bit Accumulator (Interpolate)
  cop2r9-11  3xS16 IR1,IR2,IR3           16bit Accumulator (Vector)
  cop2r12-15 6xS16 SXY0,SXY1,SXY2,SXYP   Screen XY-coordinate FIFO  (3 stages)
  cop2r16-19 4xU16 SZ0,SZ1,SZ2,SZ3       Screen Z-coordinate FIFO   (4 stages)
  cop2r20-22 12xU8 RGB0,RGB1,RGB2        Color CRGB-code/color FIFO (3 stages)
  cop2r23    4xU8  (RES1)                Prohibited
  cop2r24    1xS32 MAC0                  Sum of products value 0
  cop2r25-27 3xS32 MAC1,MAC2,MAC3        32bit Maths Accumulators (Vector)
  cop2r28-29 1xU15 IRGB,ORGB             Convert RGB Color (48bit vs 15bit)
  cop2r30-31 2xS32 LZCS,LZCR             Count Leading-Zeroes/Ones
```
Control registers (cop2r32-63):
```
  cop2r32-36 9xS16 RT11RT12,..,RT33 Rotation matrix     (3x3)        ;cnt0-4
  cop2r37-39 3x32  TRX,TRY,TRZ      Translation vector  (X,Y,Z)      ;cnt5-7
  cop2r40-44 9xS16 L11L12,..,L33    Light source matrix (3x3)        ;cnt8-12
  cop2r45-47 3x32  RBK,GBK,BBK      Background color    (R,G,B)      ;cnt13-15
  cop2r48-52 9xS16 LR1LR2,..,LB3    Light color matrix source (3x3)  ;cnt16-20
  cop2r53-55 3x32  RFC,GFC,BFC      Far color           (R,G,B)      ;cnt21-23
  cop2r56-57 2x32  OFX,OFY          Screen offset       (X,Y)        ;cnt24-25
  cop2r58 BuggyU16 H                Projection plane distance.       ;cnt26
  cop2r59      S16 DQA              Depth queing parameter A (coeff) ;cnt27
  cop2r60       32 DQB              Depth queing parameter B (offset);cnt28
  cop2r61-62 2xS16 ZSF3,ZSF4        Average Z scale factors          ;cnt29-30
  cop2r63      U20 FLAG             Returns any calculation errors   ;cnt31
```
Matrix packing (verbatim): `cop2r32.lsbs=RT11, cop2r32.msbs=RT12, cop2r33.lsbs=RT13, cop2r33.msbs=RT21, cop2r34.lsbs=RT22, cop2r34.msbs=RT23, cop2r35.lsbs=RT31, cop2r35.msbs=RT32, cop2r36=RT33` (LLM cop2r40-44 = L11..L33 same pattern; LCM cop2r48-52 = LR1,LR2,LR3,LG1,..,LB3); last matrix elements (RT33/L33/LB3) read sign-expanded 32-bit. VXY0/VZ0: `cop2r0.lsbs=VX0, cop2r0.msbs=VY0, cop2r1=VZ0`; IR1/IR2/IR3 = cop2r9/10/11; VZn occupy whole 32-bit regs (read sign-expanded).
Fixed-point formats (verbatim): matrix elements **1.3.12** 16-bit; TR **S32** (1.31); BK **1.19.12**; FC **1.27.4**; OFX/OFY **1.15.16**; H = unsigned 16-bit (BUG: MFC2/reads sign-expand it: 8000h..FFFFh read as FFFF8000h..FFFFFFFFh; calculations okay); DQA **1.7.8** (16-bit); DQB **1.7.24** (32-bit); ZSF3/ZSF4 **1.3.12** (normally 1/3 and 1/4); SXYZ **1.15.0**; SZ **0.16.0**; MAC0-3 **S32**.
SXY/SZ FIFOs: SXYn 3 stages; SXYP mirrors SXY2 with move-on-write (writing SXYP shifts SXY2→SXY1→SXY0); writing SXY0/SXY1/SXY2 writes only that register. SZ 4 stages. SX/SY output of RTPS/RTPT + input of NCLIP; SZ input of AVSZ3/4. RGB FIFO: writing RGB0/1/2 does not shift (RES1 cop2r23 prohibited/mirror-less). IRGB write expands 5:5:5 → ×80h into IR1/IR2/IR3 (read IR3 after two nops, IR1/2 after three — one nop works for uncached code); ORGB read-only mirror (saturate 00..1Fh, no FLAG bits). LZCS/LZCR: leading zero count if positive else leading one count, range 1..32.

## 5. Saturation and FLAG [§GTE Saturation L2631–2686, verbatim]
Math overflows indicate in FLAG; results saturated to MIN/MAX except MAC0..MAC3 (not saturated). IR1-3 MIN selectable via lm (RTPS/RTPT always act as if lm=0).
```
  31   Error Flag (Bit30..23, and 18..13 ORed together) (Read only)
  30   MAC1 Result positive 44bit overflow (max +7FFFFFFFFFFh) ;\triggered
  29   MAC2 Result positive 44bit overflow (max +7FFFFFFFFFFh) ; during
  28   MAC3 Result positive 44bit overflow (max +7FFFFFFFFFFh) ; calculations
  27   MAC1 Result negative 44bit overflow (min -80000000000h) ;
  26   MAC2 Result negative 44bit overflow (min -80000000000h) ;
  25   MAC3 Result negative 44bit overflow (min -80000000000h) ;/
  24   IR1 saturated to +0000h..+7FFFh (lm=1) or to -8000h..+7FFFh (lm=0)
  23   IR2 saturated to +0000h..+7FFFh (lm=1) or to -8000h..+7FFFh (lm=0)
  22   IR3 saturated to +0000h..+7FFFh (lm=1) or to -8000h..+7FFFh (lm=0)
  21   Color-FIFO-R saturated to +00h..+FFh
  20   Color-FIFO-G saturated to +00h..+FFh
  19   Color-FIFO-B saturated to +00h..+FFh
  18   SZ3 or OTZ saturated to +0000h..+FFFFh
  17   Divide overflow. RTPS/RTPT division result saturated to max=1FFFFh
  16   MAC0 Result positive 32bit overflow (max +7FFFFFFFh)    ;\triggered on
  15   MAC0 Result negative 32bit overflow (min -80000000h)    ;/final result
  14   SX2 saturated to -0400h..+03FFh
  13   SY2 saturated to -0400h..+03FFh
  12   IR0 saturated to +0000h..+1000h
  0-11 Not used (always zero) (Read only)
```
Bits 30-12 are software-writable but auto-reset at each new command. 44-bit MAC overflows can self-cancel internally (both flags set while final result is fine). Software writes to 16-bit regs never trigger flags (e.g. writing 12008900h to an S16 register stores FFFF8900h).

## 6. Command operations [verbatim formulas]
**RTPS/RTPT [L2827–2849]** (`sf` usually 1; RTPT repeats for V1,V2; **DQA/DQB/IR0 computed only for the 3rd vertex (V2)** on RTPT and FLAG.12 set only then):
```
  IR1 = MAC1 = (TRX*1000h + RT11*VX0 + RT12*VY0 + RT13*VZ0) SAR (sf*12)
  IR2 = MAC2 = (TRY*1000h + RT21*VX0 + RT22*VY0 + RT23*VZ0) SAR (sf*12)
  IR3 = MAC3 = (TRZ*1000h + RT31*VX0 + RT32*VY0 + RT33*VZ0) SAR (sf*12)
  SZ3 = MAC3 SAR ((1-sf)*12)                           ;ScreenZ FIFO 0..+FFFFh
  MAC0=(((H*20000h/SZ3)+1)/2)*IR1+OFX, SX2=MAC0/10000h ;ScrX FIFO -400h..+3FFh
  MAC0=(((H*20000h/SZ3)+1)/2)*IR2+OFY, SY2=MAC0/10000h ;ScrY FIFO -400h..+3FFh
  MAC0=(((H*20000h/SZ3)+1)/2)*DQA+DQB, IR0=MAC0/1000h  ;Depth cueing 0..+1000h
```
Division result >1FFFFh saturates to 1FFFFh + FLAG.17/31 set — near camera (SZ3<=H/2), at camera (SZ3=0), behind camera (negative Z saturates to SZ3=0). Far-clip options: SZ3 saturation flag (MaxZ=FFFFh) or IR3 (MaxZ=7FFFh) or software compare. IR1-3 saturate to -8000h..7FFFh regardless of lm; with sf=0, FLAG.22 fires only if "MAC3 SAR 12" exceeds S16, while IR3 saturates on raw MAC3. FLAG.18 when SZ3 exceeds 0000h..FFFFh (SZ3 saturates).
**NCLIP [L2850–2863]** `MAC0 = SX0*(SY1-SY2) + SX1*(SY2-SY0) + SX2*(SY0-SY1)` (equal to the slow sign form); sign = winding/clockwise-ness; zero = straight line (renders as invisible 0-width); FLAG.31/16/15 on 32-bit overflow.
**AVSZ3/AVSZ4 [L2864–2874]** `MAC0 = ZSF3*(SZ1+SZ2+SZ3)` / `ZSF4*(SZ0+SZ1+SZ2+SZ3)`; `OTZ = MAC0/1000h` saturated 0..FFFFh. Common: ZSF3=N/30h, ZSF4=N/40h for an N-entry OT.
**MVMVA(sf,mx,v,cv,lm) [L2899–2921]** `Mx`=RT/LLM/LCM by mx; `Vx`=V0/V1/V2/[IR1,IR2,IR3] by v; `Tx`=TR/BK/Bugged-FC/None by cv.
```
  MAC1 = (Tx1*1000h + Mx11*Vx1 + Mx12*Vx2 + Mx13*Vx3) SAR (sf*12)
  MAC2 = (Tx2*1000h + Mx21*Vx1 + Mx22*Vx2 + Mx23*Vx3) SAR (sf*12)
  MAC3 = (Tx3*1000h + Mx31*Vx1 + Mx32*Vx2 + Mx33*Vx3) SAR (sf*12)
  [IR1,IR2,IR3] = [MAC1,MAC2,MAC3]
```
cv=2 (FC) is buggy: split into part1 `(Tx*1000h + Mx1*Vx1)` saturating as-if-lm=0 then part2 `(Mx2*Vx2+Mx3*Vx3)` saturating by lm. mx=3 = garbage matrix `{−R*10h, +R*10h, IR0, RT13, RT13, RT13, RT22, RT22, RT22}` (R = RGBC LSBs).
**SQR(sf) [L2922–2928]** `[MAC1..3] = [IR1*IR1, IR2*IR2, IR3*IR3] SHR (sf*12)`, IR=MAC saturated to ≤7FFFh.
**OP(sf,lm) [L2929–2938]**
`[MAC1..3] = [IR3*D2-IR2*D3, IR1*D3-IR3*D1, IR2*D1-IR1*D2] SAR (sf*12)` with D1,D2,D3 = RT11,RT22,RT33 "misused" as vector; lm usually 0.
**Color family [L2953–3046]** — NCS/NCT/NCCS/NCCT/NCDS/NCDT (V0/V1/V2 as normals), inputs BK, RGBC, LLM, LCM, IR0:
```
  [IR1,IR2,IR3] = [MAC1,MAC2,MAC3] = (LLM*V0) SAR (sf*12)
  [IR1,IR2,IR3] = [MAC1,MAC2,MAC3] = (BK*1000h + LCM*IR) SAR (sf*12)
  [MAC1,MAC2,MAC3] = [R*IR1,G*IR2,B*IR3] SHL 4          ;<--- for NCDx/NCCx
  [MAC1,MAC2,MAC3] = MAC+(FC-MAC)*IR0                   ;<--- for NCDx only
  [MAC1,MAC2,MAC3] = [MAC1,MAC2,MAC3] SAR (sf*12)       ;<--- for NCDx/NCCx
  Color FIFO = [MAC1/16,MAC2/16,MAC3/16,CODE], [IR1,IR2,IR3] = [MAC1,MAC2,MAC3]
```
NCCx: no depth-cue step. CC (lm=1) and CDP as in table (CDP has the depth-cue step). "MAC+(FC-MAC)*IR0" internally = `IR = ((FC SHL 12) − MAC) SAR (sf*12)` (saturated as-if-lm=0) then `MAC = (IR*IR0) + MAC`. (LLM/BK+LCM steps work like MVMVA with fixed parameters; sf/lm changeable although normally both set.) DCPL/DPCS/DPCT/INTPL (verbatim diff):
```
  [MAC1,MAC2,MAC3] = [R*IR1,G*IR2,B*IR3] SHL 4          ;<--- for DCPL only
  [MAC1,MAC2,MAC3] = [IR1,IR2,IR3] SHL 12               ;<--- for INTPL only
  [MAC1,MAC2,MAC3] = [R,G,B] SHL 16                     ;<--- for DPCS/DPCT
  [MAC1,MAC2,MAC3] = MAC+(FC-MAC)*IR0
  [MAC1,MAC2,MAC3] = [MAC1,MAC2,MAC3] SAR (sf*12)
  Color FIFO = [MAC1/16,MAC2/16,MAC3/16,CODE], [IR1,IR2,IR3] = [MAC1,MAC2,MAC3]
```
DPCT executes thrice reading R,G,B from RGB0 (bottom of FIFO); CODE still from RGBC; FIFO entries get modified. GPF/GPL:
```
  [MAC1,MAC2,MAC3] = [0,0,0]                            ;<--- for GPF only
  [MAC1,MAC2,MAC3] = [MAC1,MAC2,MAC3] SHL (sf*12)       ;<--- for GPL only
  [MAC1,MAC2,MAC3] = (([IR1,IR2,IR3] * IR0) + [MAC1,MAC2,MAC3]) SAR (sf*12)
  Color FIFO = [MAC1/16,MAC2/16,MAC3/16,CODE], [IR1,IR2,IR3] = [MAC1,MAC2,MAC3]
```
(GPL's SHL/SAR pair can 44-bit overflow internally at sf=1.) Color FIFO writes = MAC/16 saturated to 00..FFh + older entries shift down; for texture blending FFh = double brightness, 80h = normal; the CODE byte is meant to be merged with a GP0(20h..7Fh) command id.

## 7. Division (RTPS/RTPT) + UNR [§GTE Division Inaccuracy L3049–3109, verbatim]
Ideal (33-bit): `n = (((H*20000h/SZ3)+1)/2)` ≡ 32-bit alt `n = ((H*10000h+SZ3/2)/SZ3)`; saturation: `if n>1FFFFh or division_by_zero then n=1FFFFh, FLAG.Bit17=1, FLAG.Bit31=1`. Hardware (UNR; verbatim):
```
  if (H < SZ3*2) then                            ;check if overflow
    z = count_leading_zeroes(SZ3)                ;z=0..0Fh (for 16bit SZ3)
    n = (H SHL z)                                ;n=0..7FFF8000h
    d = (SZ3 SHL z)                              ;d=8000h..FFFFh
    u = unr_table[(d-7FC0h) SHR 7] + 101h        ;u=200h..101h
    d = ((2000080h - (d * u)) SHR 8)             ;d=10000h..0FF01h
    d = ((0000080h + (d * u)) SHR 8)             ;d=20000h..10000h
    n = min(1FFFFh, (((n*d) + 8000h) SHR 16))    ;n=0..1FFFFh
  else n = 1FFFFh, FLAG.Bit17=1, FLAG.Bit31=1    ;n=1FFFFh plus overflow flag
```
`unr_table[000h..100h]` verbatim (257 entries, rows of 16 + the extra `00h`):
```
  FFh,FDh,FBh,F9h,F7h,F5h,F3h,F1h,EFh,EEh,ECh,EAh,E8h,E6h,E4h,E3h ;
  E1h,DFh,DDh,DCh,DAh,D8h,D6h,D5h,D3h,D1h,D0h,CEh,CDh,CBh,C9h,C8h ; 00h..3Fh
  C6h,C5h,C3h,C1h,C0h,BEh,BDh,BBh,BAh,B8h,B7h,B5h,B4h,B2h,B1h,B0h ;
  AEh,ADh,ABh,AAh,A9h,A7h,A6h,A4h,A3h,A2h,A0h,9Fh,9Eh,9Ch,9Bh,9Ah ;/
  99h,97h,96h,95h,94h,92h,91h,90h,8Fh,8Dh,8Ch,8Bh,8Ah,89h,87h,86h ;
  85h,84h,83h,82h,81h,7Fh,7Eh,7Dh,7Ch,7Bh,7Ah,79h,78h,77h,75h,74h ; 40h..7Fh
  73h,72h,71h,70h,6Fh,6Eh,6Dh,6Ch,6Bh,6Ah,69h,68h,67h,66h,65h,64h ;
  63h,62h,61h,60h,5Fh,5Eh,5Dh,5Dh,5Ch,5Bh,5Ah,59h,58h,57h,56h,55h ;/
  54h,53h,53h,52h,51h,50h,4Fh,4Eh,4Dh,4Dh,4Ch,4Bh,4Ah,49h,48h,48h ;
  47h,46h,45h,44h,43h,43h,42h,41h,40h,3Fh,3Fh,3Eh,3Dh,3Ch,3Ch,3Bh ; 80h..BFh
  3Ah,39h,39h,38h,37h,36h,36h,35h,34h,33h,33h,32h,31h,31h,30h,2Fh ;
  2Eh,2Eh,2Dh,2Ch,2Ch,2Bh,2Ah,2Ah,29h,28h,28h,27h,26h,26h,25h,24h ;/
  24h,23h,22h,22h,21h,20h,20h,1Fh,1Eh,1Eh,1Dh,1Dh,1Ch,1Bh,1Bh,1Ah ;
  19h,19h,18h,18h,17h,16h,16h,15h,15h,14h,14h,13h,12h,12h,11h,11h ; C0h..FFh
  10h,0Fh,0Fh,0Eh,0Eh,0Dh,0Dh,0Ch,0Ch,0Bh,0Ah,0Ah,09h,09h,08h,08h ;
  07h,07h,06h,06h,05h,05h,04h,04h,03h,03h,02h,02h,01h,01h,00h,00h ;/
  00h    ;<-- one extra table entry (for "(d-7FC0h)/80h"=100h)    ;-100h
```
Generator (verbatim): `unr_table[i]=min(0,(40000h/(i+100h)+1)/2-101h)`. Special cases (verbatim): NNNNh/0001h uses big multiplier (practically only 0000h/0001h, 0001h/0001h, due to the H<SZ3*2 check); the min(1FFFFh) limit exists for e.g. FE3Fh/7F20h, F015h/780Bh (UNR output 20000h saturates to 1FFFFh *without* the overflow flags).

## 8. Worked example — hand-computed, NOT hardware-verified (KB note)
Setup: RT11=RT22=RT33=0x1000, other RT=0; TRX/TRY/TRZ=0; H=0x200 (512); OFX=OFY=0; DQA=0, DQB=0; V0=(0x0C00, 0x0000, 0x0800) = (3072, 0, 2048); RTPS (sf=1). Expected: IR1=MAC1=(4096*3072)SAR12=3072; IR2=0; IR3=MAC3=(4096*2048)SAR12=2048; SZ3=2048; division factor=(512*20000h/2048+1)/2=16384; MAC0=16384*3072=0x03000000 → SX2=0x0300 (768, no clip); SY2=0; IR0=0; FLAG=0. Variant B: V0.X=0x3000 (12288) → IR1=12288, MAC0=0x08000000, SX2=0x800=2048 > +3FFh → SX2 saturates to +3FFh and **FLAG=0x00004000** (bit14; IR1=12288 ≤ 7FFFh so bit24 is NOT set). *(Derived from the cited nocash formulas; cross-check against a trusted implementation (e.g. DobieStation `gte.cpp`) before hardcoding.)* nocash contains no numeric worked examples — nothing to quote verbatim.

## Sources
- [PSX-SPX — Geometry Transformation Engine (GTE)](https://problemkaputt.de/psx-spx.htm#geometrytransformationenginegte) — **Credibility:** canonical public spec, vendored locally; **Relevance:** encoding, register packing, FLAG bits, formulas, UNR table — all quoted; **Sufficiency:** complete for an implementation; no sourced numeric vectors exist in this source (example above is hand-computed and labeled).

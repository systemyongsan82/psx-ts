# PlayStation SPU — implementation reference
Source: nocash PSX-SPX (local `docs/raw/psx-spx.htm`; anchors/line refs per section). Tables **verbatim** (markup decoded).

## 1. Port map and basics [§SPU Overview L3599–3677, verbatim]
```
  1F801C00h..1F801D7Fh - Voice 0..23 Registers (eight 16bit regs per voice)
  1F801D80h..1F801D87h - SPU Control (volume)
  1F801D88h..1F801D9Fh - Voice 0..23 Flags (six 1bit flags per voice)
  1F801DA2h..1F801DBFh - SPU Control (memory, control, etc.)
  1F801DC0h..1F801DFFh - Reverb configuration area
  1F801E00h..1F801E5Fh - Voice 0..23 Internal Registers
  1F801E60h..1F801E7Fh - Unknown?
  1F801E80h..1F801FFFh - Unused?
```
Sound RAM 512KB, NOT CPU-mapped (I/O + DMA4 only):
```
  00000h-003FFh  CD Audio left  (1Kbyte) ;CD Audio before Volume processing
  00400h-007FFh  CD Audio right (1Kbyte)
  00800h-00BFFh  Voice 1 mono   (1Kbyte) ;Voice 1/3 after ADSR processing
  00C00h-00FFFh  Voice 3 mono   (1Kbyte)
  01000h-xxxxxh  ADPCM Samples  (first 16 bytes usually contain a Sine wave)
  xxxxxh-7FFFFh  Reverb work area
```
- Registers processed at 44.1kHz (1/44100 s ≈ 300h SYSCLK cycles latency). SPU bus is 16-bit; 8-bit writes unimplemented (odd: ignored; even: executed as 16-bit write with byte0 dropped — writes 5678h, not 78h). **32-bit writes are unstable** (lower halfword may be dropped depending on timing).
- *(KB note re parent's "0x1D89 two-bank quirk": nocash defines **no 1F801D89-bank register**; the real structure is six per-voice flag words in two bit-banks (low halfword = voices 0-15 at base, high halfword = voices 16-23 at base+2), see §4. And "SPU data address" = 1F801DA6h (transfer), distinct from the per-voice ADPCM repeat address 1F801C0Eh+N*10h.)*
- *(KB note: parent's "swap" register and "CD volume at 0x1F801C38/3A" do not exist in nocash; CD audio input volumes are 1F801DB0h/DB2h, see §3.)*

## 2. Per-voice registers (N = voice 0..23) [+ individual defs verbatim in §3, §5, §7]
```
  1F801C00h+N*10h  Volume Left (+1F801C02h Volume Right)      (see §3)
  1F801C04h+N*10h  ADPCM Sample Rate (VxPitch)  "0=stop, 4000h=fastest, 4001h..FFFFh=usually same as 4000h"; 1000h = 44100Hz
  1F801C06h+N*10h  ADPCM Start Address         "15-0 Startaddress of sound in Sound buffer (in 8-byte units)"; copy to current addr on KeyOn
  1F801C08h+N*10h  ADSR bit0-15 (+1F801C0Ah bit16-31)          (see §5)
  1F801C0Ch+N*10h  Current ADSR volume (R/W; 0..7FFFh; manual write can jump level but generator overwrites on next Step)
  1F801C0Eh+N*10h  ADPCM Repeat Address  "(15-0) Address sample loops to at end (in 8-byte units)"; auto-written at Loop-Start header bit; auto-read back at Loop-End (after finishing current block)
```

## 3. Volume [§SPU Volume and ADSR L3930–4052, verbatim]
Fixed mode (bit15=0): bits0-14 = vol/2 (−4000h..+3FFFh = −8000h..+7FFEh). Sweep mode (bit15=1): bit14 mode (0=Linear,1=Exponential), bit13 direction, bit12 phase, bits6-2 shift (0..1Fh), bits1-0 step ("+7,+6,+5,+4" inc / "-8,-7,-6,-5" dec). Sweep = an extra stereo-capable envelope started at current level running to +7FFFh/0000h; phase should equal current volume sign; no effect in exp-decrease. Negative volumes = phase inverted.
```
  1F801D80h Mainvolume Left      1F801D82h Mainvolume Right
  1F801DB0h CD Audio Input Volume, Left     1F801DB2h CD Audio Input Volume, Right
  1F801DB4h External Audio Input Volume, L  1F801DB6h ...Right  (0-15 Volume, -8000h..+7FFFh)
  1F801DB8h Current Main Volume L           1F801DBAh Current Main Volume R
  1F801E00h+voice*04h Current Volume L      1F801E02h+voice*04h Current Volume R
```
CD input may be CD-DA or XA-ADPCM; the CD controller itself also has stereo→mono/L-R-swap volume control. *(derived: the capture buffers at 00000h-003FFh/00400h-007FFh store pre-main-volume CD L/R at 44.1kHz.)*

## 4. Key on/off/ENDX + noise [verbatim]
```
  1F801D88h Key ON  (KON)  bit0-15   1F801D8Ah bit16-31   ;0-23: 1=Start Attack/Decay/Sustain
  1F801D8Ch Key OFF (KOFF) bit0-15   1F801D8Eh bit16-31   ;0-23: 1=Start Release (any phase aborts into Release)
  1F801D9Ch ENDX     (R)    bit0-15   1F801D9Eh bit16-31   ;0=Newly Keyed On, 1=Reached LOOP-END; cleared by KEY ON
  1F801D90h PMON  bit0-15 / 1F801D92h bit16-31   ;Pitch Modulation enable (voice x modulated by voice x-1's amplitude, OUTX value 0..1.99)
  1F801D94h NON  bit0-15 / 1F801D96h bit16-31    ;Noise-mode enable per voice
  1F801D98h EON  bit0-15 / 1F801D9Ah bit16-31    ;Reverb enable per voice (§10)
```
KON sets ADSR=0, copies Start→Repeat address; KON/KOFF = write-only (read returns last written). ENDX = read-only-ish. Noise (verbatim, 44.1kHz): `Timer-=NoiseStep(4..7); Parity=NoiseLevel.15 xor .12 xor .11 xor .10 xor 1; IF Timer<0: NoiseLevel=NoiseLevel*2+Parity, Timer+=(20000h SHR NoiseShift)` (twice if still <0); noise frequency only via SPUCNT bits 13-10/9-8.

## 5. ADSR [verbatim]
```
  ____lower 16bit (at 1F801C08h+N*10h)___________________________________
  15    Attack Mode       (0=Linear, 1=Exponential)
  -     Attack Direction  (Fixed, always Increase) (until Level 7FFFh)
  14-10 Attack Shift      (0..1Fh = Fast..Slow)
  9-8   Attack Step       (0..3 = "+7,+6,+5,+4")
  -     Decay Mode        (Fixed, always Exponential)
  -     Decay Direction   (Fixed, always Decrease) (until Sustain Level)
  7-4   Decay Shift       (0..0Fh = Fast..Slow)
  -     Decay Step        (Fixed, always "-8")
  3-0   Sustain Level     (0..0Fh)  ;Level=(N+1)*800h
  ____upper 16bit (at 1F801C0Ah+N*10h)___________________________________
  31    Sustain Mode      (0=Linear, 1=Exponential)
  30    Sustain Direction (0=Increase, 1=Decrease) (until Key OFF flag)
  29    Not used?         (should be zero)
  28-24 Sustain Shift     (0..1Fh = Fast..Slow)
  23-22 Sustain Step      (0..3 = "+7,+6,+5,+4" or "-8,-7,-6,-5") (inc/dec)
  21    Release Mode      (0=Linear, 1=Exponential)
  -     Release Direction (Fixed, always Decrease) (until Level 0000h)
  20-16 Release Shift     (0..1Fh = Fast..Slow)
  -     Release Step      (Fixed, always "-8")
```
Envelope operation (verbatim — the rate/direction mechanism; nocash has no separate 110-row table):
```
  AdsrCycles = 1 SHL Max(0,ShiftValue-11)
  AdsrStep = StepValue SHL Max(0,11-ShiftValue)
  IF exponential AND increase AND AdsrLevel>6000h THEN AdsrCycles=AdsrCycles*4
  IF exponential AND decrease THEN AdsrStep=AdsrStep*AdsrLevel/8000h
  Wait(AdsrCycles)              ;cycles counted at 44.1kHz clock
  AdsrLevel=AdsrLevel+AdsrStep  ;saturated to 0..+7FFFh
```
Exponential-increase = slower linear at higher levels. *(derived: per-Shift-Index "rate" tables used by other emulators are just enumerations of 1<<max(0,shift−11); derive, don't guess.)*

## 6. SPU-ADPCM blocks [verbatim]
16-byte block: byte0 = Shift/Filter ("reportedly same as for CDROM XA-ADPCM"), byte1 = flags, bytes2-15 = 28 packed samples (2 nibbles per byte pair: `LSBs=1st Sample, MSBs=2nd Sample`, i.e. 14 bytes × 4-bit nibbles ×2 = 28 samples).
```
  Flag Bits (byte1): 0 Loop End (1=Set ENDX and Jump to [1F801C0Eh+N*10h])
                     1 Loop Repeat (0=Force Release and set ADSR Level to Zero; only if Bit0=1)
                     2 Loop Start (1=Copy current address to [1F801C0Eh+N*10h])
                     3-7 Unknown (usually 0)
  Bit0-1 combos: 0=Normal  1=End+Mute (loop jump + ENDX + Release + Env=0000h)  2=Ignored(=0)  3=End+Repeat
```
One-shots must end in a dummy zero-block with both loop flags (endless silent loop). Decompression = same algorithm family as XA (§9), nibble order differs, 2×14 nibbles/block, no loop in XA.

## 7. Pitch and Gaussian interpolation [verbatim]
```
  Step = VxPitch                  ;range +0000h..+FFFFh (0...705.6 kHz)
  IF PMON.Bit(x)=1 AND (x>0)
    Factor = VxOUTX(x-1)          ;range -8000h..+7FFFh
    Factor = Factor+8000h         ;factor = 0.00 .. 1.99
    Step=SignExpand16to32(Step)   ;hardware glitch on VxPitch>7FFFh
    Step = (Step * Factor) SAR 15 ;range 0..1FFFFh
    Step=Step AND 0000FFFFh       ;kill sign
  IF Step>3FFFh then Step=4000h   ;range +0000h..+3FFFh (0..176.4kHz)
  Counter = Counter + Step
  Counter.Bit12 and up indicates the current sample (within a ADPCM block).
  Counter.Bit3..11 are used as 8bit gaussian interpolation index.
```
Interpolation on the 4 newest samples (verbatim):
```
  out =       ((gauss[0FFh-i] * oldest) SAR 15)
  out = out + ((gauss[1FFh-i] * older)  SAR 15)
  out = out + ((gauss[100h+i] * old)    SAR 15)
  out = out + ((gauss[000h+i] * new)    SAR 15)
```
Full gauss table (verbatim, hex, 512 entries; entries 000h..07Fh, 080h..0FFh, 100h..17Fh, 180h..1FFh):
```
  -001h,-001h,-001h,-001h,-001h,-001h,-001h,-001h ;\
  -001h,-001h,-001h,-001h,-001h,-001h,-001h,-001h ;
  0000h,0000h,0000h,0000h,0000h,0000h,0000h,0001h ;
  0001h,0001h,0001h,0002h,0002h,0002h,0003h,0003h ;
  0003h,0004h,0004h,0005h,0005h,0006h,0007h,0007h ;
  0008h,0009h,0009h,000Ah,000Bh,000Ch,000Dh,000Eh ;
  000Fh,0010h,0011h,0012h,0013h,0015h,0016h,0018h ; entry
  0019h,001Bh,001Ch,001Eh,0020h,0021h,0023h,0025h ; 000h..07Fh
  0027h,0029h,002Ch,002Eh,0030h,0033h,0035h,0038h ;
  003Ah,003Dh,0040h,0043h,0046h,0049h,004Dh,0050h ;
  0054h,0057h,005Bh,005Fh,0063h,0067h,006Bh,006Fh ;
  0074h,0078h,007Dh,0082h,0087h,008Ch,0091h,0096h ;
  009Ch,00A1h,00A7h,00ADh,00B3h,00BAh,00C0h,00C7h ;
  00CDh,00D4h,00DBh,00E3h,00EAh,00F2h,00FAh,0101h ;
  010Ah,0112h,011Bh,0123h,012Ch,0135h,013Fh,0148h ;
  0152h,015Ch,0166h,0171h,017Bh,0186h,0191h,019Ch ;/
  01A8h,01B4h,01C0h,01CCh,01D9h,01E5h,01F2h,0200h ;\
  020Dh,021Bh,0229h,0237h,0246h,0255h,0264h,0273h ;
  0283h,0293h,02A3h,02B4h,02C4h,02D6h,02E7h,02F9h ;
  030Bh,031Dh,0330h,0343h,0356h,036Ah,037Eh,0392h ;
  03A7h,03BCh,03D1h,03E7h,03FCh,0413h,042Ah,0441h ;
  0458h,0470h,0488h,04A0h,04B9h,04D2h,04ECh,0506h ;
  0520h,053Bh,0556h,0572h,058Eh,05AAh,05C7h,05E4h ; entry
  0601h,061Fh,063Eh,065Ch,067Ch,069Bh,06BBh,06DCh ; 080h..0FFh
  06FDh,071Eh,0740h,0762h,0784h,07A7h,07CBh,07EFh ;
  0813h,0838h,085Dh,0883h,08A9h,08D0h,08F7h,091Eh ;
  0946h,096Fh,0998h,09C1h,09EBh,0A16h,0A40h,0A6Ch ;
  0A98h,0AC4h,0AF1h,0B1Eh,0B4Ch,0B7Ah,0BA9h,0BD8h ;
  0C07h,0C38h,0C68h,0C99h,0CCBh,0CFDh,0D30h,0D63h ;
  0D97h,0DCBh,0E00h,0E35h,0E6Bh,0EA1h,0ED7h,0F0Fh ;
  0F46h,0F7Fh,0FB7h,0FF1h,102Ah,1065h,109Fh,10DBh ;
  1116h,1153h,118Fh,11CDh,120Bh,1249h,1288h,12C7h ;/
  1307h,1347h,1388h,13C9h,140Bh,144Dh,1490h,14D4h ;\
  1517h,155Ch,15A0h,15E6h,162Ch,1672h,16B9h,1700h ;
  1747h,1790h,17D8h,1821h,186Bh,18B5h,1900h,194Bh ;
  1996h,19E2h,1A2Eh,1A7Bh,1AC8h,1B16h,1B64h,1BB3h ;
  1C02h,1C51h,1CA1h,1CF1h,1D42h,1D93h,1DE5h,1E37h ;
  1E89h,1EDCh,1F2Fh,1F82h,1FD6h,202Ah,207Fh,20D4h ;
  2129h,217Fh,21D5h,222Ch,2282h,22DAh,2331h,2389h ; entry
  23E1h,2439h,2492h,24EBh,2545h,259Eh,25F8h,2653h ; 100h..17Fh
  26ADh,2708h,2763h,27BEh,281Ah,2876h,28D2h,292Eh ;
  298Bh,29E7h,2A44h,2AA1h,2AFFh,2B5Ch,2BBAh,2C18h ;
  2C76h,2CD4h,2D33h,2D91h,2DF0h,2E4Fh,2EAEh,2F0Dh ;
  2F6Ch,2FCCh,302Bh,308Bh,30EAh,314Ah,31AAh,3209h ;
  3269h,32C9h,3329h,3389h,33E9h,3449h,34A9h,3509h ;
  3569h,35C9h,3629h,3689h,36E8h,3748h,37A8h,3807h ;
  3867h,38C6h,3926h,3985h,39E4h,3A43h,3AA2h,3B00h ;
  3B5Fh,3BBDh,3C1Bh,3C79h,3CD7h,3D35h,3D92h,3DEFh ;/
  3E4Ch,3EA9h,3F05h,3F62h,3FBDh,4019h,4074h,40D0h ;\
  412Ah,4185h,41DFh,4239h,4292h,42EBh,4344h,439Ch ;
  43F4h,444Ch,44A3h,44FAh,4550h,45A6h,45FCh,4651h ;
  46A6h,46FAh,474Eh,47A1h,47F4h,4846h,4898h,48E9h ;
  493Ah,498Ah,49D9h,4A29h,4A77h,4AC5h,4B13h,4B5Fh ;
  4BACh,4BF7h,4C42h,4C8Dh,4CD7h,4D20h,4D68h,4DB0h ;
  4DF7h,4E3Eh,4E84h,4EC9h,4F0Eh,4F52h,4F95h,4FD7h ; entry
  5019h,505Ah,509Ah,50DAh,5118h,5156h,5194h,51D0h ; 180h..1FFh
  520Ch,5247h,5281h,52BAh,52F3h,532Ah,5361h,5397h ;
  53CCh,5401h,5434h,5467h,5499h,54CAh,54FAh,5529h ;
  5558h,5585h,55B2h,55DEh,5609h,5632h,565Bh,5684h ;
  56ABh,56D1h,56F6h,571Bh,573Eh,5761h,5782h,57A3h ;
  57C3h,57E2h,57FFh,581Ch,5838h,5853h,586Dh,5886h ;
  589Eh,58B5h,58CBh,58E0h,58F4h,5907h,5919h,592Ah ;
  593Ah,5949h,5958h,5965h,5971h,597Ch,5986h,598Fh ;
  5997h,599Eh,59A4h,59A9h,59ADh,59B0h,59B2h,59B3h ;/
```
Tables sum ≈ 0x7F7F..0x7F81 per quadruple (≤8000h — no overflow, unlike SNES).

## 8. SPUCNT/SPUSTAT [verbatim]
```
  1F801DAAh SPUCNT: 15 Soft Reset(0=Reset/KeyOff,1=Normal) ;14 Mute(0=Mute,1=Unmute) ;
   13-10 Noise Freq Shift (0..0Fh) ;9-8 Noise Freq Step(4,5,6,7) ;7 Reverb Master Enable ;
   6 IRQ9 Enable(ack at 0) ;5-4 Transfer Mode(0=Stop,1=ManualWrite,2=DMAwrite,3=DMAread) ;
   3 External Audio Reverb ;2 CD Audio Reverb ;1 External Audio Enable ;0 CD Audio Enable
  1F801DAEh SPUSTAT: 15-12 unused ;11 capture-buffer half (works only if 1F801DACh bit2/bit3 set) ;
   10 Transfer Busy ;9 DMA Read Request ;8 DMA Write Request ;7 = SPUCNT.5(mirror) ;6 IRQ9 flag ;
   5-0 current mode (delayed)
```
SPUCNT.15=0: all voices keyed off, KON ignored, ADSR forced 0. Mode bits 0-5 apply delayed — poll SPUSTAT 5-0 before next step; set Stop before mode switches.

## 9. Memory access, DMA, IRQ9 [verbatim]
```
  1F801DA6h Sound RAM Data Transfer Address   "15-0 Address in sound buffer divided by eight"
     (writing also stores value*8 into an internal current-address register that increments during transfers)
  1F801DA8h Sound RAM Data Transfer Fifo (manual write, max 32 halfwords)
  1F801DACh Sound RAM Data Transfer Control (should be 0004h; bits3-1=Transfer Type: 0/1/6/7=Fill(last),
    2=Normal, 3=Rep2, 4=Rep4, 5=Rep8 — odd expansion of fifo halfwords)
  1F801DA4h Sound RAM IRQ Address (IRQ9)  "15-0 Address in sound buffer divided by eight"
```
DMA-Write procedure: DAC=0004h → SPUCNT Stop (wait SPUSTAT) → set DA6 → SPUCNT DMA-Write → start **DMA4, blocksize=10h, CHCR=01000201h** → wait DMA4 done. DMA-Read stable: set **1F801014h = 220931E1h (bit24-27 MUST be nonzero)** first, then same with control=01000200h; with bit24-27=0, reads glitch (each block's first halfword received as FFFFh, losing one halfword per block; rep2 workaround exists — see nocash, L4256–4303). IRQ9 triggers on: voice reading ADPCM at IRQ address (ALL voices read RAM permanently — even noise/zero-volume ones; align IRQ address to 16-byte blocks), capture-buffer writes (IRQ address 0000h..01FFh; buffers 400h bytes each → ~86.13Hz; CD audio capture always active; needs 1F801DACh bits), reverb buffer access, and data transfers. Used by MGS, Legend of Mana, T. Memorial 2, CTR, Tron Bonne, NFS3(?).

## 10. Reverb [verbatim]
```
  Port      Reg   Name    Type    Expl.
  1F801D84h spu   vLOUT   volume  Reverb Output Volume Left
  1F801D86h spu   vROUT   volume  Reverb Output Volume Right
  1F801DA2h spu   mBASE   base    Reverb Work Area Start Address in Sound RAM
  1F801DC0h rev00 dAPF1   disp    Reverb APF Offset 1
  1F801DC2h rev01 dAPF2   disp    Reverb APF Offset 2
  1F801DC4h rev02 vIIR    volume  Reverb Reflection Volume 1
  1F801DC6h rev03 vCOMB1  volume  Reverb Comb Volume 1
  1F801DC8h rev04 vCOMB2  volume  Reverb Comb Volume 2
  1F801DCAh rev05 vCOMB3  volume  Reverb Comb Volume 3
  1F801DCCh rev06 vCOMB4  volume  Reverb Comb Volume 4
  1F801DCEh rev07 vWALL   volume  Reverb Reflection Volume 2
  1F801DD0h rev08 vAPF1   volume  Reverb APF Volume 1
  1F801DD2h rev09 vAPF2   volume  Reverb APF Volume 2
  1F801DD4h rev0A mLSAME  src/dst Reverb Same Side Reflection Address 1 Left
  1F801DD6h rev0B mRSAME  src/dst Reverb Same Side Reflection Address 1 Right
  1F801DD8h rev0C mLCOMB1 src     Reverb Comb Address 1 Left
  1F801DDAh rev0D mRCOMB1 src     Reverb Comb Address 1 Right
  1F801DDCh rev0E mLCOMB2 src     Reverb Comb Address 2 Left
  1F801DDEh rev0F mRCOMB2 src     Reverb Comb Address 2 Right
  1F801DE0h rev10 dLSAME  src     Reverb Same Side Reflection Address 2 Left
  1F801DE2h rev11 dRSAME  src     Reverb Same Side Reflection Address 2 Right
  1F801DE4h rev12 mLDIFF  src/dst Reverb Different Side Reflect Address 1 Left
  1F801DE6h rev13 mRDIFF  src/dst Reverb Different Side Reflect Address 1 Right
  1F801DE8h rev14 mLCOMB3 src     Reverb Comb Address 3 Left
  1F801DEAh rev15 mRCOMB3 src     Reverb Comb Address 3 Right
  1F801DECh rev16 mLCOMB4 src     Reverb Comb Address 4 Left
  1F801DEEh rev17 mRCOMB4 src     Reverb Comb Address 4 Right
  1F801DF0h rev18 dLDIFF  src     Reverb Different Side Reflect Address 2 Left
  1F801DF2h rev19 dRDIFF  src     Reverb Different Side Reflect Address 2 Right
  1F801DF4h rev1A mLAPF1  src/dst Reverb APF Address 1 Left
  1F801DF6h rev1B mRAPF1  src/dst Reverb APF Address 1 Right
  1F801DF8h rev1C mLAPF2  src/dst Reverb APF Address 2 Left
  1F801DFAh rev1D mRAPF2  src/dst Reverb APF Address 2 Right
  1F801DFCh rev1E vLIN    volume  Reverb Input Volume Left
  1F801DFEh rev1F vRIN    volume  Reverb Input Volume Right
```
All volumes S16; all src/dst/disp/base addresses in SPU RAM /8; src/dst relative to current buffer address; disp relative to src; mBASE defines start (end fixed at 7FFFEh); writing mBASE sets the current buffer address. Formula (verbatim; memory writes saturated to ±8000h..7FFFh; products /8000h; run one 22050Hz step per pass; hardware alternates L/R on successive 44100Hz cycles):
```
  Lin = vLIN * LeftInput    ;from any channels that have Reverb enabled
  Rin = vRIN * RightInput
  [mLSAME] = (Lin + [dLSAME]*vWALL - [mLSAME-2])*vIIR + [mLSAME-2]  ;L-to-L
  [mRSAME] = (Rin + [dRSAME]*vWALL - [mRSAME-2])*vIIR + [mRSAME-2]  ;R-to-R
  [mLDIFF] = (Lin + [dRDIFF]*vWALL - [mLDIFF-2])*vIIR + [mLDIFF-2]  ;R-to-L
  [mRDIFF] = (Rin + [dLDIFF]*vWALL - [mRDIFF-2])*vIIR + [mRDIFF-2]  ;L-to-R
  Lout=vCOMB1*[mLCOMB1]+vCOMB2*[mLCOMB2]+vCOMB3*[mLCOMB3]+vCOMB4*[mLCOMB4]
  Rout=vCOMB1*[mRCOMB1]+vCOMB2*[mRCOMB2]+vCOMB3*[mRCOMB3]+vCOMB4*[mRCOMB4]
  Lout=Lout-vAPF1*[mLAPF1-dAPF1], [mLAPF1]=Lout, Lout=Lout*vAPF1+[mLAPF1-dAPF1]
  Rout=Rout-vAPF1*[mRAPF1-dAPF1], [mRAPF1]=Rout, Rout=Rout*vAPF1+[mRAPF1-dAPF1]
  Lout=Lout-vAPF2*[mLAPF2-dAPF2], [mLAPF2]=Lout, Lout=Lout*vAPF2+[mLAPF2-dAPF2]
  Rout=Rout-vAPF2*[mRAPF2-dAPF2], [mRAPF2]=Rout, Rout=Rout*vAPF2+[mLAPF2-dAPF2]
  LeftOutput  = Lout*vLOUT
  RightOutput = Rout*vROUT
  BufferAddress = MAX(mBASE, (BufferAddress+2) AND 7FFFEh)
```
Addresses wrap within mBASE..7FFFEh (works only for large mBASE: ≥60000h safe, 48000h seems stable; low mBASE can mis-trigger IRQs — verbatim caution). Left/Right halves are contiguous blocks (L,L,L,…,R,R,R — *not* interleaved). SPUCNT.bit7=0 stops writes but not reads (vAPF1/vAPF2 zero skips stages; SAME/DIFF stages skipped). vIIR=−8000h negates the final result (bug). One shipped preset (Room, buffer size 26C0h bytes; register rows DC0..FE) — verbatim:
```
  007Dh,005Bh,6D80h,54B8h,BED0h,0000h,0000h,BA80h
  5800h,5300h,04D6h,0333h,03F0h,0227h,0374h,01EFh
  0334h,01B5h,0000h,0000h,0000h,0000h,0000h,0000h
  0000h,0000h,01B4h,0136h,00B8h,005Ch,8000h,8000h
```
(Studio Small/Medium/Large presets: see nocash §Reverb Examples L4512–4619. Also initialize 1F801D84h/86h, EON, SPUCNT, zero-fill buffer, and set 1F801DACh — "For whatever reason, one MUST also initialize Port 1F801DACh".)

## 11. CD input path — XA-ADPCM decode [§CDROM XA Subheader L7834–7948; §XA Audio ADPCM L7949–8202, verbatim]
Form2 data area = 914h bytes; **12h (18) chunks of 128 bytes** = 900h, trailing 14h (20) bytes = 00h padding. Each 128-byte portion: 16-byte header + 28 data words (4 bytes each, little endian):
```
  00h..03h  Copy of below 4 bytes (at 04h..07h)
  04h       Header for 1st Block/Mono, or 1st Block/Left
  05h       Header for 2nd Block/Mono, or 1st Block/Right
  06h       Header for 3rd Block/Mono, or 2nd Block/Left
  07h       Header for 4th Block/Mono, or 2nd Block/Right
  08h..0Bh  Headers for blocks 5-8 (unknown/unused for 8bit ADPCM)
  0Ch..0Fh  Copy of above 4 bytes (at 08h..0Bh)
```
Header byte: bits0-3 Shift (0=loudest, 12 max useful, 13..15 act as 9); bits4-5 Filter (0..3 — XA has only four filters); bits6-7 zero. Data word nibble packing (4-bit mode): four 4-bit nibbles per word — nibbles for [1st blk Mono|1st blk Left, 2nd blk Mono|1st blk Right, 3rd blk Mono|2nd Left, 4th blk Mono|2nd Right] at bit groups 0-3/4-7/8-11/12-15 (values −8h..+7h); 8-bit mode = four bytes per word ([1st L,1st R,2nd L,2nd R] pattern at bits 0-7/8-15/16-23/24-31).
Decode (verbatim):
```
  shift  = 12 - (src[4+blk*2+nibble] AND 0Fh)
  filter =      (src[4+blk*2+nibble] AND 30h) SHR 4
  f0 = pos_xa_adpcm_table[filter]
  f1 = neg_xa_adpcm_table[filter]
  for j=0 to 27
    t = signed4bit((src[16+blk+j*4] SHR (nibble*4)) AND 0Fh)
    s = (t SHL shift) + ((old*f0 + older*f1+32)/64)
    s = MinMax(s,-8000h,+7FFFh)
    halfword[dst]=s, dst=dst+2, older=old, old=s
  next j
```
```
  pos_xa_adpcm_table[0..4] = (0, +60, +115, +98, +122)
  neg_xa_adpcm_table[0..4] = (0,   0,  -52, -55,  -60)
```
Sector walk (verbatim): skip sync(12)+header(4)+subheader(8); for each of 12h portions × blk 0..3: stereo→left from nibble0 + right from nibble1; mono→two 28-sample runs from nibbles 0 and 1; advance 128 bytes; skip 14h+4 (padding+EDC). Subheader bytes (verbatim): FN = file number; CN bits0-4 = channel (bits5-7 zero); **Submode (SM)** bit0 EOR, bit1 Video, bit2 Audio, bit3 Data, bit4 Trigger, bit5 **Form2** (914h data), bit6 RealTime, bit7 EOF; **Codinginfo (CI)** bits0-1 Mono/Stereo (0=mono,1=stereo), **bit2 Sample Rate (0=37800Hz,1=18900Hz)**, bits4-5 Bits/Sample (0=4bit,1=8bit), bit6 Emphasis, bit7 reserved.
- 37800Hz→44100Hz conversion: hardware **25-point zigzag interpolation** (six-step counter; one extra 44.1k sample inserted per six 37.8k samples; counter uninitialized at power-up between sectors) — nocash reproduces seven tables + algorithm at L8130–8201 (not quoted here; fetch from the cited range).
- Interleave conventions (verbatim): 1/1 = 44.1k CD-DA; 1/8 = 37.8k stereo @2x; 1/16 = 18.9k stereo @2x; 1/16 = 37.8k mono @2x; 1/32 = 18.9k mono @2x.
- XA-ADPCM emphasis: unused by known games; formula unknown.
*(Output format: all SPU inputs/outputs are signed 16-bit at 44.1kHz; reverb runs at 22.05kHz.)*

## Sources
- [PSX-SPX — Sound Processing Unit (SPU)](https://problemkaputt.de/psx-spx.htm#soundprocessingunitspu) — plus [§CDROM XA Audio ADPCM Compression](https://problemkaputt.de/psx-spx.htm#cdromxaaudioadpcmcompression), [§CDROM XA Subheader](https://problemkaputt.de/psx-spx.htm#cdromxasubheaderfilechannelinterleave), [§DMA Channels](https://problemkaputt.de/psx-spx.htm#dmachannels) — **Credibility:** canonical spec, vendored locally; **Relevance:** full register map, ADSR, gauss table, ADPCM/XA formats, reverb unit; **Sufficiency:** complete except: CDROM-side reverb? none — the 25-point zigzag tables are only referenced (L8130–8201) and SPU unknown registers (L4620–4664) not transcribed.

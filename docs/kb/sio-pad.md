# SIO0 controller-port protocol

Source: nocash PSX-SPX https://problemkaputt.de/psx-spx.htm — § Controllers and
Memory Cards chapter (vendored `docs/raw/psx-spx.htm` line refs). [verbatim] = copied
unmodified. Repo check target: `src/core/pad.ts`, seam `src/core/bus.ts`/`src/core/system.ts`.

## 1. Register map (exact addresses)
[verbatim] § I/O Map Peripheral I/O Ports (`#iomap`), L190–L196:
```
  1F801040h 1/4  JOY_DATA Joypad/Memory Card Data (R/W)
  1F801044h 4    JOY_STAT Joypad/Memory Card Status (R)
  1F801048h 2    JOY_MODE Joypad/Memory Card Mode (R/W)
  1F80104Ah 2    JOY_CTRL Joypad/Memory Card Control (R/W)
  1F80104Eh 2    JOY_BAUD Joypad/Memory Card Baudrate (R/W)
```
(The brief's "CTRL/STAT/BAUD at 044/048/4A??" corrects to: STAT=044, MODE=048, CTRL=04A,
BAUD=04E.) IRQ line: I_STAT bit7 = IRQ7 = controller/memcard byte-received
(§ Interrupts, verbatim L4677): "IRQ7 Controller and Memory Card - Byte Received Interrupt".

## 2. DATA / STAT / MODE / CTRL / BAUD
[verbatim] § Controller and Memory Card I/O Ports (`#controllerandmemorycardioports`),
L31479–L31605:
```
JOY_DATA W: 0-7 data to send (writes start transfer when TXEN & STAT.2 ready; TXEN value
  is latched per-write); R: 0-7 received byte (+ 3-entry preview at bits 8-31; read via
  8-bit access when JOY_STAT.1=1).
JOY_STAT R: 0 TX Ready(1=Ready/Started) | 1 RX FIFO Not Empty | 2 TX Ready(1=Finished) |
  3 RX Parity Error (sticky) | 7 /ACK Input Level (0=High,1=Low) |
  9 Interrupt Request (0=None,1=IRQ7; sticky) | 11-31 Baud rate timer (21-bit, ÷33MHz).
JOY_MODE (usually 000Dh): bit0-1 baud factor (1=MUL1,2=MUL16,3=MUL64), bit2-3 width
  (3=8bits), bit4 parity en, bit8 CLK output polarity.
JOY_CTRL (usually 1003h, 3003h, 0000h):
  0 TXEN (1=Enable) | 1 /JOYn output (1=Low=Select) | 2 RXEN (0=normal /JOYn=low, 1=force
  once) | 4 Acknowledge W (1=reset JOY_STAT.3 and .9) | 6 Reset W (1=reset JOY regs) |
  8-9 RX IRQ mode (IRQ when 1/2/4/8 bytes in RX fifo) |
  10 TX IRQ enable | 11 RX IRQ enable | 12 ACK IRQ enable (when STAT.7 low) |
  13 desired slot (0=/JOY1, 1=/JOY2).
JOY_BAUD (usually 0088h): 0-15 reload; BPS=(44100Hz*300h)/MAX((Reload*Factor) AND NOT 1,1);
  default factor MUL1 → CLK low 44h cycles + high 44h cycles ≈ 250 kHz per bit.
```
Slot-select caution [verbatim]: after select, delay before first byte — digital pads may
work without it; kernel waits >2000 cycles. RXEN: hardware auto-receives when /JOYn low;
keep RXEN normally 0.

## 3. Transfer sequence (digital pad)
[verbatim] § Controllers - Communication Sequence (`#controllerscommunicationsequence`),
L31913–L31925:
```
  Send Reply Comment
  01h  Hi-Z  Controller Access (unlike 81h=Memory Card access), dummy response
  42h  idlo  Receive ID bit0..7 and Send Read Command (ASCII "B")
  TAP  idhi  Receive ID bits8..15 (usually/always 5Ah)
  MOT  swlo  Receive Digital Switches bit0..7
  MOT  swhi  Receive Digital Switches bit8..15
  --- transfer stops here for digital pad ---
  (further 00h dummy sends collect mouse/analog-stick adc0..3 bytes)
```
So a digital pad reads with `01h 42h TAP(=00h) 00h 00h` and replies: (Hi-Z/dummy), ID-lo,
5Ah, buttons-lo, buttons-hi. First-byte per device [verbatim]: 01h=Standard Controller,
21h=Yaroze card, 41h=I-Mode cable, 81h=Standard Memory Card (first byte selects device;
its response byte is Hi-Z/ignore). Pad signal notes [verbatim]: LSB-first; peripheral
outputs on falling edge, PSX reads at rising edge of shift clock; 250 kHz clock; no ACK
after the last byte; ACK width >2 µs; PSX treats no-ACK-within-100µs as no device;
16 ms between SEL activations.
Controller ID halfword `[verbatim]`: 5A41h=digital pad (analog in digital mode), 5A73h
analog pad; InitPad buffer byte ID1 = 41h digital. Multitap: third command byte 01h
(`01 42 01 00..` long response; ID 5A80h).

## 4. Button bits (wire) and the repo model
[verbatim] § Controllers - Standard Digital/Analog Controllers (`#controllersstandard
digitalanalogcontrollers`), L32000–L32020 — Halfword 1 "Digital Switches", all
`(0=Pressed, 1=Released)`:
```
  0 Select  1 L3  2 R3  3 Start  4 Up  5 Right  6 Down  7 Left
  8 L2      9 R2  10 L1 11 R1   12 Triangle( /\) 13 Circle(()) 14 Cross(><) 15 Square([])
```
`src/core/pad.ts` `PadButton` constants (Select=0x0001 … Square=0x8000) match this bit
order exactly; the file's comment (wire is active-low, state is 1=pressed, SIO layer
inverts when answering) is confirmed by the `(0=Pressed...)` semantics above.

## 5. ACK / IRQ7 timing and acknowledgement
[verbatim] § I/O Ports "(/IRQ7) Byte Received Interrupt" L31563–L31573:
- IRQ7 fires after a received byte, only if the peripheral pulsed /ACK ("more-data-request";
  NOT after the last byte of a transfer). /ACK pulse ≈100 CPU-clock cycles long.
- I_STAT.7 is edge-triggered and can be acked in either order relative to JOY_STAT.9;
  JOY_STAT.9 is NOT edge-triggered: it cannot be acknowledged while external /ACK is still
  low — first wait JOY_STAT.7=0, then set JOY_CTRL.4=1.
- § Interrupts acknowledge order [verbatim L4694-L4697]: clear I_STAT bit first, then the
  device port bit — reversed order permanently loses future edges.
- Emulation note [verbatim]: "After sending a byte, the Kernel waits 100 cycles or so, and
  does THEN acknowledge any old IRQ7, and does then wait for the new IRQ7. Due to that
  bizarre coding, emulators can't trigger IRQ7 immediately within 0 cycles after sending
  the byte." → debounce IRQ7 by ≥1-2 µs (or emulate the kernel's polling rhythm) in the SIO
  agent.

## 6. Kernel/libpad-style polling (InitPad path)
[verbatim] § BIOS Joypad Functions (`#biosjoypadfunctions`), L41406–L41450:
- B(12h) InitPad(buf1,22h,buf2,22h): stores buffer addresses, zero-fills them (22h bytes
  each), initializes the PadCardIrq element (not yet enqueued), sets the pad-enable flag.
  Buffer format: 00h status (00h=ok, FFh=timeout/wrong ID2), 01h ID1 (41h=digital pad…),
  02h..21h data (max 16 halfwords depending on ID1 low-4 bits).
- B(13h) StartPad enqueues PadCardIrq; B(14h) StopPad dequeues (also stops cards, shared
  handler); pad data for both ports is read on each VBLANK interrupt while pad_enable;
  handler stores up to 22h bytes per buffer.
- InitPad zero-fill gotcha [verbatim]: until the first IRQ, status=00h with buttons 0000
  (=all pressed); set status byte to FFh or reject ID1=00h.
- B(5Bh) ChangeClearPad(int) affects pad AND card IRQ behavior [verbatim].
- The "Outdated" pad API B(15h/B(16h)) exists but is broken (see verbatim section) — use
  InitPad/StartPad.

## 7. Memory-card interplay / pad-only behavior
[verbatim, § Controller Misc + § BIOS Memory Card Functions]: file accesses use device
"bu00:" (slot1)/"bu10:" (slot2) after InitCard(pad_enable), StartCard, _bu_init;
InitCard(pad_enable) decides whether pads stay handled together with memcards. No card
inserted → bu I/O times out; get/wait_card_status returns 11h=failed/timeout or
21h=general error; async completion events are the card-event table in kb/kernel.md §4.
The shared /ACK line and SEL timing are per the notes in §3 (also: mouse power-up holds
/ACK low until first access — relevant only if emulating other devices; PSX expects a
timeout when no ACK within 100 µs).

## 8. What a game must configure (summary for the pad agent)
MODE=000Dh (8-bit, no parity, MUL1), BAUD=0088h (~250 kHz), CTRL slot-select + delays,
then per byte: write TX while STAT.2 ready, wait STAT.1 → read RX, wait /ACK release
(STAT.7) → write CTRL.4 to clear STAT.9, then clear I_STAT.7 (correct order per §5), read
the ID 5A41h + button halfword, invert bits for internal 1=pressed state (per repo model),
leave the next transfer pending until /ACK pulses arrive. IRQ7 per byte except the last
per transfer.
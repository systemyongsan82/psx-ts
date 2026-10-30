# HLE BIOS/kernel — wiring notes for integration (BIOS agent)

Files created (BIOS-owned): `src/core/bios.ts`, `src/core/bios.test.ts`,
`src/core/kernel/layout.ts`, `src/core/kernel/ramImage.ts`, `src/core/kernel/events.ts`,
`src/core/kernel/files.ts`, `src/core/kernel/intr.ts`, `src/core/kernel/cnf.ts`,
`src/core/kernel/strmem.ts`. No other files were touched.

## 1. CPU seam — contracts the BIOS relies on (top-level to verify)

- Guard is exactly `pc ∈ {0xA0, 0xB0, 0xC0, 0xD0}` per top-level note. The BIOS also
  tolerates (defensively, never required) `pc` in the jump-table window `[0x200,0x500)`
  and sentinel windows `[0x580,0x6F8)` / `[0x700,0x778)`.
- **`kuserCall(pc)` returning `false` must make the CPU continue at `RA` of the
  intercepted state** (BIOS call = call-like: the stub returns to ra), not `pc+4`.
  With `pc+4` semantics the game flow would fall through the stub junk. Returning
  `true` means "I redirected": continue at `core.pc()`.
- **exception('interrupt') return: CPU must resume from `core.pc()`** — the BIOS may
  have redirected into the first pending callback (`ra=0xD0`, kernel stack).
- **exception('syscall')**: BIOS writes v0; the CPU continues after the syscall and
  must do the nocash `SR.bit0 := SR.bit2` copy on return (this is what makes
  Enter/ExitCriticalSection actually gate delivery).
- **suspend()/resume()**: while suspended, time must still pass (cpu.run returning the
  budget, or the system loop advancing the scheduler). WaitEvent blocking relies on
  this plus a one-frame scheduler fallback resume.

## 2. system.ts wiring requests (all one-liners)

```
after constructing this.bios:
  this.bios.padInput = this.pad;
  this.bios.hwRead32 = (addr) => this.bus.load32(addr);
  this.bios.hwWrite32 = (addr, value) => this.bus.store32(addr, value);
in boot(), before cpu.reset:
  this.bios.applyMemoryControl();          // kb §8 memory-control defaults via hooks
in boot(), after this.cpu.reset(info.entryPc):
  setReg(4, 1); setReg(5, 0); setReg(7, 0x2A);      // boot args (nocash boot state)
  setReg(8, info.sp); setReg(30, info.sp);          // t0/fp = SYSTEM.CNF stack
  setReg(11, info.entryPc); setReg(15, 0x1F801800); // t3 = entry, t7 = CDROM base
  (gp/r28 = info.gp is already wired)
```

## 3. RAM image (all bios-written, physical addresses)

| range | meaning |
|---|---|
| 0x0000-0x000F | garbage copy: words `[3, 0x275A0C80, 0x03400008, 0]` (word0 smashed per nocash) |
| 0x0080-0x008F | exception handler stub `3C1A0000/275A0C80/03400008/00000000` (C(07h) overwrites 0x00 and 0x80 with safe `jr ra` stubs) |
| 0x00A0/0xB0/0xC0 | 16-byte stubs: `jr ra; nop; nop; nop` (safe even if executed) |
| 0x00D0 | callback-return sentinel: `j 0xD0` self-loop |
| 0x0100-0x157 | Table of Tables: ExCB@E000(0x20), PCB@E020(0x04), TCB@E030(4×C0), EvCB@E340(22×1C), FCB@D340(16×2C), DCB@D000(10×50) — base+size pairs |
| 0x0180-0x1FF | command line, `cdrom:SLUS_001.70;1` + NUL, rest zero |
| 0x0200-0x4FF | A jump table, 96 slots × 2 words: slot = self address + `jr ra` |
| 0x0580-0x6F7 | per-B-function sentinels (B0 table entries point here) |
| 0x0700-0x777 | per-C-function sentinels (C0 table entries point here) |
| 0x0780 | GetC0Table table (0x1E entries → sentinels) |
| 0x0900 | GetB0Table table (0x5E entries → sentinels) |
| 0x09C0 | default Exit structure (ReturnFromException @0xD0, stacktop-4, zeros) |
| 0x8920-0xBFFF | alloc_kernel_memory bump heap |
| 0xC000-0xCFFF | kernel exception stack (callback sp walks down per 0x400 step, max depth 4) |
| 0xD000-0xD31F | DCBs (0=cdrom, 1=bu, 2=tty; name ptrs into 0xD720 strings) |
| 0xD340-0xD5FF | FCBs (fd 0/1 reserved for stdio; game fds start at 2) |
| 0xE000-0xE49F | ExCBs/PCB/TCBs/EvCBs mirrored from TS state |

Sentinel words are self-addresses (deref+call is safe) followed by `jr ra`; **without
a CPU guard over those windows a call through a B0/C0-table entry executes the
self-pointer as a harmless sll and returns immediately (v0 untouched)** — degraded but
crash-free; full dispatch there only works if the guard is ever extended.

## 4. Semantics adopted

- Calling convention: fn number in R9; args r4..r7; result v0 (r2). Unknown fns log +
  return 0.
- Event state: nocash statuses (0 free/1000 disabled/2000 busy/4000 ready), modes
  (1000 callback/2000 flag); DeliverEvent touches BUSY events only; TestEvent
  ready→busy returns 1; WaitEvent: disabled→0, ready→1 (flips busy), busy→block;
  Enable/Disable/Close always return 1; UnDelivery flips ready→busy for mode 2000h.
- 5 internal CD events occupy EvCB slots 0..4 (class F0000003h, specs
  10h/20h/40h/80h/8000h, mode 2000h); game events start at handle F1000005h.
- IRQ chains (head = highest priority, inserted via unshift): 0=[cdDma, cdIo,
  syscall], 1=[card, vblank, timer2, timer1, timer0], 2=[padcard], 3=[defint]; game
  nodes (SysEnqIntRP) go to chain head; fn2 runs when fn1 returns v0≠0. Kernel
  internal handlers run inline (DeliverEvent calls without CPU round-trip); game
  handlers run as callbacks (saved ctx, ra=0xD0, kernel stack). Nested interrupts are
  dropped (nocash: no nested exceptions — lines stay pending and re-enter).
- Delivery map (exact per nocash): IRQ0→F0000001h+1000h, IRQ1→F0000002h, IRQ2→F0000003h,
  IRQ3→F0000004h, IRQ4→F0000005h, IRQ5/6→F0000006h (same event, nocash bug), IRQ7→F0000008h,
  IRQ8→F000000Bh, IRQ9→F0000009h; timer/vblank: F2000000-2h,2 for IRQ4/5/6 and
  F2000003h,2 for IRQ0.
- SYS(01h/02h): clear/set SR bits 2+10; SYS(01h) returns 1 only if both were set;
  SYS(04h+) delivers F0000010h,4000h; BRK + address/bus errors: F0000010h,1000h then
  suspend (or run the listener as a callback).
- File: FCB handles 0..15 with 0/1 reserved for stdio; device prefixes case-SENSITIVE
  (`cdrom` accepted, `cdrom0:`-style port tolerated, `buNN:`, `tty*`/`duart`);
  `;version` stripped (iso layer already normalizes lower-case + `;` + slashes).
  FileRead = whole-length sync read via `CdRomHle.readIntoRam` (fpos advances),
  FileWrite→0 on cdrom, FileIoctl→-1 with error 16h, seektype 0/1 exact, seektype 2
  treated as from-start (nocash: buggy), fpos not clamped (nocash: unchecked).
- Pad: InitPad zero-fills and sets status FF; on vblank (chain 2) buffers get
  `[0]=00h ok, [1]=41h, [2..3]=~buttons lo/hi` (wire active-low convention);
  without `padInput` wired, status stays FF (timeout) and a warn is logged once.
  OutdatedPad* writes `buttons` (pressed=1) to the stored dest each vblank.
  get/wait_card_status return 0x11 (no card) without blocking.
- Boot: SYSTEM.CNF (hex values, `0X` prefix allowed) → SetConf-equivalent rebuild;
  exe via `cd.findFile` + `readFileBytes(path,0,2048)` → `parsePsExe`/`planExeLoad` →
  `readIntoRam(lba, 2048, loadSize, ram, loadAddr)` (payload starts at file byte
  2048 — verified against `src/disc/cdrom.ts`), memfill-zero when nonzero, FlushCache
  no-op; SYSTEM.CNF STACK wins over the exe SP fields.
- cd-async glue (A 78h/7Ch/7Eh/81h/88h/90h..95h): minimal — record, schedule a
  completion via the scheduler, deliver F0000003h with 20h (seek/complete), 10h
  (read-done/ack); read writes sector data through `readIntoRam` from the last seek
  LBA. All marked UNVERIFIED — RE's boot path uses synchronous FileOpen/FileRead.

## 5. Coverage summary

A-table: 00-3F mostly full (files, exit, libc string/memory/numbers: real
implementations; atof/strtod deliberately return 0 like the missing-COP1 hardware,
qsort/lsearch/bsearch return 0 with a log, SaveState/RestoreState store Exit-format
regs), 40-53 (SystemError family, LoadExeHeader/File/DoExecute, FlushCache,
init_a0_b0_c0_vectors, GPU helpers stubbed), 54-72 (CdInit/_bu_init/CdRemove/tty/card
dev stubs), 78/7C/7E/81/88 (cd-async minimal), 90-95, 96-9F (Add*, SetConf/GetConf,
SetCdromIrqAutoAbort, SetMemSize), A0-A3 (DTL warn, Enqueue/DequeueCdIntr).
B-table: 00-20 (alloc/free, timer API via hw hooks, events, threads via TCB slots,
pad API, ReturnFromException + exit-hook struct, UnDeliverEvent), 21-31 SystemError
family (fail-loud), 32-3F alias to A(00..09)/A(3B..3E) incl. tty stdio, 40-59
(chdir/firstfile/nextfile/rename/delete/undelete/format/Add/Remove devices,
InitCard-family error paths, Krom2 → FFFFFFFF, GetLastError/GetLastFileError,
GetC0Table/GetB0Table, get_bu_callback_port, testdevice, 5A SystemError,
ChangeClearPad, get/wait_card_status → 11h), 5E+ → 0.
C-table: 00-1D all handled (chains, free-slot probes, ExceptionHandler → 0x80000080,
InstallExceptionHandlers, SysInitMemory logged, SysInitKernelVariables,
ChangeClearRCnt, SystemError, InitDefInt, SetIrqAutoAck, devices/tty/ioabort,
card-find-mode, KernelRedirect, AdjustA0Table), 1E-7F → 0, 80+ mirrors B.

## 6. Integration risks (ranked)

1. **CPU false-return = RA** (§1) — a mismatch breaks every BIOS call made outside an
   exception context (i.e. the whole game).
2. **SR bit2→bit0 copy on syscall return** — otherwise critical sections don't gate
   IRQ delivery and RE may race its own frame handlers.
3. **Time passing while suspended** — WaitEvent's one-frame fallback otherwise can
   never run (hard deadlock visible as: bios logs `WaitEvent`, then nothing).
4. **Callback arg order** — event callbacks get `(r4=class, r5=spec)`; if RE's
   handlers expect `(spec, class)`, flip the two `setReg` calls in
   `CallbackRunner.startEvent` (single place, src/core/kernel/intr.ts).
5. **padInput wiring** — forgetting the one-liner leaves pad bytes = timeout FF; RE
   menus won't respond silently.
6. DefInt F0000006h reuse for IRQ5+IRQ6 is faithful to nocash (deliberate).
7. A(45h)/SetConf at runtime rewrites the kernel image (cmdline zeroed, events
   rebuilt) — faithful enough to nocash; RE should not hit this after boot.
8. Direct EvCB/FCB RAM writes by the game are not watched; TS state stays
   authoritative.
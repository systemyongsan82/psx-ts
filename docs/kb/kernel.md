# PS-X BIOS / Kernel

Source: nocash PSX-SPX, https://problemkaputt.de/psx-spx.htm — vendored verbatim in this
repo at `docs/raw/psx-spx.htm`. Citations give the psx-spx section name, its `#anchor`
fragment for the canonical URL, and the vendored line range `docs/raw/psx-spx.htm Ln..m`.
Text inside `pre`-fenced blocks and tables marked **[verbatim]** is copied unchanged;
everything else is condensed from the same source. Cross-references: `docs/re-notes.md`
(disc facts, marked [disc]), `src/core/bios.ts` (HleBios seam).

## 1. Calling convention
[verbatim] § BIOS Function Summary (`#biosfunctionsummary`), L39904–L39926:
- Arguments in R4,R5,R6,R7,[SP+10h],[SP+14h],etc. (a0..a3, then stack).
- Caller must allocate N words on the stack even for register-passed params; callee may
  use/destroy [SP+0..N*4-1].
- Functions may destroy R1-R15, R24-R25, R31(RA), HI/LO. R16-R23, R29(SP), R30(FP) must be
  preserved. R26(K0) reserved for the exception handler. R27(K1)/R28(GP) effectively free.
- Return value in R2 (V0).
- "A-Functions (Call 00A0h with function number in R9 Register)" — same for B (00B0h) and
  C (00C0h); the function number goes in R9/T1 (a fourth hidden argument).

## 2. RAM call-stub layout and dispatch (0x00A0 / 0x00B0 / 0x00C0)
[verbatim] § BIOS Memory Map → BIOS RAM Map (`#biosmemorymap`), L39858–L39872:
```
  00000080h 10h    Exception vector (actually in KSEG0, ie. at 80000080h)
  00000090h 10h    Unused/reserved
  000000A0h 10h    A(nnh) Function Vector
  000000B0h 10h    B(nnh) Function Vector
  000000C0h 10h    C(nnh) Function Vector
  000000D0h 30h    Unused/reserved
  00000100h 58h    Table of Tables (BIOS Control Blocks) (see below)
  00000158h 28h    Unused/reserved
  00000180h 80h    Command line argument from SYSTEM.CNF; BOOT = fname argument
  00000200h 300h   A(nnh) Jump Table
  00000500h ...    Kernel Code/Data (relocated from ROM)
```
[verbatim] § BIOS Internal Boot Functions (`#biosinternalbootfunctions`), L42083–L42086:
- A(45h) init_a0_b0_c0_vectors: "Copies the three default four-opcode handlers for the
  A(NNh),B(NNh),C(NNh) functions to A00000A0h..A00000CFh."
- C(07h) InstallExceptionHandlers(): copies the default four-opcode exception handler to
  80000080h..8000008Fh, and also to 80000000h..8000000Fh.

Mechanism ([inference beyond nocash's wording]: each stub is a 4-opcode, 16-byte dispatcher
at the fixed call address 0xA0/0xB0/0xC0 (mirrored from ROM by A(45h)); the dispatched
function number arrives in R9/T1 and selects one 8-byte entry from the per-A-table jump
table at 0x00200 (0x300 bytes = 96 entries; covers A(00h)..A(5Fh); the retail table only
needs A(00h)..A(9Fh) — see § 3). psx-spx does **not** disassemble the stub opcodes nor list
per-function ROM addresses; that data must come from a BIOS disassembly if ever needed
(marked [gap]). C(1Ch) AdjustA0Table() [verbatim, L42107–L42109]: "Copies the B(32h..3Bh)
and B(3Ch..3Fh) function addresses to A(00h..09h) and A(3Bh..3Eh)" — which is why the
tables below show A(00h)↔B(32h) etc. as the same functions.

## 3. BIOS function tables (complete, verbatim)
§ BIOS Function Summary (`#biosfunctionsummary`). A-table L39944–L40128:

| fn | name | | fn | name |
|---|---|---|---|---|
| A(00h) | FileOpen(filename,accessmode)  (=B(32h)) | A(50h) | SystemError |
| A(01h) | FileSeek(fd,offset,seektype)   (=B(33h)) | A(51h) | LoadAndExecute(filename,stackbase,stackoffset) |
| A(02h) | FileRead(fd,dst,length)        (=B(34h)) | A(54h)/A(71h) | CdInit() |
| A(03h) | FileWrite(fd,src,length)       (=B(35h)) | A(55h)/A(70h) | _bu_init() |
| A(04h) | FileClose(fd)                  (=B(36h)) | A(56h)/A(72h) | CdRemove() |
| A(05h) | FileIoctl(fd,cmd,arg)          (=B(37h)) | A(57h)..A(5Ah) | (return 0) |
| A(06h) | exit(exitcode)                 (=B(38h)) | A(5Bh)..A(5Eh) | dev_tty_init/open/in_out/ioctl |
| A(07h) | FileGetDeviceFlag(fd)          (=B(39h)) | A(5Fh)..A(64h) | dev_cd_open/read/close/firstfile/nextfile/chdir |
| A(08h) | FileGetc(fd)                   (=B(3Ah)) | A(65h)..A(6Fh) | dev_card_open/read/write/close/firstfile/nextfile/erase/undelete/format/rename/clear_error |
| A(09h) | FilePutc(char,fd)              (=B(3Bh)) | A(78h) | CdAsyncSeekL(src) |
| A(0Ah) | todigit(char) | A(7Ch) | CdAsyncGetStatus(dst) |
| A(0Bh)|A(32h) | atof/strtod | A(7Eh) | CdAsyncReadSector(count,dst,mode) |
| A(0Ch) | strtoul(src,src_end,base) | A(81h) | CdAsyncSetMode(mode) |
| A(0Dh) | strtol(src,src_end,base) | A(88h) | CdSetAudioVolume(src) |
| A(0Eh)/A(0Fh) | abs / labs | A(90h) | CdromIoIrqFunc1() |
| A(10h)/A(11h) | atoi / atol | A(91h) | CdromDmaIrqFunc1() |
| A(12h) | atob(src,num_dst) | A(92h) | CdromIoIrqFunc2() |
| A(13h) | SaveState(buf) | A(93h) | CdromDmaIrqFunc2() |
| A(14h) | RestoreState(buf,param) | A(94h) | CdromGetInt5errCode(dst1,dst2) |
| A(15h)-A(1Fh) | strcat,strncat,strcmp,strncmp,strcpy,strncpy,strlen,index,rindex,strchr,strrchr | A(95h) | CdInitSubFunc() |
| A(20h)-A(23h) | strpbrk,strspn,strcspn,strtok | A(96h) | AddCDROMDevice() |
| A(24h) | strstr (buggy) | A(97h) | AddMemCardDevice() |
| A(25h)/A(26h) | toupper / tolower | A(98h) | AddDuartTtyDevice() |
| A(27h)-A(29h) | bcopy,bzero,bcmp (bcmp buggy) | A(99h) | AddDummyTtyDevice() |
| A(2Ah)-A(2Dh) | memcpy,memset,memmove(buggy),memcmp(buggy) | A(9Ch) | SetConf(num_EvCB,num_TCB,stacktop) |
| A(2Eh) | memchr | A(9Dh) | GetConf(num_EvCB_dst,num_TCB_dst,stacktop_dst) |
| A(2Fh)/A(30h) | rand / srand | A(9Eh) | SetCdromIrqAutoAbort(type,flag) |
| A(31h) | qsort(base,nel,width,callback) | A(9Fh) | SetMemSize(megabytes) |

Full verbatim rows for the libc-class A functions (A(0Ah)..A(43h)) are in the source
window L39944–L40109; the table above is complete but compressed. DTL-H2000-only
A(A0h)..A(B4h) (WarmBoot, EnqueueCdIntr, DequeueCdIntr, CdGetLbn, CdReadSector,
CdGetStatus, card callbacks, SetConf etc.) — verbatim at L40108–L40128; retail BIOS
unsupported.

B-table L40130–L40249 (verbatim order):
| fn | name |
|---|---|
| B(00h) | alloc_kernel_memory(size) |
| B(01h) | free_kernel_memory(buf) |
| B(02h) | init_timer(t,reload,flags) |
| B(03h) | get_timer(t) |
| B(04h) | enable_timer_irq(t) |
| B(05h) | disable_timer_irq(t) |
| B(06h) | restart_timer(t) |
| B(07h) | DeliverEvent(class,spec) |
| B(08h) | OpenEvent(class,spec,mode,func) |
| B(09h) | CloseEvent(event) |
| B(0Ah) | WaitEvent(event) |
| B(0Bh) | TestEvent(event) |
| B(0Ch) | EnableEvent(event) |
| B(0Dh) | DisableEvent(event) |
| B(0Eh) | OpenThread(reg_PC,reg_SP_FP,reg_GP) |
| B(0Fh) | CloseThread(handle) |
| B(10h) | ChangeThread(handle) |
| B(12h) | InitPad(buf1,siz1,buf2,siz2) |
| B(13h) | StartPad() |
| B(14h) | StopPad() |
| B(15h) | OutdatedPadInitAndStart(type,button_dest,unused,unused) |
| B(16h) | OutdatedPadGetButtons() |
| B(17h) | ReturnFromException() |
| B(18h) | SetDefaultExitFromException() |
| B(19h) | SetCustomExitFromException(addr) |
| B(20h) | UnDeliverEvent(class,spec) |
| B(32h)..B(3Fh) | = A(00h)..A(09h) and A(3Bh)..A(3Eh) (FileOpen..FilePutc, std_in_getchar, std_out_putchar, std_in_gets, std_out_puts) |
| B(40h) | chdir(name) |
| B(41h) | FormatDevice(devicename) |
| B(42h) | firstfile(filename,direntry) |
| B(43h) | nextfile(direntry) |
| B(44h) | FileRename(old_filename,new_filename) |
| B(45h) | FileDelete(filename) |
| B(46h) | FileUndelete(filename) |
| B(47h) | AddDevice(device_info) |
| B(48h) | RemoveDevice(device_name_lowercase) |
| B(49h) | PrintInstalledDevices() |
| B(4Ah)..B(50h) | InitCard(pad_enable), StartCard, StopCard, _card_info_subfunc, write_card_sector, read_card_sector, allow_new_card |
| B(51h)/B(53h) | Krom2RawAdd / Krom2Offset |
| B(54h)/B(55h) | GetLastError / GetLastFileError(fd) |
| B(56h)/B(57h) | GetC0Table / GetB0Table |
| B(58h) | get_bu_callback_port() |
| B(59h) | testdevice(devicename) |
| B(5Ah) | (SystemError) |
| B(5Bh) | ChangeClearPad(int) |
| B(5Ch)/B(5Dh) | get_card_status(slot) / wait_card_status(slot) |
| B(5Eh)..FFh | N/A (jump_to_00000000h) |

C-table L40256–L40275 (verbatim order):
| fn | name |
|---|---|
| C(00h) | EnqueueTimerAndVblankIrqs(priority)  ;used with prio=1 |
| C(01h) | EnqueueSyscallHandler(priority)      ;used with prio=0 |
| C(02h) | SysEnqIntRP(priority,struc) |
| C(03h) | SysDeqIntRP(priority,struc) |
| C(04h) | get_free_EvCB_slot() |
| C(05h) | get_free_TCB_slot() |
| C(06h) | ExceptionHandler() |
| C(07h) | InstallExceptionHandlers()  ;destroys/uses k0/k1 |
| C(08h) | SysInitMemory(addr,size) |
| C(09h) | SysInitKernelVariables() |
| C(0Ah) | ChangeClearRCnt(t,flag) |
| C(0Bh) | SystemError |
| C(0Ch) | InitDefInt(priority) ;used with prio=3 |
| C(0Dh) | SetIrqAutoAck(irq,flag) |
| C(0Eh)..C(11h) | (return 0; DTL dev_sio_*) |
| C(12h) | InstallDevices(ttyflag) |
| C(13h) | FlushStdInOutPut() |
| C(14h) | (return 0) |
| C(15h)..C(18h) | tty_cdevinput, tty_cdevscan, tty_circgetc, tty_circputc |
| C(19h) | ioabort(txt1,txt2) |
| C(1Ah) | set_card_find_mode(mode) |
| C(1Bh) | KernelRedirect(ttyflag) |
| C(1Ch) | AdjustA0Table() |
| C(1Dh) | get_card_find_mode() |
| C(1Eh)..C(7Fh) | N/A ;C(80h..) mirrors B(00h..) |

Nocash name cross-map to the brief's spellings: "AllocKernelMemory/FreeKernelMemory" =
B(00h)/B(01h) alloc/free_kernel_memory; putc/puts/getc = std_out_putchar/std_out_puts/
std_in_getchar (A(3Bh)..A(3Eh)/B(3Ch)..B(3Fh)) and FileGetc/FilePutc (A(08h)/A(09h));
"SysErr" = A(4Fh)/A(50h) SystemError entries; "change_system" is not a psx-spx name
[no such entry in the vendored file].

SYS/BREAK (§, L40273–L40287):
| idx | action |
|---|---|
| SYS(00h) | NoFunction() |
| SYS(01h) | EnterCriticalSection() — returns 1 if both IRQ-pending bits were set |
| SYS(02h) | ExitCriticalSection() — no return value |
| SYS(03h) | ChangeThreadSubFunction(addr) |
| SYS(04h+) | calls DeliverEvent(F0000010h,4000h) |
| BRK | unresolved: DeliverEvent(F0000010h,1000h) + A(40h) SystemErrorUnresolvedException |

## 4. Events (complete class/spec/mode tables, verbatim)
§ BIOS Event Functions (`#bioseventfunctions`). OpenEvent(class,spec,mode,func) returns
handle "F1000000h and up, or FFFFFFFFh if failed"; events start disabled; call inside a
critical section. Event handles map to the EvCB array: "[verbatim, § BIOS Memory Map
L39896–L39897] File handles (fd=00h..0Fh) can be simply converted as
fcb=[140h]+fd*2Ch. Event handles (event=F10000xxh) as evcb=[120h]+(event AND FFFFh)*1Ch."

Event Classes (Hardware/File/…) `[verbatim]` L41156–L41194:
```
  0000000xh memory card (for file handle fd=x)
  F0000001h IRQ0  VBLANK
  F0000002h IRQ1  GPU
  F0000003h IRQ2  CDROM Decoder
  F0000004h IRQ3  DMA controller
  F0000005h IRQ4  RTC0 (timer0)
  F0000006h IRQ5/IRQ6 RTC1 (timer1 or timer2)
  F0000007h N/A   Not used (this should be timer2)
  F0000008h IRQ7  Controller (joypad/memcard)
  F0000009h IRQ9  SPU
  F000000Ah IRQ10 PIO ;IRQ10 is joypad(lightgun)
  F000000Bh IRQ8  SIO
  F0000010h Exception ;CPU crashed (BRK,BadSyscall,Overflow,MemoryError, etc.)
  F0000011h memory card (lower level BIOS functions)
  F0000012h/F0000013h memory card (not used by BIOS; maybe used by Sony's devkit?)
  F1xxxxxxh event (not used by BIOS; maybe used by Sony's devkit?)
  F2000000h Root counter 0 (Dotclock)                   (hardware timer)
  F2000001h Root counter 1 (horizontal retrace?)        (hardware timer)
  F2000002h Root counter 2 (one-eighth of system clock) (hardware timer)
  F2000003h Root counter 3 (vertical retrace?) (software timer)
  F3xxxxxxh user (not used by BIOS; maybe used by games and/or Sony's devkit?)
  F4000001h memory card (higher level BIOS functions)
  F4000002h libmath (not used by BIOS; maybe used by Sony's devkit?)
  FFxxxxxxh thread (not used by BIOS; maybe used by games and/or Sony's devkit?)
```
Event Specs `[verbatim]` L41196–L41218: 0001h counter becomes zero, 0002h interrupted,
0004h end of i/o, 0008h file was closed, 0010h command acknowledged, 0020h command
completed, 0040h data ready, 0080h data end, 0100h time out, 0200h unknown command,
0400h end of read buffer, 0800h end of write buffer, 1000h general interrupt, 2000h new
device, 4000h system call instruction, 8000h error happened, 8001h previous write error,
0301h/0302h domain/range error (libmath). Event modes `[verbatim]` L41220–L41224:
1000h=execute function/stay busy (callback mode), 2000h=no func/mark ready.

Semantics `[verbatim-condensed]` (L41078–L41155): DeliverEvent(B(07h)) triggers all
enabled/busy events with matching class+spec → callback (mode 1000h) or ready
(mode 2000h); UnDeliverEvent(B(20h)) marks enabled/ready+mode-2000h events back to busy.
WaitEvent(B(0Ah)) returns 0 if disabled, blocks until ready and flips back to busy
(callback-mode events never become ready). TestEvent(B(0Bh)): 0=busy/disabled, 1=ready
(and flags busy again). EnableEvent/DisableEvent/CloseEvent: always return 1.

BIOS-internal events (§ BIOS Event Summary, L41224–L41278): the BIOS internally opens
**five** CDROM events (class F0000003h; spec 10h DMA-finished, 20h, 40h, 80h INT4
end-of-disk, 8000h error); default IRQ handler delivers F0000001h,1000h (VBLANK),
F0000002h,1000h (GPU), … F000000Ah,1000h (IRQ10/Joypad), F000000Bh,1000h (SIO) — flagged
"very unstable, don't use" by nocash; unresolved exceptions deliver F0000010h,1000h/4000h;
memcard async completion is delivered as F0000011h/4 (ok), 100h (busy), 2000h/8000h/8001h
(err); higher-level card events 0000000xh,4 per fd and F4000001h,4/100h/2000h/8000h.
Timer/vblank events: F2000000h,2 Timer0 (IRQ4), F2000001h,2 Timer1 (IRQ5), F2000002h,2
Timer2 (IRQ6), F2000003h,2 Vblank (IRQ0).

SYSTEM.CNF `EVENT=` mapping [verbatim § BIOS Event Functions L41094–L41097]: "The desired
max number of events can be specified in the SYSTEM.CNF boot file (the default is
"EVENT = 10" (which is a HEX number, ie. 16 decimal; of which 5 events are internally used
by the BIOS for CDROM functions …). A bigger amount of events will slowdown
DeliverEvent (which always scans all EvCBs)". This disc declares `EVENT = 16` [disc,
docs/re-notes.md L18] = hex 16 → 22 EvCBs, of which 5 reserved by the BIOS (17 free for
the game) [arithmetic+inference]. `SetConf(num_EvCB,num_TCB,stacktop)` [verbatim, § BIOS
File Execute L40556–L40564] is what bootcode uses to program the SYSTEM.CNF values; it
deallocates ExCBs/EvCBs/TCBs and re-allocates them, then re-enqueues the default handlers.

## 5. Interrupts, exceptions, and the kernel's delivery path
Hardware side [verbatim] § Interrupts (`#interrupts`), L4669–L4700 — I_STAT (1F801070h,
R=active bits, W=write-0-to-clear) / I_MASK (1F801074h): bit0 IRQ0 VBLANK, bit1 GPU
(GP0(1Fh)), bit2 CDROM, bit3 DMA, bit4 TMR0, bit5 TMR1, bit6 TMR2, bit7 Controller/MC
byte-received (IRQ7), bit8 SIO, bit9 SPU, bit10 controller lightpen/PIO. I_STAT is
edge-triggered; IRQ execution happens when (I_STAT AND I_MASK)≠0, cause.bit10 sets, and
SR.bit10+SR.bit0 set; acknowledge order: clear I_STAT bit, THEN device port (e.g.
JOY_CTRL.4=1) — reversed order can permanently swallow IRQs.

COP0 side [verbatim] § COP0 Exception Handling (`#cop0exceptionhandling`): general
exception vector **80000080h** (BEV=0), COP0-break vector 80000040h; RFE is the only
supported cop0 command; CAUSE excode: 00h INT, 04h/05h address errors, 06h/07h bus
errors, 08h Syscall, 09h BP, 0Ah RI, 0Bh CpU, 0Ch Ov. No "0x2C0" vector exists in psx-spx
[searched; the brief's guess is unconfirmed]. GTE hazard [verbatim]: if an IRQ lands on a
cop2cmd, EPC must be advanced by 4 (`if (cause AND 7Ch)=00h … if ([epc] AND
FE000000h)=4A000000h then epc=epc+4`); only newer BIOSes do this reliably.

Kernel side [verbatim] § BIOS Interrupt/Exception Handling (`#biosinterruptexceptionhandling`),
L40899–L41077. The handler at 80000080h is C(06h)-based (patch points at C(06h)+00h/+70h/
+80h/+90h/+A0h are NOP arrays), saves **all** registers in the current TCB, then walks four
priority chains and executes every handler (handler decides relevance; ReturnFromException
(B(17h)) short-circuits lower-priority handlers and restores from the TCB):
```
  Prio   Chain Content
  0      CdromDmaIrq, CdromIoIrq, SyscallException
  1      CardSpecificIrq, VblankIrq, Timer2Irq, Timer1Irq, Timer0Irq
  2      PadCardIrq
  3      DefInt
```
SysEnqIntRP(priority,struc) inserts at chain head; struc = [0]=next, [4]=second function,
[8]=first function (2nd runs if first returns r2≠0), [Ch]=unused. The always-installed
DefaultInterruptHandler (DefInt, priority 3) delivers the F000000xh,1000h events but must
not acknowledge IRQs (SetIrqAutoAck C(0Dh) enables auto-ack per IRQ0..IRQ10 — bugged).
SYS(01h)/SYS(02h): Enter/ExitCriticalSection clear/set SR bit2+bit10; return 1 if both were
set. No nested exceptions; kernel exception stack is fixed 1000h bytes within the first
64KB. C(00h)/C(01h)/C(0Ch) enqueue the default timer/vblank/syscall/DefInt handlers.
B(18h)/B(19h) Set(Default|Custom)ExitFromException control the "exit structure"
(Exit[0]=ReturnFromException, [4]=exception stacktop-4, [8..]=zeroed r16-r23,r28,r30).

Timer APIs [verbatim] § BIOS Timer Functions (`#biostimerfunctions`), L41349–L41405:
init_timer(t,reload,flags) maps flags→[1F801104h+t*10h] mode (bit4→49h else 48h, bit0→+
100h, bit12→+10h); get_timer reads [1F801100h+t*10h]; enable/disable_timer_irq toggle
I_MASK bits 4/5/6 (t=0..2) or 0 (t=3); restart_timer zeroes the counter. ChangeClearRCnt
C(0Ah)(t,flag) chooses whether the kernel's timer/vblank IRQ handler auto-acknowledges
(flag=1: ack + immediate return from exception); returns the old flag.

## 6. TCB / PCB / EvCB / FCB / DCB — layout and SYSTEM.CNF counts
§ BIOS Control Blocks (`#bioscontrolblocks`), L42444–L42511. Control blocks live in
"A000E000h..A000FFFFh" (= RAM 0x0000E000..0x0000FFFF, 8 KB) allocated via SysInitMemory +
alloc_kernel_memory (§ BIOS Memory Allocation, L41633–L41638; FCBs/DCBs are elsewhere at
fixed kernel-variable addresses).
```
EvCB (N blocks of 1Ch): 00h class | 04h status (0=free,1000h=disabled,2000h=enabled/busy,
      4000h=enabled/ready) | 08h spec | 0Ch mode | 10h fn ptr | 14h 8 unused
TCB  (usually 4 blocks of 0C0h): 00h status (1000h=free,4000h=used) | 04h not-used (set
      1000h by OpenThread) | 08h 80h r0..r31 (r0,r26 slots unused) | 88h cop0r14/epc |
      8Ch 8 hi,lo | 94h cop0r12/sr | 98h cop0r13/cause | 9Ch 24h unused
ExCB (4 blocks of 8): 00h ptr to first element of exception chain | 04h zero
PCB  (1 block of 4):  00h ptr to TCB of current thread (PSX has one process)
FCB  (16 blocks of 2Ch): 00h status(0=free else accessmode) | 04h cdrom: disk_id / card:
      port (00h/10h) | 08h transfer addr | 0Ch transfer len | 10h fpos | 14h device flags
      | 18h error | 1Ch ptr to DCB | 20h filesize | 24h start LBA (cdrom:) | 28h fcb #
DCB  (10 blocks of 50h): 00h ptr to lower-case short name ("cdrom","bu","tty") |
      04h device flags (cdrom=14h, bu=14h, tty/dummy=1, tty/duart=3) | 08h sector size
      (cdrom=800h, bu=80h, tty=1) | 0Ch ptr to long name | 10h.. init/open/in_out/close/
      ioctl/read/write/erase/undelete/firstfile/nextfile/format/chdir/rename/remove/
      testdevice function pointers (TTY-only members marked in source)
```
Table-of-Tables bases at 0x100 (ExCB), 0x108 (PCB), 0x110 (TCB, size N*0C0h), 0x120 (EvCB,
size N*1Ch), 0x140 (FCB, fixed), 0x150 (DCB, fixed) — verbatim L39884–L39895.
OpenThread returns thread handles FF000000h..FF000003h (for 4 TCBs) or FFFFFFFFh;
"the desired max number of TCBs can be specified in the SYSTEM.CNF boot file (the default
is 'TCB = 4', one initially used for the boot executable, plus 3 free threads)"
[L41295–L41297 verbatim]. This disc: TCB=4, EVENT=16(hex)=22 [disc].

## 7. exe boot path (A(41h)/A(42h)/A(43h)/A(51h) + SYSTEM.CNF)
§ CDROM File Playstation EXE and SYSTEM.CNF (`#cdromfileplaystationexeandsystemcnf`),
L8847–L8955:
```
SYSTEM.CNF:
  BOOT = cdrom:\abcd_123.45;1 arg   ;boot exe (drive:\path\name.ext;version)
  TCB  = 4                          ;HEX   ;max number of threads
  EVENT = 10                        ;HEX   ;max number of events
  STACK = 801FFF00                  ;HEX   ;(=memtop-256)
```
BOOT filename is case-insensitive (directory stores uppercase), version ;1; optional
command line (up to 128 bytes) is copied to RAM 00000180h. This disc's file:
`BOOT = cdrom:SLUS_001.70;1` / `TCB = 4` / `EVENT = 16` / `STACK = 0X801FFF00` [disc,
docs/re-notes.md L18].

PS-X EXE header (800h bytes at file origin) `[verbatim]` L8886–L8906:
```
  000h-007h ASCII ID "PS-X EXE"
  008h-00Fh Zerofilled
  010h      Initial PC                   (usually 80010000h, or higher)
  014h      Initial GP/R28               (usually 0)
  018h      Destination Address in RAM (= t_addr)
  01Ch      Filesize (must be N*800h)  (= t_size, excludes 800h header)
  020h      Unknown/Unused ;Addr       ;\optional overlay?  (not auto-loaded)
  024h      Unknown/Unused ;Size       ;/
  028h-02Ch Memfill Start Address / Size
  030h      Initial SP base (usually 801FFFF0h, or 0=None)
  034h      Initial SP offset
  038h-04Bh Reserved for A(43h) (RA,SP,R30,R28,R16 saved here)
  04Ch..    "Sony Computer Entertainment Inc. for … area" (NOT verified by BIOS)
  800h..    Code/Data, loaded to [018h] and up
```
Load functions [verbatim-condensed] § BIOS File Execute and Flush Cache
(`#biosfileexecuteandflushcache`), L40495–L40552: A(41h) LoadExeHeader copies header
bytes [10h..4Bh] into headerbuf[00h..3Bh]; A(42h) LoadExeFile additionally loads the body
(using size/dest from the header) and calls FlushCache; A(43h) DoExecute(headerbuf,p1,p2)
saves caller RA/SP/R28/R30/R16 into the header's reserved region, zerofills the memfill
region, sets SP/FP=base+offset (unchanged if base=0), GP from headerbuf, then jumps to the
entry with p1,p2 in R4,R5 (bootcode calls DoExecute(headerbuf,1,0)); A(51h)
LoadAndExecute(filename,stackbase,stackoffset) does LoadExeFile + stack override +
DoExecute and, on return/reload-failure, retries booting the boot file then locks up in a
JMP $ loop. FlushCache: code-cache flush needed after loading code via DMA (BUG: k0
corruption trap possible; load_file/load_exec need IRQ2/IRQ3 unmasked).
Boot-state registers after the boot exe starts [verbatim, § BIOS Boot State, L42515–L42545],
compressed: pc=ExeEntrypoint; r4/a0=1 (boot param1), r5/a1=0, r7/a3=02Ah, r8/t0=r29/sp=
r30/fp=SystemCnfSp (from do_exec, i.e. SYSTEM.CNF STACK), r11/t3=ExeEntrypoint, r15/t7=
1F801800h, r31/ra=RetadrToKernel; SR=40000000h, CAUSE=00000020h, EPC=RetadrFromIrq.
"Before starting the boot executable, the BIOS automatically calls CdInit(), so the game
doesn't need to do any initializations before using CDROM file functions" [verbatim,
§ BIOS CDROM Functions, L40630–L40631].

`t_size == 0` [UNCERTAIN]: psx-spx documents no zero-size variant ("Filesize must be N*800h"
and [020h]/[024h] "not auto-loaded"). This disc's SLUS_001.70 has t_addr=0x8005F8A0,
t_size=0, and nonzero [020h]=0x80010000/[024h]=0x0009F000 [disc] — the repo loader
(src/disc/psxexe.ts `planExeLoad`, per docs/re-notes.md L23) treats [020h]/[024h] as a
second load segment (skip text load when t_size=0, load d_size bytes at d_addr, entry =
pc?pc:t_addr, stack = SYSTEM.CNF). nocash's "(not auto-loaded)" note contradicts that —
resolve via an emulator/hardware experiment before trusting either side [both sources
cited; no resolution exists in the vendored file].

## 8. Memory-control registers the BIOS writes (0x1F801000..)
§ I/O Map (`#iomap`) / § Memory Control (`#memorycontrol`), L176–L216 + L38436+:
```
1F801000h Expansion 1 Base (usually 1F000000h)
1F801004h Expansion 2 Base (usually 1F802000h)
1F801008h Expansion 1 Delay/Size (usually 0013243Fh; 512KB, 8bit bus)
1F80100Ch Expansion 3 Delay/Size (usually 00003022h; 1 byte)
1F801010h BIOS ROM Delay/Size (usually 0013243Fh)
1F801014h SPU_DELAY (usually 200931E1h; use 220931E1h for SPU-RAM reads)
1F801018h CDROM_DELAY (00020843h or 00020943h)
1F80101Ch Expansion 2 Delay/Size (usually 00070777h)
1F801020h COM_DELAY (00031125h or 0000132Ch or 00001325h)
1F801060h RAM_SIZE (usually 00000B88h — 2MB mirrored in 8MB window; "correct" would be
          00000888h; BIOS sets 8MB window; SetMemSize(2MB) writes RAM size to [00000060h])
FFFE0130h Cache Control — BIOS init sequence [verbatim L38566–L38575]:
  Step1: [FFFE0130h]=00000804h; cop0_sr=00010000h; zerofill each FOURTH word [0000..0FFFh];
         cop0_sr=0. Step2: [FFFE0130h]=00000800h; cop0_sr=00010000h; zerofill ALL words
         [0000..0FFFh]; cop0_sr=0. Finish: read 8*32bit from [A0000000h];
         [FFFE0130h]=0001E988h.
```
Delay/Size bit fields: bits4-7 access time, bit8/10/11 COM0/COM2/COM3 use, bit12 bus width,
bits16-20 window size (1<<n), etc. [verbatim L38462–L38477]. "The Memory Control registers
are initialized by the BIOS, and, normally software doesn't need to change that settings"
[verbatim L38438–L38439].

## 9. FileOpen: handles, device names, granularity, errors
§ BIOS File Functions (`#biosfilefunctions`), L40304–L40490 + § BIOS CDROM/Memory Card
Functions: FileOpen(filename,accessmode) → handle 00h..0Fh or -1 (max 16 FCBs, 2 reserved
for std_io → 14 usable; several meta functions transiently grab one more). Accessmode
[verbatim L40320–L40326]: bit0 Read, bit1 Write (≥1 set required), bit2 no-wait TTY,
bit9 create (memcard), bit15 async (memcard only), bits16-31 block count (memcard create).
**cdrom:** is shorthand for cdrom0:; port number ignored [verbatim L40624–L40625]. Device
names are case-sensitive in the prefix; the part after the colon is a hex non-case-sensitive
port ("bu00:" slot1, "bu10:" slot2; memcards need InitCard→StartCard→_bu_init first;
multitap slots bu01..bu13 use 82h..84h) [verbatim]. FileRead chunking [verbatim]: reads
"per $0080 bytes from memory card (bu:) and per $0800 from cdrom"; FileWrite to cdrom returns
0; FileSeek seektype 2 is buggy; FileGetc sign-expands (use FileRead for 8-bit-clean input).
Normal CD file reads are **synchronous** (function returns after full transfer); async
cdrom = CdGetLbn(A(A4h)) + CdAsyncSeekL(A(78h)) + CdAsyncReadSector(A(7Eh), mode with
bit8=0→ReadN/1→ReadS; sector size 800h if mode bits4-5=0, 924h if bit4=0,bit5=1, 918h if
bit4=1) completing via events class F0000003h spec 20h/80h/8000h. chdir(cdrom:…) always
re-reads the path table (slow). firstfile/nextfile support `?` wildcards only (and share
one unmarked FCB — do not mix with open files). FileIoctl(fd,cmd,arg) — psx-spx:
"Used only for TTY" [verbatim L40460–L40461]; no ioctl-code table exists in psx-spx; an
unknown ioctl cmd yields error 16h. File error numbers [verbatim L40472–L40485]: 00h ok,
02h not found, 06h bad port, 09h invalid handle, 10h general I/O error, 11h already
exists, 12h cross-device rename, 13h unknown device, 16h sector alignment/seek/ioctl,
18h no free handles, 1Ch no free card blocks.

Garbage area / safety [verbatim, § BIOS Memory Map L39903–L39924]: RAM[0x0000..0x000F] is
garbage: initially a copy of the 16-byte exception handler with [0000..3] smashed to
00000003h; expected contents 3C1A0000h / 275A0C80h (or 275A0C50h older BIOS) / 03400008h /
00000000h. Bugged games (R-Types, Fade to Black) read these — an emulator that zerofills or
randomizes this area can crash them; RE is not known to depend on it, keep [5] safe anyway.

## 10. Implementer notes for src/core/bios.ts
- HleBios must implement: A/B/C dispatch via fixed RAM stubs (0xA0/0xB0/0xC0 + R9 → jump
  table 0x200), the four IRQ priority chains, SYS(01h/02h), the event tables above, exe
  load/Execute semantics, SetConf from SYSTEM.CNF, and CdInit-before-boot.
- Kernel memory region: RAM 0xE000..0xFFFF (A000E000h..A000FFFFh) holds ExCBs (4×08h),
  EvCBs (N×1Ch), TCBs (N×0C0h), PCB (1×04h) — allocation order as stated in § BIOS Memory
  Allocation. Kernel code/data relocated to RAM from 0x500; SysInitKernelVariables area
  00007460h..0000891Fh [verbatim L42093–L42094].
- TCB=4 for this disc; stack top 0x801FFF00 (KSEG0), which nocash equates to "memtop-256".
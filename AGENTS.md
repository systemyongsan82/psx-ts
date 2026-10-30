# re-macapp — PlayStation emulator core (TypeScript, Bun)

Goal: run **Resident Evil (USA) (SLUS-00170)** playable. No other game matters.

## Commands

- `bun install` — install devDeps (typescript, @types/bun). No runtime deps allowed.
- `bun run typecheck` — tsc strict must be clean before any commit.
- `bun test` — unit tests (bun test framework).
- `bun src/harness/run.ts --frames 300 --out shots` — headless boot + PNG screenshots + log dump.

## Layout

- `src/core/contracts.ts` — ALL shared interfaces & constants. Change only via the top-level agent.
- `src/core/system.ts` — assembly: constructs everything (`PsxSystem`), drives the scheduler/frame loop. Top-level agent owns this file; do not restructure it.
- `src/core/cpu.ts` (CpuR3000A), `src/core/gte.ts` (Gte) — CPU agent.
- `src/core/bus.ts` (Bus) — bus/peripherals agent (RAM, IRQ/ISTAT/IMASK, timers, DMA incl. OTC, SIO0 pad, mem control regs).
- `src/core/gpu.ts` (GpuCore) — GPU agent.
- `src/core/spu.ts` (SpuCore) — SPU agent.
- `src/core/mdec.ts` (MdecCore) — MDEC agent.
- `src/core/bios.ts` (HleBios) — HLE BIOS/kernel agent.
- `src/disc/cdrom.ts` (Cdrom) — CD controller agent. `src/disc/image.ts`, `src/disc/iso9660.ts`, `src/disc/psxexe.ts` are DONE (top-level agent); read them, do not rewrite them without coordination.
- `src/ui/` — frontend agent (Bun server + browser client).
- `docs/kb/` — generated knowledge base from researchers (kernel tables, CD/GPU/SPU/GTE/MDEC specs).
- `docs/re-notes.md` — disc facts + acceptance checklist.
- The disc image lives at `"Resident Evil (USA)/Resident Evil (USA).bin"` (650 MB, gitignored).

## Coding rules (hard)

1. Strict TS, no `any`, no `as`, no `!`, no `@ts-ignore`, no `enum`. `@ts-expect-error` with a reason only if truly unavoidable.
2. Explicit return types on exported functions/methods. Blank line before `return`.
3. `Array<T>` not `T[]`.
4. No new dependencies without approval — the runtime is Bun; use `node:fs` sync IO only inside `src/disc/image.ts` and server code.
5. No comments except unavoidable `@ts-expect-error` reasons or a *why* that code cannot express. No section banners, no narration. Prefer renaming.
6. Tests: `bun test` files next to modules (`*.test.ts`). Every component ships at least one meaningful test before integration.
7. Hot loops (CPU execute, GPU raster, SPU mix) must not allocate per call.
8. Performance floor: CPU execute must sustain full PSX rate (≈2 M instr/sec for real-time-ish); if not, note it in your report.

## Concurrency

Agents work in ONE worktree. Never edit a file another agent owns. `src/core/system.ts` is the seam; if you need different wiring, add a new file + note it in your final report.

## Endianness

The PSX is little-endian. `Uint32Array` views may be used word-aligned. Never bit-pack big-endian.

## Git

Do not commit. The top-level agent commits after integration checkpoints.
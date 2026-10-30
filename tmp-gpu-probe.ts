const { PsxBinImage } = await import('./src/disc/image');
const { IsoImage, readEntryBytes } = await import('./src/disc/iso9660');
const { RingLogger } = await import('./src/core/logger');

const BIN = 'Resident Evil (USA)/Resident Evil (USA).bin';
const logger = new RingLogger();
const img = new PsxBinImage(BIN, logger);
const iso = new IsoImage(img, logger);
const exe = iso.find('SLUS_001.70');
if (exe === null) throw new Error('exe not found');
const bytes = readEntryBytes(img, exe.lba, 0, exe.size);
img.close();

const words = new Uint32Array(bytes.buffer, 0, bytes.length >> 2);

const R = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];

function dis(w: number): string {
  const op = w >>> 26;
  const rs = (w >>> 21) & 0x1f;
  const rt = (w >>> 16) & 0x1f;
  const rd = (w >>> 11) & 0x1f;
  const sh = (w >>> 6) & 0x1f;
  const imm = w & 0xffff;
  const sim = (imm << 16) >> 16;
  if (op === 0) {
    const funct = w & 0x3f;
    if (w === 0) return 'nop';
    if (funct === 0) return `sll ${R[rd]}, ${R[rt]}, ${sh}`;
    if (funct === 2) return `srl ${R[rd]}, ${R[rt]}, ${sh}`;
    if (funct === 3) return `sra ${R[rd]}, ${R[rt]}, ${sh}`;
    if (funct === 8) return `jr ${R[rs]}`;
    if (funct === 0x21) return `addu ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x23) return `subu ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x24) return `and ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x25) return `or ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x2a) return `slt ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x2b) return `sltu ${R[rd]}, ${R[rs]}, ${R[rt]}`;
    if (funct === 0x18) return `mult ${R[rs]}, ${R[rt]}`;
    if (funct === 0x19) return `multu ${R[rs]}, ${R[rt]}`;
    if (funct === 0x1b) return `div ${R[rs]}, ${R[rt]}`;
    if (funct === 0x1d) return `divu ${R[rs]}, ${R[rt]}`;
    if (funct === 0x10) return `mfhi ${R[rd]}`;
    if (funct === 0x12) return `mflo ${R[rd]}`;
    return `R fun 0x${funct.toString(16)}`;
  }
  if (op === 8 || op === 9) return `addiu ${R[rt]}, ${R[rs]}, ${sim}`;
  if (op === 0xc) return `andi ${R[rt]}, ${R[rs]}, 0x${imm.toString(16)}`;
  if (op === 0xd) return `ori ${R[rt]}, ${R[rs]}, 0x${imm.toString(16)}`;
  if (op === 0xf) return `lui ${R[rt]}, 0x${imm.toString(16)}`;
  if (op === 0x23) return `lw ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x2b) return `sw ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x29) return `sh ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x28) return `sb ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 2) return `j 0x${((0x80000000 | ((w & 0x3ffffff) << 2)) >>> 0).toString(16)}`;
  if (op === 3) return `jal 0x${((0x80000000 | ((w & 0x3ffffff) << 2)) >>> 0).toString(16)}`;
  if (op === 4) return `beq ${R[rs]}, ${R[rt]}, +${sim}`;
  if (op === 5) return `bne ${R[rs]}, ${R[rt]}, +${sim}`;
  if (op === 1) return `${rt ? 'bgez' : 'bltz'} ${R[rs]}, +${sim}`;
  if (op === 6) return `blez ${R[rs]}, +${sim}`;
  if (op === 7) return `bgtz ${R[rs]}, +${sim}`;
  if (op === 0x10) return `mfc2 ${R[rt]}, r${rd}`;
  if (op === 0x20) return `lb ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x21) return `lh ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x25) return `lhu ${R[rt]}, ${sim}(${R[rs]})`;
  if (op === 0x24) return `lbu ${R[rt]}, ${sim}(${R[rs]})`;
  return `op_0x${op.toString(16)}`;
}

function dump(lo: number, hi: number): void {
  const i0 = (lo - 2048) >> 2;
  const i1 = (hi - 2048) >> 2;
  console.log(`--- block 0x${lo.toString(16)}..0x${hi.toString(16)} ---`);
  for (let i = i0; i <= i1 && i < words.length; i++) {
    console.log(`0x${(i * 4 + 2048).toString(16)}: ${words[i].toString(16).padStart(8, '0')}  ${dis(words[i])}`);
  }
}

dump(0x579f0, 0x57b00);
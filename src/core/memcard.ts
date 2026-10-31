export const MEMCARD_SIZE = 0x2_0000;
export const MEMCARD_SECTOR_SIZE = 0x80;
const SECTOR_COUNT = 0x400;
const DEFAULT_READ_EXTRA_ACK_DELAY = 31_000;
const FLAG_UNREAD_DIRECTORY = 0x08;
const END_GOOD = 0x47;
const END_BAD_CHECKSUM = 0x4E;
const END_BAD_SECTOR = 0xFF;

export interface CardReply {
  readonly reply: number;
  readonly ack: boolean;
  readonly ackDelay: number;
}

type Phase = 'idle' | 'command' | 'id1' | 'id2' | 'addrMsb' | 'addrLsb' | 'out' | 'writeData' | 'writeChecksum';

function xorOf(bytes: Uint8Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    sum ^= bytes[i];
  }

  return sum;
}

export function formatBlankCard(): Uint8Array {
  const card = new Uint8Array(MEMCARD_SIZE);
  const frame = (n: number): number => n * MEMCARD_SECTOR_SIZE;
  const header = (n: number): void => {
    card[frame(n)] = 0x4D;
    card[frame(n) + 1] = 0x43;
    card[frame(n) + 0x7F] = xorOf(card, frame(n), frame(n) + 0x7F);
  };
  header(0);
  for (let n = 1; n <= 15; n++) {
    card[frame(n)] = 0xA0;
    card[frame(n) + 8] = 0xFF;
    card[frame(n) + 9] = 0xFF;
    card[frame(n) + 0x7F] = xorOf(card, frame(n), frame(n) + 0x7F);
  }
  for (let n = 16; n <= 35; n++) {
    card.fill(0xFF, frame(n), frame(n) + 4);
    card[frame(n) + 0x7F] = xorOf(card, frame(n), frame(n) + 0x7F);
  }
  card.fill(0xFF, frame(36), frame(63));
  header(63);

  return card;
}

export class MemoryCard {
  readonly data: Uint8Array;
  flag = FLAG_UNREAD_DIRECTORY;

  private phase: Phase = 'idle';
  private command = 0;
  private msb = 0;
  private lsb = 0;
  private sum = 0;
  private previous = 0;
  private writeIndex = 0;
  private readonly writeBuffer = new Uint8Array(MEMCARD_SECTOR_SIZE);
  private out: Array<number> = [];
  private outIndex = 0;

  private readonly readExtraAckDelay: number;

  constructor(data: Uint8Array | null, readExtraAckDelay: number = DEFAULT_READ_EXTRA_ACK_DELAY) {
    this.readExtraAckDelay = readExtraAckDelay;
    if (data !== null && data.length !== MEMCARD_SIZE) {
      throw new Error(`memory card image must be ${MEMCARD_SIZE} bytes, got ${data.length}`);
    }
    this.data = data ?? formatBlankCard();
  }

  get busy(): boolean {
    return this.phase !== 'idle' && this.phase !== 'command';
  }

  begin(): void {
    this.phase = 'command';
  }

  abort(): void {
    this.phase = 'idle';
  }

  exchange(byte: number): CardReply {
    switch (this.phase) {
      case 'command':
        this.command = byte;
        if (byte !== 0x52 && byte !== 0x57 && byte !== 0x53) {
          this.phase = 'idle';

          return { reply: this.flag, ack: false, ackDelay: 0 };
        }
        this.phase = 'id1';

        return { reply: this.flag, ack: true, ackDelay: 0 };
      case 'id1':
        this.phase = 'id2';

        return { reply: 0x5A, ack: true, ackDelay: 0 };
      case 'id2':
        if (this.command === 0x53) {
          this.startOutput([0x5C, 0x5D, 0x04, 0x00, 0x00, 0x80]);
        } else {
          this.phase = 'addrMsb';
        }

        return { reply: 0x5D, ack: true, ackDelay: 0 };
      case 'addrMsb':
        this.msb = byte;
        this.sum = byte;
        this.phase = 'addrLsb';

        return { reply: 0x00, ack: true, ackDelay: 0 };
      case 'addrLsb':
        this.lsb = byte;
        this.sum ^= byte;
        this.previous = byte;
        if (this.command === 0x52) {
          this.startOutput(this.readOutput());
        } else {
          this.writeIndex = 0;
          this.phase = 'writeData';
        }

        return { reply: this.msb, ack: true, ackDelay: 0 };
      case 'writeData': {
        const reply = this.previous;
        this.writeBuffer[this.writeIndex] = byte;
        this.writeIndex += 1;
        this.sum ^= byte;
        this.previous = byte;
        if (this.writeIndex === MEMCARD_SECTOR_SIZE) {
          this.phase = 'writeChecksum';
        }

        return { reply, ack: true, ackDelay: 0 };
      }
      case 'writeChecksum': {
        const sector = (this.msb << 8) | this.lsb;
        let end = END_GOOD;
        if (sector >= SECTOR_COUNT) {
          end = END_BAD_SECTOR;
        } else if (byte !== this.sum) {
          end = END_BAD_CHECKSUM;
        } else {
          this.data.set(this.writeBuffer, sector * MEMCARD_SECTOR_SIZE);
          this.flag &= ~FLAG_UNREAD_DIRECTORY;
        }
        this.startOutput([0x5C, 0x5D, end]);

        return { reply: this.previous, ack: true, ackDelay: 0 };
      }
      case 'out': {
        const index = this.outIndex;
        const reply = this.out[index];
        this.outIndex += 1;
        const last = this.outIndex === this.out.length;
        if (last) {
          this.phase = 'idle';
        }

        return {
          reply,
          ack: !last,
          ackDelay: this.command === 0x52 && index === 0 ? this.readExtraAckDelay : 0,
        };
      }
      default:
        return { reply: 0xFF, ack: false, ackDelay: 0 };
    }
  }

  private startOutput(bytes: Array<number>): void {
    this.out = bytes;
    this.outIndex = 0;
    this.phase = 'out';
  }

  private readOutput(): Array<number> {
    const sector = (this.msb << 8) | this.lsb;
    if (sector >= SECTOR_COUNT) {
      return [0x5C, 0x5D, 0xFF, 0xFF];
    }
    const from = sector * MEMCARD_SECTOR_SIZE;
    const checksum = this.msb ^ this.lsb ^ xorOf(this.data, from, from + MEMCARD_SECTOR_SIZE);

    return [0x5C, 0x5D, this.msb, this.lsb, ...this.data.subarray(from, from + MEMCARD_SECTOR_SIZE), checksum, END_GOOD];
  }
}

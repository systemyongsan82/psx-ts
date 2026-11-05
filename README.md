# psx-ts

TypeScript와 Bun으로 만든 실험용 PlayStation 에뮬레이터의 소스 코드 아카이브입니다.
Resident Evil (USA, SLUS-00170) 실행을 목표로 개발했으며, 완전한 게임 호환성은 보장하지 않습니다.

## 실행

[Bun](https://bun.sh)이 필요합니다. 게임 이미지와 BIOS는 포함하지 않으며, 사용할 권한이 있는 파일을 직접 준비해야 합니다.

```sh
bun install
bun run serve
```

브라우저에서 `http://localhost:7171`에 접속합니다. 다른 디스크와 BIOS를 사용하려면 다음과 같이 실행합니다.

```sh
bun src/ui/server.ts "path/to/disc.bin" 7171 --bios "path/to/bios.bin"
```

## 검증

```sh
bun run typecheck
bun test
```

일부 테스트는 로컬 게임 이미지·BIOS·리플레이 파일이 필요합니다.

## 참고 자료

- [nocash PSX-SPX](https://problemkaputt.de/psx-spx.htm) — PlayStation 하드웨어 사양
- [PSX-SPX](https://psx-spx.consoledev.net/) — 커뮤니티에서 정리한 하드웨어 사양
- [PSXjin](https://github.com/TASEmulators/psxjin) — 타이밍과 입력 리플레이 동작 참고
- [DuckStation](https://github.com/stenzek/duckstation) — CD 탐색 타이밍 참고

## 라이선스

[GPL-2.0-only](LICENSE)

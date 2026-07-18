# OpenStreamGrid

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/mytrashcan/OpenStreamGrid)](https://github.com/mytrashcan/OpenStreamGrid/releases/latest)
[![CI](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-green.svg)](package.json)
[![Docker images](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/mytrashcan/OpenStreamGrid/actions/workflows/docker-publish.yml)

표준 라이브 스트리밍을 위한 범용 하이브리드 P2P-CDN 전송 미들웨어입니다.

[English](README.md) | [한국어](README.ko.md)

## 프로젝트 소개

OpenStreamGrid는 기존 HLS, LL-HLS 또는 CMAF 스트리밍 서비스에 피어 기반
세그먼트 전송을 추가합니다. 같은 라이브 방송을 시청하는 클라이언트가 이미
받은 영상 세그먼트를 서로 공유하므로 Origin 서버와 CDN의 전송량을 줄일 수
있습니다.

P2P 전송이 불가능하거나 재생 기한 안에 완료되지 않으면 즉시 Origin/CDN으로
전환합니다. 따라서 피어가 접속을 종료하거나 응답이 느려져도 재생 경로를
유지합니다.

> OpenStreamGrid는 완전한 라이브 스트리밍 플랫폼이 아닙니다. 기존 인코더,
> Origin, CDN, 플레이어에 결합하는 독립적인 영상 전송 미들웨어입니다.

## 퀵 스타트

[Docker Compose v2](https://docs.docker.com/compose/)가 설치된 환경에서 다음
명령 하나로 Tracker, 테스트 Origin, 피어 2개를 실행할 수 있습니다.

```bash
git clone --branch v0.4.1 --depth 1 https://github.com/mytrashcan/OpenStreamGrid.git
cd OpenStreamGrid
docker compose up --build --detach
docker compose ps
```

| 서비스 | 로컬 주소 |
| --- | --- |
| 모니터링 대시보드 | <http://localhost:7070/dashboard> |
| Tracker 상태 확인 | <http://localhost:7070/health> |
| HLS 마스터 플레이리스트 | <http://localhost:8080/hls/stream.m3u8> |
| Peer A / Peer B | <http://localhost:9091> / <http://localhost:9092> |

Compose 스택은 FFmpeg 테스트 패턴으로 라이브 HLS 스트림을 생성합니다. 피어는
정상 기동 후 검증된 세그먼트를 교환하며, P2P 요청이 실패하거나 느리면
Origin으로 폴백합니다. 종료할 때는 `docker compose down`을 실행하세요.

## 현재 릴리스

현재 안정 릴리스는
[OpenStreamGrid v0.4.1](https://github.com/mytrashcan/OpenStreamGrid/releases/tag/v0.4.1)입니다.
이 버전부터 보호된 Tracker REST 변경 요청, 통계, 대시보드, WebSocket
업그레이드에 `TRACKER_API_KEY` 인증을 실제로 적용합니다. v0.4.0에서 추가한
무설치 브라우저 Peer와 CORS, 대역폭 기반 WebRTC 전송 제한 시간 수정도 모두
포함합니다. 전체 변경 내역은 [변경 이력](CHANGELOG.md)을 확인하세요.

운영 배포용 컨테이너 이미지는 GHCR에 게시됩니다.

| 구성 요소 | 이미지 |
| --- | --- |
| Tracker | `ghcr.io/mytrashcan/openstreamgrid-tracker:v0.4.1` |
| Origin | `ghcr.io/mytrashcan/openstreamgrid-origin:v0.4.1` |
| Node Peer | `ghcr.io/mytrashcan/openstreamgrid-peer:v0.4.1` |

운영 환경에서는 변경되지 않는 버전 태그를 사용하세요. `latest` 태그는 평가용으로
제공합니다. 브라우저 SDK는 CI에서 빌드와 npm 게시 dry-run까지 검증하지만 아직
npm 레지스트리에는 게시하지 않았습니다. 최초 게시 전까지는 태그가 지정된 소스를
받아 다음 명령으로 빌드해 사용하세요.

```bash
npm ci --prefix sdk
npm run build --prefix sdk
```

## 아키텍처 개요

```text
                         HTTPS / API 키
  인코더 ──► Origin ─────────────────────────► Tracker + SQLite WAL
     │          │                                  │  │
     │          ├── HLS 화질별 스트림              │  ├── REST + WebSocket
     │          └── SHA-256 해시 파일              │  └── 대시보드 + SSE
     │                                             │
     │                   피어 탐색 / 통계 ─────────┘
     │
     └──────────────────────── CDN / Origin 폴백
                                      │
                           ┌───────────┴───────────┐
                           ▼                       ▼
                       Node Peer A ◄──────────► Node Peer B
                           │       HTTP/WebRTC     │
                           │       STUN/TURN       │
                           ▼                       ▼
                       세그먼트 캐시          세그먼트 캐시
                           │                       │
                           └──── Hls.js 브라우저 SDK ┘
```

- **Origin 서버**는 FFmpeg로 HLS 플레이리스트와 세그먼트, SHA-256 해시 파일을
  생성하고 제공합니다.
- **Tracker**는 방송과 피어 상태, 세그먼트 보유 정보, 통계, WebSocket
  시그널링을 관리합니다.
- **Node Peer**는 세그먼트를 캐시하고 제한된 대역폭으로 다른 피어에 제공하며,
  최적의 전송 경로를 선택합니다.
- **브라우저 SDK**는 Hls.js 로더와 결합해 브라우저에서도 하이브리드 전송을
  사용할 수 있게 합니다.

## 주요 기능

- HTTP/WebRTC 기반 P2P 전송과 즉시 Origin 폴백
- HLS 다중 채널 격리와 세 가지 ABR 화질 생성
- WebSocket 실시간 피어 탐색 및 시그널링
- 지연 시간, 성공률, 업로드 대역폭, 신뢰 점수 기반 피어 선택
- 병렬 다운로드, 중복 요청 병합, TTL 기반 LRU 세그먼트 캐시
- SHA-256 무결성 검증과 실패 피어 신뢰도 차감
- 업로드 속도 및 동시 연결 수 제한
- REST API 키 인증, TLS, STUN/TURN 설정
- SQLite WAL 영속화와 실시간 대시보드, SSE, Prometheus 메트릭
- Docker Compose 통합 테스트, 부하 테스트, Kubernetes/Helm 배포 파일

## 무설치 브라우저 Peer

Hls.js SDK를 적용한 시청자는 페이지에 접속하는 즉시 WebRTC Peer로
참여합니다. SDK가 Tracker 등록, 검증된 세그먼트 캐시, 보유 세그먼트 광고,
DataChannel 업로드, 트래픽 보고, 재생 종료 시 등록 해제를 자동으로
처리합니다. 시청자가 EXE나 크롬 확장 프로그램을 설치할 필요가 없습니다.

다음 예제는 번들러가 로컬에서 빌드한 `@openstreamgrid/sdk` 패키지를 해석하도록
설정한 환경을 기준으로 합니다.

```ts
import Hls from "hls.js";
import { OpenStreamGridHlsPlugin } from "@openstreamgrid/sdk";

const hls = new Hls();
const plugin = new OpenStreamGridHlsPlugin({
  trackerUrl: "https://stream.example.com",
  broadcastId: "live",
  originBaseUrl: "https://stream.example.com/hls/low",
  maxUploadBitrate: 1_000_000,
  maxUploadConnections: 3,
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    {
      urls: "turns:turn.example.com:5349",
      username: "viewer",
      credential: "short-lived-credential",
    },
  ],
});
plugin.attach(hls);
hls.loadSource("https://stream.example.com/hls/stream.m3u8");
hls.attachMedia(document.querySelector("video")!);
```

수신 전용 재생은 `peerParticipation: false`로 설정할 수 있습니다. 네이티브
에이전트나 크롬 확장 프로그램은 관리형 환경의 전용 Seed Peer에는 유용하지만,
일반 시청자 경로에는 필요하지 않습니다.

`trackerApiKey`는 시청자별 권한이 아니라 배포 전체가 공유하는 인증 정보입니다.
Tracker 인증을 활성화했다면 이 옵션을 제공하되, 공개 JavaScript 번들에 장기
키를 하드코딩하지 마세요. 공개 서비스에서는 인증된 게이트웨이 뒤에 Tracker를
배치하거나 공유 키를 시청자에게 노출하지 않는 별도의 신뢰 가능한 연동 방식을
사용해야 합니다.

## API 요약

Tracker 리소스는 `/api/v1` 아래에 있습니다. `TRACKER_API_KEY`를 설정했다면
보호된 HTTP 요청에 `X-API-Key: <key>` 헤더를 보내야 합니다. WebSocket
클라이언트는 헤더 또는 `?apiKey=<key>` 쿼리를 사용할 수 있으며, 브라우저는
WebSocket API에서 임의의 업그레이드 헤더를 설정할 수 없으므로 쿼리를 사용합니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/health` | Tracker 준비 상태 확인 |
| `GET` | `/dashboard` | 모니터링 UI 열기 |
| `GET` | `/metrics` | Prometheus 메트릭 조회 |
| `GET` | `/ws` | WebSocket 시그널링 연결 |
| `GET` | `/api/v1/stats` | 전체 트래픽 통계 조회 |
| `GET` | `/api/v1/stats/events` | 실시간 통계 SSE 구독 |
| `POST` | `/api/v1/broadcasts` | 방송 등록 또는 갱신 |
| `GET` | `/api/v1/broadcasts` | 방송 목록 조회 |
| `GET` | `/api/v1/broadcasts/:id` | 방송 상세 정보와 피어 조회 |
| `DELETE` | `/api/v1/broadcasts/:id` | 방송 등록 해제 |
| `GET` | `/api/v1/broadcasts/:id/stats` | 방송별 트래픽 통계 조회 |
| `POST` | `/api/v1/broadcasts/:id/peers` | 방송에 피어 참여 |
| `GET` | `/api/v1/broadcasts/:id/peers` | 피어 목록 조회 (`?segment=` 지원) |
| `DELETE` | `/api/v1/broadcasts/:id/peers/:peerId` | 피어 참여 종료 |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/segments` | 보유 세그먼트 보고 |
| `PUT` | `/api/v1/broadcasts/:id/peers/:peerId/heartbeat` | 피어 상태 갱신 |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/stats` | 피어 트래픽 통계 보고 |
| `POST` | `/api/v1/broadcasts/:id/peers/:peerId/reports` | 피어 실패 보고 |

요청·응답 스키마와 상태 코드, WebSocket 메시지는
[API 레퍼런스](API_REFERENCE.md)를 참고하세요.

## 환경 변수 참조

### Tracker

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `7070` | HTTP/HTTPS 수신 포트 |
| `HOST` | `0.0.0.0` | 수신 주소 |
| `STALE_PEER_MS` | `30000` | 비활성 피어 만료 시간(ms) |
| `STORE_TYPE` | `sqlite` | 저장소 유형: `sqlite` 또는 `memory` |
| `DB_PATH` | `./data/tracker.db` | SQLite 데이터베이스 경로 |
| `TRACKER_API_KEY` | 미설정 | REST POST/PUT/DELETE, 통계, 대시보드, WebSocket 업그레이드에 API 키 인증 적용 |
| `TLS_CERT_PATH` | 미설정 | PEM 인증서 경로 (`TLS_KEY_PATH` 필요) |
| `TLS_KEY_PATH` | 미설정 | PEM 개인 키 경로 (`TLS_CERT_PATH` 필요) |
| `RATE_LIMIT_RPS` | `100` | 클라이언트별 초당 지속 요청 한도 |
| `RATE_LIMIT_BURST` | `200` | 클라이언트별 순간 요청 버스트 한도 |
| `MAX_PEERS_PER_BROADCAST` | `500` | 방송별 최대 활성 피어 수 |

### Origin

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `8080` | Origin 수신 포트 |
| `HOST` | `0.0.0.0` | 수신 주소 |
| `TRACKER_URL` | `http://tracker:7070` | Tracker 기본 URL |
| `TRACKER_API_KEY` | 미설정 | Tracker 등록에 사용할 API 키 |
| `BROADCAST_ID` | `live` | 기본 방송/채널 ID |
| `MULTI_STREAM_COUNT` | `1` | 생성할 테스트 채널 수 |
| `PUBLIC_ORIGIN_URL` | `http://origin:<PORT>` | 클라이언트에 알릴 Origin URL |
| `HLS_DIRECTORY` | `/tmp/openstreamgrid-hls` | 생성된 HLS 파일 디렉터리 |
| `SEGMENT_DURATION_SECONDS` | `2` | HLS 목표 세그먼트 길이(초) |
| `PLAYLIST_SIZE` | `8` | 미디어 플레이리스트별 유지 세그먼트 수 |
| `HASH_INTERVAL_MS` | `250` | 해시 파일 탐색 주기(ms) |
| `FFMPEG_PATH` | `PATH`의 `ffmpeg` | FFmpeg 실행 파일 경로 |

### Node Peer

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TRACKER_URL` | `http://tracker:7070` | Tracker 기본 URL |
| `TRACKER_API_KEY` | 미설정 | Tracker REST/WebSocket API 키 |
| `BROADCAST_ID` | `live` | 참여할 방송 ID |
| `ORIGIN_URL` | 필수 | 화질별 디렉터리 또는 `.m3u8` URL |
| `PEER_ADDRESS` | 필수 | 외부에 알릴 `http://host:port` 주소 |
| `PEER_ID` | 호스트 이름 | 피어 식별자 |
| `UPLOAD_HOST` | `0.0.0.0` | 업로드 서버 바인드 주소 |
| `CACHE_SIZE` | `512MB` | 최대 세그먼트 캐시 크기 |
| `CACHE_TTL_MS` | `300000` | 캐시 항목 절대 수명(ms) |
| `MAX_UPLOAD_SPEED` | `1Mbps` | 토큰 버킷 업로드 비트 전송률 |
| `MAX_CONNECTIONS` | `3` | 동시 피어 업로드 수 |
| `MAX_PARALLEL_DOWNLOADS` | `3` | 동시 세그먼트 다운로드 수 |
| `PLAYLIST_POLL_MS` | `500` | HLS 플레이리스트 조회 주기(ms) |
| `P2P_TIMEOUT_MS` | `2000` | 피어 요청 제한 시간(ms) |
| `WEBRTC_ENABLED` | `true` | HTTP보다 WebRTC를 먼저 시도할지 여부 |
| `STUN_SERVER` | 공개 Google STUN | `stun:` 또는 `stuns:` ICE 서버 URL |
| `TURN_SERVER` | 미설정 | `turn:` 또는 `turns:` 릴레이 URL |
| `TURN_USERNAME` | 미설정 | TURN 사용자 이름 |
| `TURN_CREDENTIAL` | 미설정 | TURN 인증 정보 |

주요 피어 설정에는 같은 이름의 CLI 옵션도 제공됩니다.

### 브라우저 SDK

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `peerParticipation` | `true` | 무설치 브라우저 Peer 등록 및 업로드 |
| `iceServers` | 공개 Google STUN | NAT 통과에 사용할 STUN/TURN 서버 |
| `maxUploadBitrate` | `1000000` | 브라우저 업로드 비트 전송률 제한 |
| `maxUploadConnections` | `3` | 동시 브라우저 DataChannel 업로드 수 |
| `peerTimeoutMs` | `3000` | Peer 요청 및 협상 제한 시간 |
| `maxCacheBytes` | `100 MB` | 브라우저 세그먼트 캐시 한도 |
| `trackerApiKey` | 미설정 | REST Peer 등록용 API 키 |

### 벤치마크

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PEER_COUNT` | `10` | 가상 피어 수 |
| `DURATION_SECONDS` | `60` | 측정 시간(초) |
| `RAMP_UP_SECONDS` | `5` | 피어 기동 분산 시간(초) |
| `CHURN_RATE` | `0.15` | 주기별 피어 이탈 확률 |
| `REPORT_INTERVAL_SECONDS` | `10` | 콘솔 보고 주기(초) |
| `BENCHMARK_OUTPUT` | `benchmark-results.json` | JSON 결과 파일 경로 |
| `BENCHMARK_PROJECT_NAME` | `openstreamgrid-benchmark` | 격리된 Compose 프로젝트 이름 |
| `TRACKER_URL` | `http://127.0.0.1:7070` | 호스트 상태 확인용 Tracker URL |
| `ORIGIN_URL` | `http://127.0.0.1:8080` | 호스트 상태 확인용 Origin URL |

## 개발 및 검증

로컬 개발에는 Node.js 22 이상, npm, Docker Compose v2, FFmpeg가 필요합니다.

```bash
npm ci
npm ci --prefix sdk
npm run build
npm run typecheck
npm test
npm run lint
```

P2P 교환과 Origin 폴백 통합 테스트는 `bash test/docker-test.sh`, 기본 부하
벤치마크는 `bash scripts/benchmark.sh`로 실행할 수 있습니다.

## 문서 링크

- [영문 README](README.md)
- [API 레퍼런스](API_REFERENCE.md)
- [기여 가이드](CONTRIBUTING.md)
- [보안 정책](SECURITY.md)
- [릴리스 노트](RELEASE_NOTES.md)
- [변경 이력](CHANGELOG.md)
- [Kubernetes 배포 가이드](deploy/k8s/README.md)
- [Helm 설정](helm/openstreamgrid/values.yaml)
- [브라우저 SDK 예제](sdk/examples/basic.html)

## 기여 및 라이선스

이슈와 Pull Request를 환영합니다. 개발 환경, 테스트 기준, 코딩 규칙은
[CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 확인해 주세요.

OpenStreamGrid는 [GNU General Public License v3.0](LICENSE)으로 배포됩니다.

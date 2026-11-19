# AI Visual Editor

기존 웹 프로젝트를 분리된 사본에서 수정하고, Preview와 Diff를 검토한 뒤 선택한 파일만 원본에 반영하는 독립형 개발 도구입니다. 원본에 SDK·Controller·Inspector 소스를 설치하지 않습니다. Git commit/merge/push, SQL 실행, 배포 기능은 없습니다.

> 현재는 macOS에서 검증하는 로컬 MVP입니다. 사내 공용 서비스 배포가 완료된 제품은 아닙니다. 검증 범위와 미구현 사항은 [검증 기록](docs/validation.md)과 [보안·복구 가이드](docs/security.md)를 확인하세요.

## 구성

```text
hub/backend/       Java 21 / Spring Boot 3.5 / Spring Security / WebSocket
hub/frontend/      Vanilla JS / Monaco Diff / Preview·채팅 패널
agent/project/     등록 설정, 탐지, 실제 파일 스냅샷, 작업 수명주기
agent/runtime/     정적 서버, 등록 명령 실행, macOS Sandbox, Java JAR 실행본
agent/preview/     인증된 Hub 중계용 HTTP 응답, 임시 Inspector 주입
agent/inspector/   클릭·드래그 선택, 값 없는 DOM 구조 수집
agent/codex/       Codex App Server stdio / 작업별 대화 / 정지
agent/diff/        UTF-8 파일 Diff, SQL 변경 주의 표시
agent/apply/       원본 해시 검사, 프로젝트 잠금, 백업·교체·복구
shared/            Agent 명령·프로젝트 설정 스키마
examples/          Express/EJS, React/Vite, Spring/Thymeleaf
scripts/           설정 생성, 로컬 등록 화면, 웹 자산 빌드
```

Hub는 소스 파일 경로나 실행 명령을 선택하지 않습니다. 사용자는 본인 PC에서 프로젝트와 명령을 등록합니다. Hub는 인증된 개발자의 Agent로 제한된 작업 명령만 전달합니다. 모든 프로젝트 파일 접근과 Codex 실행은 Agent에서 수행합니다.

## 준비

- Java 21, Maven 3.9+, Node.js 22 또는 24 LTS, npm
- macOS의 `/usr/bin/sandbox-exec`: 명령형 Preview의 외부 쓰기 차단에 사용합니다.
- 로컬에 설치하고 로그인한 Codex CLI. 개발 검증 버전은 `0.169.0`입니다.
- Chrome. 브라우저 테스트는 격리된 임시 Chrome 프로필을 사용합니다.

Codex CLI가 없다면 공식 [설치 안내](https://developers.openai.com/codex/cli)를 따르세요.

```sh
codex --version
codex login
codex login status
npm ci
npm run build
```

개인 ChatGPT/Codex 계정을 사용합니다. 별도 OpenAI API 키를 요구하지 않습니다. CLI 버전별 App Server 프로토콜 차이가 있을 수 있습니다. [App Server 공식 문서](https://developers.openai.com/codex/app-server)와 설치 버전의 `codex app-server generate-json-schema --out /tmp/codex-schema`로 확인하세요.

## 최초 설정과 실행

저장소 루트에서 한 번 실행합니다.

```sh
npm run setup
```

`.data/users.json`에 로컬 사용자 이름과 Agent 연결용 토큰을, `agent.config.json`에 PC 설정을 생성합니다. 기본 사용자 이름은 `developer`입니다. 두 파일은 Git에서 제외되며 기존 설정은 덮어쓰지 않습니다. 예제 프로젝트 세 개가 등록됩니다. 기존 설정 파일이 둘 다 있으면 그대로 사용하세요. 여러 사용자가 등록된 이전 설정에서는 Hub가 첫 번째 사용자로 열립니다.

### IntelliJ IDEA에서 실행

1. 저장소 루트를 열고 `hub/backend/pom.xml`을 우클릭해 **Add as Maven Project**를 선택합니다. **Project Structure → Project SDK**에서 Java 21을 지정합니다.
2. 프로젝트 루트에서 `npm run build`를 실행해 Agent와 웹 자산을 준비합니다. `agent/`나 `hub/frontend/`를 수정했다면 다시 실행합니다.
3. 실행 구성에서 **Hub**를 실행합니다. Maven 모듈 이름이 다르게 표시되면 **Run → Edit Configurations → Hub**에서 `hub/backend`의 Maven 모듈을 클래스패스로 선택합니다.
4. 실행 구성에서 **Agent**를 실행합니다. 이 구성은 IntelliJ의 npm 지원과 프로젝트 Node.js 인터프리터를 사용합니다. `package.json`의 `agent` 옆 실행 버튼이나 터미널의 `npm run agent`로도 실행할 수 있습니다.
5. [로컬 Hub](http://127.0.0.1:8080)를 엽니다.

### 터미널에서 실행

Hub 빌드:

```sh
mvn -f hub/backend/pom.xml package
```

터미널 1: **Hub는 backend 디렉터리에서 실행**합니다. 실행 중인 JAR을 빌드로 덮어쓰지 않도록 실행본을 분리합니다. 실행본을 다시 복사하기 전에는 Hub를 종료하세요.

```sh
cd hub/backend
mkdir -p ../../.data
cp target/visual-editor-hub-0.1.0.jar ../../.data/hub.jar
java -jar ../../.data/hub.jar
```

터미널 2: 저장소 루트에서 Agent를 실행합니다.

```sh
npm run agent
# 별도 설정 파일:
npm run agent -- /absolute/path/agent.config.json
```

[로컬 Hub](http://127.0.0.1:8080)에 접속하면 작업 화면이 바로 열립니다. Hub는 로컬 전용이며 같은 PC에서 접속할 수 있는 사용자는 작업 화면에 접근할 수 있습니다. Codex 수정에는 별도의 Codex CLI 로그인이 필요합니다.

`HUB_PORT`, `HUB_USERS_FILE`, `HUB_DATA_DIR` 환경 변수로 Hub 포트와 저장 위치를 바꿀 수 있습니다. 기본 파일 경로는 backend 디렉터리 기준입니다. 다른 디렉터리에서 Hub를 실행하면 두 파일 경로를 절대 경로로 지정하세요.

## 기존 프로젝트 등록

Agent를 종료한 뒤 로컬 등록 화면을 엽니다.

```sh
npm run register
# 출력되는 127.0.0.1의 임시 포트 주소를 본인 PC 브라우저에서 엽니다.
```

이름·절대 경로·프레임워크 탐지·빌드/시작 인자 배열·Preview 포트·준비 경로·테스트 환경 변수·제외 경로·갱신 방식을 입력합니다. 기존 등록을 수정하려면 **저장된 프로젝트**에서 이름을 선택하고 **변경사항 저장**을 누릅니다. 운영 연결이 없는 환경임을 확인한 뒤 저장하고 `npm run agent`로 다시 연결합니다. 등록 화면은 다른 Origin의 요청, 토큰 없는 저장, DNS rebinding용 Host를 거부합니다.

또는 `agent.config.json`의 `projects`를 편집합니다.

```json
{
  "id": "my-project",
  "name": "MY_PROJECT",
  "path": "/Users/me/work/MY_PROJECT",
  "runtime": "command",
  "pathPrefix": "root",
  "refresh": "reload",
  "buildCommand": ["npm", "ci", "--ignore-scripts"],
  "startCommand": ["node", "server.mjs"],
  "port": 18090,
  "readyPath": "/",
  "environment": {"APP_ENV": "preview"},
  "safePreview": true,
  "exclude": ["uploads", "config/private"]
}
```

- `runtime: static`은 작업본 루트의 `index.html`을 제공합니다. 빌드·시작 명령은 실행하지 않습니다.
- `runtime: command`는 등록한 배열을 셸 없이 실행합니다. `&&`, 파이프, `$VAR` 같은 셸 문법은 자동 해석하지 않습니다. Windows/Linux 명령형 실행은 격리 어댑터가 준비되지 않아 차단합니다.
- `PORT`, `HOST=127.0.0.1`, `AVE_PREVIEW_BASE`를 제공하지만 모든 서버가 이 값을 사용하는 것은 아닙니다. 실제 명령에도 필요한 포트/주소 옵션을 등록하세요. `safePreview` 확인은 운영 안전성을 자동 증명하지 않습니다.
- `refresh: reload`는 변경 후 페이지를 갱신합니다. `restart`는 Codex 완료 후 재빌드·재시작합니다. 빌드 실패 시 기존 프로세스를 유지합니다. 수동 재시작 버튼도 있습니다.
- Vite 예제는 `pathPrefix: task`와 `base: process.env.AVE_PREVIEW_BASE || '/'`를 함께 사용합니다. 자신의 기존 프로젝트에 설정 코드를 추가하지 않으려면 시작 명령 인자에 `"--base", "${AVE_PREVIEW_BASE}"`를 등록하세요. Agent가 이 정확한 인자만 현재 작업 경로로 치환합니다. 셸 변수나 일반 표현식은 평가하지 않습니다. 자동 탐지는 명령을 추측하거나 실행하지 않습니다.
- Spring 예제의 실행 명령은 `java -jar ... --server.address=127.0.0.1 --server.port=...`입니다. 실행 JAR을 작업 전용 위치로 복사해 재빌드 중 기존 JAR을 보존합니다.
- 정적·명령형 서버 모두 원본 대신 스냅샷에서 실행합니다. `node_modules`와 빌드 출력은 복사하지 않으므로 처음 실행할 때 의존성 설치가 필요합니다. 네트워크가 없는 환경에서는 별도 캐시/사내 저장소 설정이 필요합니다.

## 사용 흐름

1. 프로젝트 선택 → **새 작업 시작**. 현재 디스크 상태를 사본으로 만들므로 미커밋 변경도 포함됩니다.
2. Preview의 경로를 선택하고 **요소 선택**으로 클릭/드래그합니다. ESC는 선택을 해제합니다.
   **Preview 끄기 / 켜기**로 같은 작업 사본의 서버를 중지하거나 다시 시작할 수 있습니다. 같은 프로젝트의 활성 작업을 다른 탭에서 열려면 해당 프로젝트에서 **새 작업 시작**을 누릅니다.
   지원되는 로컬 명령형 프로젝트에서는 Preview에서 바로 로그인하고 폼·AJAX 동작을 확인할 수 있습니다. Preview 오른쪽 경계를 드래그하면 너비를, Diff·실행 로그 위쪽 경계를 드래그하면 높이를 조절할 수 있습니다.
3. Codex 채팅으로 수정 요청을 보냅니다. 추가 요청은 같은 App Server 스레드를 사용합니다. **작업 정지**는 turn interrupt를 요청합니다.
4. 작업 종료 후 Preview와 Diff를 확인합니다. Code/SQL/로그 탭, 패널 크기 조절, Preview·Diff 최대화를 제공합니다.
5. 파일 체크박스로 적용 대상을 선택하고 **선택 파일 적용하기 → 승인하고 적용**합니다. 검토한 리비전이 바뀌었거나 원본에 충돌이 있으면 중단합니다.
6. **이전 적용 복구**는 백업 상태로 되돌립니다. 적용 후 원본이 다시 바뀌었으면 복구도 중단합니다.
7. **작업 폐기**는 작업 사본만 삭제합니다.

Inspector는 DOM의 태그·위치·구조·구조 기반 selector·data 속성 **이름**만 수집합니다. 입력값, 텍스트, ID/class/data 값, 쿼리 문자열, 쿠키를 보내지 않습니다. 이 때문에 소스 탐색에 추가 설명이 필요할 수 있습니다. CSP를 강제로 해제하지 않으며, 선택 기능이 막히면 별도 Preview 탭과 수동 요소 입력을 사용합니다.

## 검증 명령

```sh
npm run build
npm run check
npm test
mvn -f hub/backend/pom.xml test

# Hub와 Agent를 실행한 뒤
npm run test:e2e
# 실제 개인 Codex 사용량을 사용하는 전체 수정·적용·복구 테스트
AVE_LIVE_CODEX=1 npm run test:e2e -- tests/workflow.spec.ts
```

테스트는 Express 예제 파일을 실제로 적용하고 복구합니다. 작업 전 예제 원본을 별도로 수정하지 마세요. 비정상 종료 시 작업 디렉터리의 백업과 적용 기록을 확인하세요. Chrome이 없으면 `npx playwright install chromium` 후 설정의 Chrome channel을 조정해야 합니다.

## 범위와 다음 단계

최우선은 검증된 단일 프로젝트 수정 흐름입니다. 이후 우선순위는 다음과 같습니다.

1. Windows/Linux 실행·파일 접근 격리, 더 엄격한 읽기 제한과 외부 효과 차단.
2. 작업·채팅 영속화 및 Agent 재시작 후 재개, 적용 중 프로세스 종료에 대한 자동 복구.
3. 프레임워크별 HMR WebSocket·인증·동적 URL 프록시, 외부 Tomcat/JSP 어댑터.
4. SQL dialect별 파서와 보수적 위험 분석, 사내 SSO·운영 감사/보존 정책.

Monaco는 파일 단위 적용을 제공합니다. Hunk 적용·SQL DB 실행·공개 초대·모바일·VPN·확장 프로그램·데스크톱 패키징·배포 연동은 구현하지 않습니다. 서버 렌더링 UI를 위해 Thymeleaf를 Hub에 넣을 필요가 없어 정적 UI를 사용하며, 예제 Spring 프로젝트에는 Thymeleaf를 사용합니다. SSE 대신 인증된 WebSocket RPC와 짧은 상태 폴링으로 채팅 이벤트를 전달합니다.

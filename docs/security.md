# 보안과 복구

## 신뢰 경계

- Hub는 IPv4 loopback에서 `127.0.0.1` 또는 `localhost`로 들어오는 브라우저 요청에 로컬 사용자로 작업 화면을 엽니다. 같은 PC에서 접속할 수 있는 사용자와 로컬 프로세스에 Hub 접근 권한이 있습니다. 상태 변경 요청에는 CSRF 토큰이 필요합니다.
- Agent 연결에는 사용자별 256-bit 토큰이 필요합니다. Hub는 현재 사용자가 소유한 작업에만 접근을 허용합니다. 이전 사용자 설정은 첫 번째 사용자로 열립니다.
- Hub의 명령은 프로젝트 목록·작업 생성·채팅·상태·Diff·Preview·정지·재시작·적용·폐기·복구로 제한됩니다. 프로젝트 경로·빌드 명령·실행 명령은 로컬 설정에서만 선택합니다.
- 등록 UI는 loopback 임시 포트에서만 열리고, Host·Origin·요청 토큰·JSON 형식을 검사합니다. 입력한 명령은 해당 PC 사용자가 신뢰하고 등록하는 설정입니다. 임의 프로젝트를 악성 코드의 안전한 분석 도구처럼 실행하면 안 됩니다.
- Codex는 작업별 `CODEX_HOME`에 기존 `auth.json`만 복사해 사용합니다. 개인 IDE의 MCP 서버·플러그인·추가 쓰기 경로를 가져오지 않습니다. 인증 정보는 Hub에 보내지 않습니다. App Server 스레드는 ephemeral이며 workspace-write, 외부 네트워크 차단, 추가 writableRoots 없음, 공용 tmp 쓰기 제외를 지정합니다. 권한 확대 요청은 거절하고 채팅에 표시합니다. 관리형 계정 등 `auth.json` 외 인증 방식은 미검증입니다.
- 작업 디렉터리 지정만으로 격리했다고 간주하지 않습니다. Codex의 OS 샌드박스와 macOS Preview 프로세스의 Seatbelt 정책을 사용합니다. 원본·백업·다른 작업은 Preview/빌드 쓰기 허용 경로에 포함하지 않습니다. 실제 빌드가 원본에 쓰려고 할 때 차단되는 테스트가 있습니다.
- 명령형 Preview는 macOS에서만 실행합니다. 다른 OS에서 조용히 샌드박스를 생략하지 않습니다. 정적 서버는 Node.js 구현이나 Windows 실기기 검증은 하지 않았습니다.

## Preview와 개인정보

기본 Preview는 HTTP GET 응답만 중계합니다. 작업마다 생성한 불투명한 256-bit capability가 해당 Preview 경로에 포함됩니다. iframe과 응답 CSP 모두 `sandbox allow-scripts allow-forms`를 적용해 프로젝트 코드의 Hub 세션 접근을 차단합니다. 기본 Preview를 별도 탭에서 열어도 동일한 sandbox가 적용됩니다. 응답은 no-store·no-referrer로 제공하고 capability는 실행 로그·DOM 첨부에서 제거합니다. 파일 적용·폐기 후 capability를 폐기합니다.

Preview URL은 접근 권한 자체이므로 공유하지 마세요. 공개 초대 링크 기능은 없습니다. capability는 Hub 메타데이터에만 저장하며 파일 권한을 제한합니다. 활성 작업 URL의 별도 시간 만료·유출 회수 UI는 아직 없습니다. Hub를 공개 서비스로 운영하기 전 Preview 전용 Origin과 짧은 TTL의 토큰 교환을 추가하는 것이 좋습니다.

기본 Preview는 기존 CSP와 X-Frame-Options를 유지하며, HTML의 root-relative src/href/action과 Vite task-base를 처리합니다.

로컬 명령형 프로젝트 중 기본 경로 접두사를 쓰는 작업은 작업별 `.localhost` 주소의 독립된 iframe에서 자동으로 열립니다. 앱의 폼, AJAX, 쿠키와 리디렉션은 로컬 Agent를 통해 작업 사본으로 전달됩니다. 앱 세션 쿠키는 작업 주소와 Hub의 최상위 사이트에 한정해 저장합니다. Hub에는 요소 선택 구조만 전달되며, 앱이 세션 정보를 로그에 남길 수 있어 이 iframe을 연 작업의 앱 출력은 이후 Hub에 수집하지 않습니다. 앱의 CSP와 Preview 프로세스의 네트워크 격리는 그대로 적용됩니다. 외부 주소를 전제로 한 인증 흐름, WebSocket, 브라우저에 하드코딩된 절대 서버 URL은 지원 범위 밖입니다.

Inspector는 태그·구조 기반 selector·data 속성 이름·위치·크기·제한된 하위 구조만 전송합니다. 텍스트·입력값·ID/class/data 값·쿠키·쿼리 문자열은 수집하지 않습니다. 사용자 수동 설명이나 요청에 직접 입력한 개인정보까지 자동 판별하지는 않습니다.

`.git`, 의존성·빌드 출력, `.env*`, 인증/비밀 파일명, 개인 SSH/AWS/Codex 설정, `application*.properties/yml/yaml`, `.npmrc`, `.netrc`, `settings.xml`, 키·인증서는 기본 복사·적용 대상에서 제외합니다. 추가 제외 경로를 로컬 설정에 넣을 수 있습니다. 파일명 기반 제외와 로그 정규식 마스킹은 완전한 비밀 탐지기가 아닙니다. 일반 소스에 하드코딩된 비밀값은 사전에 제거해야 합니다.

## 운영 시스템 연결

Preview 명령은 작업본 안에서만 파일을 쓸 수 있고 loopback 연결만 허용합니다. 그러나 로컬 DB·메일·결제 프록시도 loopback에 있을 수 있습니다. `safePreview: true`를 선택하기 전에 실제 운영 자격증명과 주소가 없는지 확인해야 합니다. 등록된 테스트 환경 변수만 자식에 전달하며 전체 셸 환경을 상속하지 않습니다. Java는 IPv4 바인딩을 사용합니다.

빌드 명령에는 의존성 다운로드를 위해 네트워크를 허용합니다. 쓰기는 작업본으로 제한하지만 빌드 스크립트의 네트워크 외부 효과를 자동 판단하지 않습니다. 안전한 프로젝트와 테스트 설정만 등록하세요. npm 예제는 install lifecycle scripts를 생략합니다. 네이티브 모듈을 포함하는 프로젝트는 별도 로컬 빌드 설정이 필요합니다.

현재 Codex 읽기 정책은 사용 중인 CLI의 workspace-write 구현에 의존합니다. 추가 쓰기는 막지만 시스템 기본 읽기 경로를 엄격하게 제한했다는 보장은 하지 않습니다. 조직 도입 전 OS 사용자/컨테이너 경계와 읽기 제한을 별도로 강화하세요. Codex 위험 권한 우회 옵션은 사용하지 않습니다.

## 적용과 복구

작업 시작 시 실제 디스크 내용을 복사합니다. HEAD나 Git 상태만으로 스냅샷을 만들지 않습니다. 적용 시 전체 비제외 원본 스냅샷이 일치해야 하며, 원본의 무관한 파일이 바뀌어도 보수적으로 충돌 처리합니다. Diff 전체의 SHA-256 리비전도 다시 검사합니다. 바이너리·2MB 초과·UTF-8 이외 변경·심볼릭 링크·경로 탈출은 적용하지 않습니다.

승인 후 원본 루트에 `.ave-apply-lock` 디렉터리를 만들어 동일 경로의 여러 Agent 사이에서도 적용을 직렬화하고 완료 시 제거합니다. 이 잠금은 소스 파일이나 SDK가 아니며 승인 전에는 생성하지 않습니다. 파일별 기존 내용을 백업한 뒤 같은 디렉터리의 임시 파일에서 rename합니다. 기존 파일 모드를 유지하고, 신규 파일·삭제를 명시적으로 기록합니다. Git과 DB는 건드리지 않습니다.

기록 위치:

```text
<dataDir>/workspaces/<taskId>/task.json
<dataDir>/workspaces/<taskId>/apply.json
<dataDir>/workspaces/<taskId>/backup/<relative file>
```

`apply.json`의 상태는 prepared / applied / rolled-back / recovery-required / restoring / restored입니다. 일반 쓰기 실패 시 이미 적용한 파일을 역순 복구합니다. 그 사이 사용자가 다시 바꾼 파일은 자동 복구로 덮어쓰지 않습니다. 정상 적용 후 UI의 복구 버튼도 현재 원본 해시가 적용 직후와 같을 때만 동작합니다.

여러 파일 전체에 대한 단일 파일시스템 트랜잭션이나 전원 장애 복구는 아닙니다. Agent 강제 종료·전원 장애로 prepared/restoring 상태가 남으면:

1. Hub·Agent·해당 프로젝트 서버가 실제로 종료됐는지 확인합니다.
2. `apply.json`의 파일별 beforeHash/afterHash와 현재 파일 SHA-256을 비교합니다.
3. afterHash와 같은 파일만 backup으로 복구합니다. beforeHash가 null이면 이번에 만든 파일입니다. 사용자가 추가로 바꾼 파일은 수동 병합합니다.
4. 원본의 `.ave-apply-lock`은 다른 적용이 없음을 확인한 뒤 제거합니다. 잠금을 자동 만료시켜 실행 중인 적용을 덮치지 않습니다.
5. Agent 데이터의 `agent.lock/pid` 프로세스가 종료됐음을 확인한 후 해당 잠금 디렉터리를 제거하고 Agent를 재시작합니다.

Agent 재시작 후 작업 컨텍스트를 자동 재개하지 않습니다. 기록과 백업은 남으므로 수동 복구할 수 있습니다. Hub 소유권 메타데이터는 영속화하므로 Agent가 계속 실행 중이면 Hub만 재시작한 뒤 작업을 이어갈 수 있습니다. 채팅은 메모리에 제한된 최근 이벤트만 유지합니다. 백업 보존 기간·암호화·안전한 삭제 정책은 조직에서 정해야 합니다.

## 사내 도입 전 확인

개인 계정의 Codex 사용 권한·모델 이용 한도, [OpenAI 이용 조건](https://openai.com/policies/terms-of-use/), [업무용 이용 조건](https://openai.com/policies/business-terms/), 회사 AI/소스 반출 정책을 담당자가 확인해야 합니다. Plus/Pro 같은 플랜명만으로 조직 사용·소스 전송 허용 여부를 단정하지 않습니다. 타인의 Codex 인증을 공유하지 않습니다.

현재 Hub는 로컬 개발 환경 전용입니다. 원격 운영에는 사용자 인증, HTTPS/WSS, Agent 토큰 발급·회수, 접근 제한, 감사·로그 보존, 의존성 점검을 별도로 설계해야 합니다.

# Tool3D: 절삭공구 2D 사진 → 3D 모델 + 마모 측정

HTML/JS 파일 하나(`www/index.html`, 외부 라이브러리 없음)로 만들었고, 같은 코드를 APK(Capacitor)와 EXE(Electron)로 포장합니다.

## 사용 흐름
1. **공구 정보**: 날 수(2~6), 공구경(4~12 φ)을 고릅니다.
2. **촬영 / 불러오기**: 날 수만큼 공구를 돌려 가며 측면을 찍고, 마지막에 윗면(끝면)을 찍습니다. 팁이 위로 가게 두고 노란 보조선에 외곽을 맞춥니다.
3. **3D 화**
   - Align 자동 보정: 사진마다 기울기, 배율(px/mm), 위치, 팁을 검출해 정규화합니다.
   - 마모 영역 붉은색 표시: 밝게 드러난 부분(코팅 벗겨짐)과 실루엣 결손(치핑)을 표시합니다.
   - 수치: 마모 면적(mm²), 결손 깊이(mm), 추정 마모 체적(mm³, 면적 × 평균 결손 깊이)
   - 저장: STL(mm, z축 = 공구축, 팁 z = 0), 텍스처 PNG, 결과 JSON

## 빌드
- **자동(권장)**: `.github/workflows/build.yml`이 `main` push, PR, 수동 실행(workflow_dispatch) 때 APK와 EXE를 빌드합니다. 결과물은 Actions 실행 화면의 **Artifacts**에서 `Tool3D-apk`(디버그 APK), `Tool3D-exe`로 받습니다.
- **로컬 APK**: JDK 17과 Android SDK(Android Studio)를 설치하고 `JAVA_HOME`, `ANDROID_HOME`을 지정합니다. `npm install` → `npm run apk`를 실행하면 `dist/Tool3D-debug.apk`가 생깁니다. 도구가 없으면 무엇이 빠졌는지 알려 주고 멈춥니다.
- **로컬 EXE**: Node 20을 설치한 뒤 `npm install` → `npm run exe`를 실행합니다. `dist/`에 포터블 exe가 생깁니다.
- **로컬 실행**: `npm start`로 Electron을 실행하거나, `www/index.html`을 Chrome에서 엽니다.
- `android/`는 저장소에 포함되어 있습니다(CAMERA 권한 포함). `www/`를 고친 뒤에는 `npm run apk`가 자동으로 `cap sync`를 합니다.

## 촬영 팁 (정확도에 가장 큰 영향)
- 공구와 대비되는 **단색 배경**을 씁니다. 어두운 공구라면 밝은 무광 종이가 좋습니다.
- 반사를 줄이도록 **확산광**에서 찍습니다.
- 휴대폰을 공구 축과 수직으로 두고, 되도록 조금 떨어져서 줌으로 찍습니다. 원근 왜곡이 줄어듭니다.
- 손가락은 공구 아래쪽만 잡습니다. 날 부위를 가리지 않게 합니다.

## 한계 (v0.1)
- 심압, 칩 포켓 형상은 날 수별 기본값을 씁니다. 사진으로는 측정할 수 없습니다.
- 헬릭스각과 날 위상은 사진에서 추정합니다.
- 마모 체적은 추정치입니다.
- Android 앱에서 저장 버튼을 누르면 공유 시트가 열립니다. 파일, Drive, 메신저 등으로 보내 저장합니다(`www/native/android-save.js`).
- 실제 공구 원본 사진으로 임계값 튜닝이 더 필요합니다.

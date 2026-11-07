# Native Mobile (Android / iOS) — Build & Operations Report

**Scope:** Capacitor 8 shell around the existing FacilityPro web app, plus the
server-side changes needed for native push, camera/gallery, deep links and
session teardown. The web app remains the single implementation; native adds a
bridge, it does not fork the UI.

**App identity:** `FacilityPro by MOHD.HMS ENTERPRISE`
**App ID / bundle ID:** `com.mohdhms.facilitypro`
**Default server URL:** `https://app.mohdhms.com` (override at build time with
`CAPACITOR_SERVER_URL`; debug-only WebView debugging with `CAPACITOR_DEBUG=1`).

---

## 1. What ships

| Area | Behaviour |
|---|---|
| Shell | `server.url` loads the production web app, so deploys reach installed apps without an app-store update. `mobile/www` is a branded offline fallback only. |
| Deep links | `facilitypro://open/<route>` always works. `https://app.mohdhms.com/<route>` App Links work once `assetlinks.json` is published (see §5). Paths are sanitised by `src/lib/hms/native/deep-link.ts`. |
| Camera / gallery | Native camera and multi-select gallery feed the existing `PhotoUploader`; the browser path is untouched. `src/lib/hms/native/media.ts`. |
| Push (Android/web) | Firebase FCM. Web stays data-only for `/sw.js`; Android gets a notification block + `facilitypro_default` channel. |
| Push (iOS) | APNs directly. Capacitor returns an **APNs device token**, never an FCM token, so iOS is delivered through Apple's HTTP/2 API (`src/lib/hms/push/apns.ts`) and is never sent to FCM. |
| Session | Sign-out unregisters the native token locally + server-side before clearing the cookie. |
| Lifecycle | Splash/status bar, network online/offline events, resume → push re-init + realtime resync + notification refresh. |

No new UI, state store, router, or notification system was introduced.

## 2. Build the Android app

Local toolchain used for verification (no system installs):

```bash
export JAVA_HOME=/home/hasan/.local/jdk
export ANDROID_HOME=/home/hasan/.local/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

cd /home/hasan/mohd_hms_enterprise
npx cap sync android
cd android && ./gradlew assembleDebug
```

Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk` (verified,
minSdk 24, target 36).

Release (signed AAB/APK):

1. Create the upload key once:

   ```bash
   keytool -genkeypair -v -keystore android/app/facilitypro-release.jks \
     -alias facilitypro -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Create `android/keystore.properties` (git-ignored):

   ```properties
   storeFile=facilitypro-release.jks
   storePassword=…
   keyAlias=facilitypro
   keyPassword=…
   ```

3. `cd android && ./gradlew bundleRelease` → `app/build/outputs/bundle/release/app-release.aab`.

`storeFile` is resolved relative to `android/app/`. Without
`keystore.properties` the release build is unsigned, never silently signed with
a debug key.

Regenerate icons/splashes after changing brand assets:

```bash
bun scripts/generate-native-assets.mjs
npx cap sync android && npx cap sync ios
```

## 3. Firebase (Android + web delivery)

1. Create a Firebase project and add an **Android** app with package
   `com.mohdhms.facilitypro`; download `google-services.json` to
   `android/app/google-services.json`.
2. Add a **Web** app; set `FIREBASE_CLIENT_*` + `FIREBASE_VAPID_KEY`.
3. Create a service account and set `FIREBASE_PROJECT_ID`,
   `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (or
   `FIREBASE_SERVICE_ACCOUNT` / `_PATH`).
4. `GET /api/v1/push/status` must report `fcm.configured = true`; device
   registration is rejected until it does.
5. Enable Settings → Automation → Push notifications.

## 4. APNs (iOS delivery)

Capacitor's iOS plugin emits the raw APNs device token. The server therefore
uses token-based APNs auth (`.p8`), configured only via env — no APNs key is
stored in the repo or the app:

| Variable | Meaning |
|---|---|
| `APNS_KEY_ID` | Key ID from Apple Developer → Keys |
| `APNS_TEAM_ID` | Apple Developer team ID |
| `APNS_KEY_PATH` **or** `APNS_KEY_P8` | Path to / inline contents of `AuthKey_<KEYID>.p8` |
| `APNS_TOPIC` | Bundle ID, default `com.mohdhms.facilitypro` |
| `APNS_ENV` | `production` (default) or `sandbox` for Xcode debug builds |

The `.p8` key must have the **Apple Push Notifications service** permission.
`GET /api/v1/push/status` now returns an `apns` block (`configured`,
`environment`, `topic`) for diagnostics.

Important: one server deployment targets one APNs environment. Xcode debug
builds use the sandbox; TestFlight/App Store use production. Run
`APNS_ENV=sandbox` on a staging server for debug-device testing.

Delivery behaviour:
- Invalid/unregistered tokens (`410`, `BadDeviceToken`, `DeviceTokenNotForTopic`)
  deactivate the device row, same policy as FCM.
- Timeouts/5xx/429 are transient and retried with the existing backoff.
- `PushLog.channel` records `FCM`, `APNs`, `FCM+APNs`, or `VAPID`.

## 5. Android App Links

Custom-scheme links work now. HTTPS links require a published association file
after the release key exists:

```bash
keytool -list -v -keystore android/app/facilitypro-release.jks -alias facilitypro | grep SHA256
```

Create `public/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.mohdhms.facilitypro",
    "sha256_cert_fingerprints": ["AA:BB:…"]
  }
}]
```

Deploy it over HTTPS at `https://app.mohdhms.com/.well-known/assetlinks.json`
with `Content-Type: application/json`. Until then the `autoVerify` intent filter
is inert and links open the browser.

## 6. Build iOS (requires macOS + Xcode)

1. `npx cap sync ios`
2. Open `ios/App/App.xcodeproj` (or the workspace) in Xcode.
3. Set the signing team; confirm bundle ID `com.mohdhms.facilitypro`.
4. Capabilities → **Push Notifications** (the `aps-environment` entitlement is
   already wired via `ios/App/App/App.entitlements`; Associated Domains
   `applinks:app.mohdhms.com` is also present).
5. Run on a **physical device** for a real APNs token (simulators do not
   provide one). Debug builds register sandbox tokens.
6. TestFlight/App Store builds register production tokens.

Not verified in this environment: no macOS/Xcode was available, so the iOS
project is source-configured but has not been compiled or device-tested.

## 7. Deployment order

1. Deploy the updated Next.js build to `https://app.mohdhms.com` (native bridge
   code, APNs transport, register/status changes).
2. Set Firebase env vars (Android/web) and APNs env vars (iOS) on the server.
3. Add `google-services.json`, build/sign the Android app.
4. Publish `assetlinks.json` after extracting the release SHA-256.
5. Install on devices; verify `/api/v1/push/status`, then send an admin test
   push from the app.

The APK loads the production origin, so an APK installed before step 1 will not
see the native bridge code.

## 8. Verification performed

| Check | Result |
|---|---|
| `bun src/lib/hms/native/deep-link.test.ts` | `native-deep-link: ok` |
| `bun src/lib/hms/push/fcm-message.test.ts` | `fcm-message: ok` |
| `bun src/lib/hms/push/apns.test.ts` (ES256 JWT + raw R\|\|S signature) | `apns-jwt: ok` |
| `npx tsc --noEmit` | No errors in any touched file (repo-wide pre-existing errors remain only in `scripts/*-qa.ts`) |
| ESLint on touched files | 0 errors, 1 pre-existing warning (`fcm.ts:192` stale disable) |
| `./gradlew assembleDebug` | BUILD SUCCESSFUL, APK ~12 MB |
| Full `next build` | Not run (dev server on :3050 would be disrupted) |

## 9. Known limitations / risks

- **iOS push untested against Apple** — the APNs transport and JWT are unit
  tested, but no APNs key/device was available. Validate with a sandbox build
  before store submission.
- **No physical-device validation** for camera, deep links, notification tap
  routing, or background resume.
- **Google OAuth in the WebView** may be rejected by Google
  (`disallowed_useragent`) if the login uses the full-page Google flow. If it
  occurs, move native Google sign-in to a system browser / Credential Manager
  flow; not implemented here.
- **Release keystore** is not created; signing is documented but not performed.
- **Asset links** not published, so HTTPS deep links do not auto-open yet.
- **stale server deployment**: the installed app always runs the deployed web
  bundle; keep the web and native contracts backward compatible.
- `android/app/build.gradle` keeps `minifyEnabled false` (Capacitor default) to
  avoid breaking WebView/plugin reflection; enable R8 only with a tested
  keep-rule set.

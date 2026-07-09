# Google Sign-In — setup guide

The code for "Continue with Google" is already wired up. It is **login-only**: Google
signs in people who **already have an account** (created via signup or an invite).
An unknown Google email is politely rejected — no organizations are auto-created.

To turn it on you need a Google OAuth **Client ID**. Follow the steps below.

---

## How it works (so the config makes sense)

1. The client gets a Google **ID token** — from Google's button on the web, or the
   native account picker on Android.
2. The client posts it to `POST /api/auth/google`.
3. The server verifies the token with Google, finds the user whose **email**
   matches, links their `google_id`, and returns our normal JWT session.

The **same Client ID** is used to render the web button (`VITE_GOOGLE_CLIENT_ID`)
and to verify the token on the server (`GOOGLE_CLIENT_ID`). They must match.

---

## Part 1 — Create the Web OAuth Client ID (required for web)

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **External**. Fill app name, support email, developer email.
   - While testing, either add your testers under **Test users**, or **Publish**
     the app so anyone can sign in. (Login-only means only existing accounts get
     in regardless.)
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorized JavaScript origins** — add every origin the web app is served from:
     - `http://localhost:5173` (Vite dev)
     - `http://localhost` (Capacitor Android WebView, if you ever test GIS there)
     - your production web origin, e.g. `https://app.befach.com`
   - Authorized redirect URIs: **leave empty** (we use the token flow, not redirect).
   - Create → copy the **Client ID** (looks like `1234-abc.apps.googleusercontent.com`).

### Configure the app with it

- **Server** — in `server/.env`:
  ```
  GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
  ```
- **Web client** — in `client/.env` (dev) and `client/.env.production` (build):
  ```
  VITE_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
  ```
- Restart the backend and rebuild/restart the client. The **Continue with Google**
  button appears on the login page automatically once the id is set.

That's all you need for **web**. Test: log in with a Google account whose email
already exists in the app → you're in. Try one that doesn't → "No account found…".

---

## Part 2 — Android (native) Google Sign-In

The web GIS button does **not** work reliably inside the Android WebView, so the
app uses a native plugin there. This needs a few extra one-time steps.

### 2a. Install the plugin

```bash
cd client
npm install @codetrix-studio/capacitor-google-auth
npx cap sync android
```

> If Gradle complains about compatibility with this Capacitor version, install the
> matching plugin version (check the plugin's README) or an actively-maintained
> alternative such as `@capgo/capacitor-social-login`. The app calls the plugin's
> `GoogleAuth.signIn()` and reads `authentication.idToken`; adapt
> `client/src/googleAuth.ts → nativeGoogleSignIn()` if you switch plugins.

### 2b. Create an Android OAuth Client ID

1. Get your signing certificate **SHA-1** fingerprint:
   ```bash
   # debug builds
   keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
   # release builds — use your release keystore (client/android/befach-release.jks)
   keytool -list -v -keystore client/android/befach-release.jks -alias <your-alias>
   ```
2. In Google Cloud Console → **Credentials → Create credentials → OAuth client ID**
   - Application type: **Android**
   - Package name: `io.smarttask.app` (matches `appId` in `capacitor.config.ts`)
   - SHA-1: paste the fingerprint from step 1 (add both debug and release).

You do **not** put the Android client id in code — Google links it to your app by
package name + SHA-1. But the **ID token** it issues carries the Android client id
in its `aud` claim, so tell the server to accept it:

- **Server** `server/.env`:
  ```
  GOOGLE_CLIENT_IDS_EXTRA=YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com
  ```
  (comma-separate if you add iOS later.)

### 2c. Point the plugin at your WEB client id

The native plugin authenticates the user on-device but must request the **web**
client id as its `serverClientId` so the returned ID token is verifiable by the
server. In `client/capacitor.config.ts`, uncomment the `plugins.GoogleAuth` block
and set:

```ts
plugins: {
  GoogleAuth: {
    scopes: ['profile', 'email'],
    serverClientId: 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
    forceCodeForRefreshToken: false,
  },
},
```

Then re-sync and rebuild:

```bash
npx cap sync android
npx cap open android   # build & run from Android Studio
```

---

## Environment variable reference

| Variable                  | Where                | Value                                            |
|---------------------------|----------------------|--------------------------------------------------|
| `GOOGLE_CLIENT_ID`        | `server/.env`        | Web client id (verifies tokens)                  |
| `GOOGLE_CLIENT_IDS_EXTRA` | `server/.env`        | Android/iOS client id(s), comma-separated (mobile)|
| `VITE_GOOGLE_CLIENT_ID`   | `client/.env*`       | Web client id (renders the button)               |
| `serverClientId`          | `capacitor.config.ts`| Web client id (native plugin)                    |

## Troubleshooting

- **Button doesn't show (web):** `VITE_GOOGLE_CLIENT_ID` is empty or the client
  wasn't rebuilt after setting it.
- **`Google Sign-In is not configured on the server` (501):** set `GOOGLE_CLIENT_ID`
  in `server/.env` and restart the backend.
- **`Could not verify your Google sign-in` (401):** the token's `aud` isn't in the
  accepted list — the web id doesn't match, or (mobile) the Android id isn't in
  `GOOGLE_CLIENT_IDS_EXTRA`.
- **`No account found for this Google email` (404):** expected — this is login-only.
  Create the account via signup/invite first (must use the same email as Google).

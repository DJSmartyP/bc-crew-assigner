# Setup guide — Bridge Command Crew Planner

This project uses **GitHub Pages + one separate Firebase project**. No paid server is required for the expected usage.

## 1. Create the Firebase project

1. Go to the Firebase Console.
2. Create a new project for this reusable crew planner.
3. Add a **Web app** using the `</>` button.
4. Do not enable Firebase Hosting; GitHub Pages will host the site.
5. In the web-app setup screen choose **Config** and copy the `firebaseConfig` values.

## 2. Put the Firebase config into the repo

Open `firebase-config.js` and replace every `PASTE_...` value with the values Firebase gives you.

Do not use the npm example. This project loads Firebase directly in the browser.

## 3. Enable Authentication

In Firebase Authentication, enable:

- **Email/Password** — for Admin and Organisers.
- **Anonymous** — for Players opening invite links.

## 4. Create Firestore

Create a Firestore database using the default database ID. A UK/European location is sensible if most users are in the UK.

## 5. Create the Admin account

In Firebase Authentication → Users:

1. Add your Admin email/password account.
2. Copy its **User UID**.
3. Paste that UID into `firebase-config.js` as `ADMIN_UID`.
4. Open `firestore.rules` and replace `PASTE_ADMIN_UID` with the same UID.
5. Publish the rules in Firestore → Rules.

The Admin account does not need an organiser profile document. The UID itself grants Admin access.

## 6. Publish the site

In GitHub repo settings:

1. Settings → Pages.
2. Source: **Deploy from a branch**.
3. Branch: **main**.
4. Folder: **/(root)**.
5. Save.

The normal site address will be approximately:

`https://djsmartyp.github.io/bc-crew-assigner/`

The Admin login can be opened with:

`https://djsmartyp.github.io/bc-crew-assigner/?admin=1`

## 7. Test in this order

1. Sign in using the Admin address.
2. Open the normal site in another/incognito browser and create an Organiser account.
3. Create a one-ship test mission.
4. Copy its player link.
5. Open the player link and submit a test preference.
6. Return to the Organiser dashboard and confirm the response appears.
7. Test a fixed station override.
8. Delete the test mission from Admin when finished.

## Player editing rule

A player's own entry can be reopened only from the same browser/device used to create it. Shared devices can register multiple people; each person's Firebase identity is stored separately in that browser.

If a player changes device, an Organiser or Admin can edit the response for them.

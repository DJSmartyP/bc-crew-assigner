# Setup guide — Interstellar Deployment Planner

This project uses **GitHub Pages + Firebase Authentication + Firestore**. It is separate from the Sarah crew tracker.

## 1. Firebase project

Project already configured in this build:

- Project ID: `bc-crew-autoassigner`
- GitHub Pages site: `https://djsmartyp.github.io/bc-crew-assigner/`
- Admin UID: already inserted into both `firebase-config.js` and `firestore.rules`

Do not copy Firebase's npm `import` example into this project. The site loads the browser SDK itself.

## 2. Authentication methods

In Firebase Console → **Security → Authentication → Sign-in method** enable:

- **Email/Password** — kept for the single Admin account.
- **Email link (passwordless sign-in)** — used by Organisers.
- **Anonymous** — used behind the scenes for Players opening mission links.

Organisers do not create passwords. They enter an email address on the site, receive a Firebase sign-in email, and click the link.

## 3. Authorised domain

In Firebase Console → **Security → Authentication → Settings → Authorized domains**, add:

`djsmartyp.github.io`

Do not include `https://` or `/bc-crew-assigner/`.

## 4. Admin account

The Admin account should exist in Firebase Authentication as an Email/Password user.

This build is locked to Admin UID:

`tG8hNmlYRSd9RBiHe6WUEWFeZ173`

Admin login URL:

`https://djsmartyp.github.io/bc-crew-assigner/`

Do not share the Admin password.

## 5. Firestore database and rules

Create a Firestore database using the default database ID if you have not already done so.

Then open Firebase Console → **Firestore Database → Rules** and replace the rules there with the complete contents of `firestore.rules` from this package, then click **Publish**.

The rules enforce:

- Admin UID → global access to all missions and organiser profiles.
- Organiser → access to the missions they own.
- Player → can create/update their own mission response; organiser/admin can manage it for them.

The organiser profile can be created only for an authenticated account with a verified email. Firebase email-link sign-in verifies the email during sign-in.

## 6. Publish the website

Upload all project files to the root of `DJSmartyP/bc-crew-assigner` on the `main` branch.

Then in GitHub:

1. **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**
4. Folder: **/(root)**
5. Save

Normal organiser URL:

`https://djsmartyp.github.io/bc-crew-assigner/`

Admin URL:

`https://djsmartyp.github.io/bc-crew-assigner/`

## 7. Test organiser magic-link sign-in

1. Open the normal site.
2. Enter a non-admin email address.
3. Click **Send sign-in link**.
4. Open the Firebase email and click its link.
5. The site should return to **My missions** automatically.
6. If the link is opened on a different browser/device, the site asks for the same email address again before completing sign-in.
7. Create a one-ship test mission and copy its player link.

## 8. Test the three user levels

### Admin

- Open the main site and use the **Admin sign in** panel.
- Sign in with the Admin email/password account.
- Confirm **All missions** is visible.

### Organiser

- Sign in using an email link.
- Create a mission.
- Add/edit a player manually.
- Test a fixed station override.
- Close and reopen player choices.

### Player

- Open the organiser's mission link.
- Submit three ranked station preferences.
- Confirm the crew suggestion appears.
- Confirm another browser cannot edit that player's entry merely by typing the same name.

## Player editing rule

A player's own entry can be reopened only from the same browser/device used to create it. Shared devices can register multiple people; each person's Firebase anonymous identity is stored separately in that browser.

If a player changes device, the Organiser or Admin can edit the response for them.

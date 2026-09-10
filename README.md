# Interstellar Deployment Planner

Reusable multi-mission crew preference and assignment planner for Interstellar-style events.

## User levels

- **Admin** — one global administrator account; can see and manage every mission.
- **Organiser** — passwordless email-link account; creates and manages only their own missions and responses.
- **Player** — opens a mission invite link, submits preferences without creating an account, and sees the current suggested crew.

## Player links

New deployments generate a readable player link from the mission name, for example `?join=saturday-evening-crew`. Organisers can edit the generated link name before saving. Link names are unique across the planner, use lowercase letters, numbers and hyphens, and are stored in the `inviteLinks` Firestore collection.

Existing `?m=DOCUMENT_ID` links continue to work. Renaming a mission does not silently change an existing custom link, so links that have already been shared remain valid.

## Standard station template

- **Command:** Captain
- **Operations:** Helm, Beams, Missiles
- **Science:** Nav, Radar, Comms
- **Engineering:** Engineering, Manual engineer, Dock and drone
- **Shuttle:** XO, Shuttle helm, Shuttle generalist, Shuttle engineer

## Staffing rules per ship

- **1–9 crew:** the 9 core main-ship stations are available. Dock and drone and shuttle are not used by default.
- **10 crew:** all 10 main-ship stations are available, including Dock and drone.
- **11–14 crew:** all 14 stations are available. Any combination may be used and unfilled stations remain **To be decided**.
- Organiser/Admin fixed assignments can override those defaults.

## Allocation behaviour

The suggested crew is recalculated from the complete current preference set whenever data changes. It does not permanently claim a station when somebody submits.

Station preference is prioritised ahead of ship preference. Matching role choices are spread across ships where possible. When two otherwise equivalent claims remain, the earlier preference time wins.

## Unavailable station locks

Organisers and administrators can mark an individual station on a specific ship as unavailable while creating or editing a deployment. Each lock can include an optional name or short message, such as `Console offline` or `Reserved for GM`.

Locked stations remain visible in the live crew plan and PDF, but are excluded from automatic and fixed assignments until an organiser or administrator unlocks them. A lock on one ship does not close the matching station on another ship.

## Authentication

- Admin: Firebase Email/Password.
- Organisers: Firebase Email Link (passwordless).
- Players: Firebase Anonymous Authentication behind the scenes.

See `SETUP-GUIDE.md` for setup and publishing instructions.


## Sign-in

The normal homepage now contains both organiser magic-link sign-in and administrator email/password sign-in. Admin access is enforced by Firebase Authentication plus the configured Admin UID and Firestore rules; it does not rely on a hidden URL.

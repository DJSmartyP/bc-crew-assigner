# Bridge Command Crew Planner

Reusable multi-mission crew preference and assignment planner for Bridge Command-style events.

## User levels

- **Admin** — one global administrator account; can see and manage every mission.
- **Organiser** — passwordless email-link account; creates and manages only their own missions and responses.
- **Player** — opens a mission invite link, submits preferences without creating an account, and sees the current suggested crew.

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

## Authentication

- Admin: Firebase Email/Password.
- Organisers: Firebase Email Link (passwordless).
- Players: Firebase Anonymous Authentication behind the scenes.

See `SETUP-GUIDE.md` for setup and publishing instructions.


## Sign-in

The normal homepage now contains both organiser magic-link sign-in and administrator email/password sign-in. Admin access is enforced by Firebase Authentication plus the configured Admin UID and Firestore rules; it does not rely on a hidden URL.

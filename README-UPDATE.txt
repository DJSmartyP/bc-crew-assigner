IDP — ORGANISER DELETE DEPLOYMENT UPDATE

Replace the existing app.js in the main deployment-based IDP site with the supplied app.js.

Changes:
- Organisers now see a Delete button on deployments they own.
- Delete requires confirmation: "Delete this deployment and all player responses? This cannot be undone."
- The delete cascade removes player responses, name-claim records, and the deployment document.
- After deletion, organisers return to My deployments; admins return to the admin dashboard.
- Admin delete/transfer behaviour is unchanged.

No Firestore rules update is required: the current rules already allow an organiser to delete only a mission they own.

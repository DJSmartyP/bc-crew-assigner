const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8");

test("shared rules retain the main IDP collections", () => {
  assert.match(rules, /match \/profiles\/\{uid\}/);
  assert.match(rules, /match \/inviteLinks\/\{slug\}/);
  assert.match(rules, /match \/missions\/\{missionId\}/);
  assert.match(rules, /allow list: if isAdmin\(\) \|\| ownsMission\(missionId\);/);
  assert.match(rules, /function validClaimShape\(\)/);
});

test("shared rules retain the UFN collections", () => {
  assert.match(rules, /match \/ufnCampaignDirectory\/\{crewSlug\}/);
  assert.match(rules, /match \/ufnCampaignCrews\/\{crewSlug\}/);
  assert.match(rules, /match \/ufnDeployments\/\{deploymentId\}/);
  assert.match(rules, /function isCampaignCrewAuth\(crewSlug\)/);
  assert.match(rules, /function campaignOwnsUfnDeployment\(deploymentId\)/);
});

test("UFN organiser access remains campaign-scoped", () => {
  assert.match(rules, /request\.resource\.data\.campaignCrew is string/);
  assert.match(rules, /isCampaignCrewAuth\(request\.resource\.data\.campaignCrew\)/);
  assert.doesNotMatch(
    rules.match(/match \/ufnDeployments\/\{deploymentId\}[\s\S]*$/)?.[0] || "",
    /isOrganiser\(\)/
  );
});

test("UFN player writes remain identity-scoped", () => {
  assert.match(rules, /function validUfnPlayerShape\(\)/);
  assert.match(rules, /request\.auth\.uid == playerId[\s\S]*validUfnPlayerShape\(\)/);
  assert.match(rules, /resource\.data\.playerId == request\.auth\.uid/);
  assert.match(rules, /allow list: if isAdmin\(\) \|\| campaignOwnsUfnDeployment\(deploymentId\);/);
  assert.match(rules, /!exists\([\s\S]*players\/\$\(request\.auth\.uid\)\)/);
  assert.match(rules, /existsAfter\([\s\S]*players\/\$\(request\.auth\.uid\)\)/);
});

test("rules remain one complete Firestore service", () => {
  assert.equal((rules.match(/rules_version\s*=/g) || []).length, 1);
  assert.equal((rules.match(/service cloud\.firestore/g) || []).length, 1);
  assert.equal((rules.match(/\{/g) || []).length, (rules.match(/\}/g) || []).length);
});
